import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

process.env.NODE_ENV = 'test';
process.env.DEMO_PASSWORD = 'test-only-password';
process.env.GEMINI_API_KEY = '';
process.env.LIMIT_STORE = 'memory';
process.env.LOG_LEVEL = 'silent';
const { buildAgentDecision, createHelpdeskAgent } = await import('../services/geminiAgent.js');
const { createKnowledgeRetriever } = await import('../services/knowledgeService.js');
const { createChatTasks } = await import('../services/chatTasks.js');
const { createChatHandler } = await import('../controllers/agentController.js');
const { drainServer } = await import('../utils/shutdown.js');
const { loadEnv } = await import('../config/env.js');
const { createMemoryLimitStore } = await import('../services/limitStore.js');
const { createUsageService } = await import('../services/usageService.js');
const auto = { intent: 'IT_SUPPORT', confidence_score: 80, action_route: 'AUTO_REPLY', reply_text: '測試', ticket_payload: null };

/** 驗證四種分類會覆寫模型捏造或錯配的部門。@returns {void} */
function fixedDepartments() {
  const expected = { IT_SUPPORT: 'IT資訊服務台', HR_POLICY: 'HR人力資源部', HARDWARE_FACILITY: '總務與硬體組', UNKNOWN: 'IT資訊服務台' };
  for (const [intent, department] of Object.entries(expected)) {
    for (const modelDepartment of ['未定義部門', 'IT資訊服務台', 'HR人力資源部']) {
      const result = buildAgentDecision({ ...auto, intent, confidence_score: 20, action_route: 'ESCALATE_TICKET',
        ticket_payload: { ticket_id: 'fake', level: 'P2_HIGH', department: modelDepartment, action_required: '人工確認' } }, [], '一般問題');
      assert.equal(result.ticket_payload.department, department);
    }
  }
}
test('工單部門一律依最終 intent 映射', fixedDepartments);

/** 確認缺少金鑰或檢索故障都不影響明確危險的本地保守轉派。@returns {Promise<void>} */
async function emergencyWithoutUpstream() {
  /** 禁止本地危險規則呼叫 SDK。@returns {never} @throws {Error} 意外的上游呼叫。 */
  function getAI() { throw new Error('must not initialize upstream'); }
  /** 禁止本地危險規則檢索文件。@returns {Promise<never>} @throws {Error} 意外的檢索。 */
  async function retrieve() { throw new Error('must not retrieve'); }
  const result = await createHelpdeskAgent({ getAI, retrieve })('設備冒煙了');
  assert.equal(result.intent, 'HARDWARE_FACILITY');
  assert.equal(result.confidence_score, 0);
  assert.deepEqual(result.retrieved_sources, []);
  assert.equal(result.ticket_payload.level, 'P1_URGENT');
  assert.equal(result.ticket_payload.department, '總務與硬體組');
}
test('明確危險訊息不依賴 Gemini 可用性', emergencyWithoutUpstream);

/** 驗證檢索超時會取消等待，晚到的檢索結果不會再啟動推理。@returns {Promise<void>} */
async function retrievalDeadline() {
  let signal;
  let complete;
  let generated = false;
  /** 建立可控制的檢索結果。@param {Function} resolve 完成函式。@returns {void} */
  function pending(resolve) { complete = resolve; }
  const waiting = new Promise(pending);
  /** 模擬不理會取消訊號的檢索，以確認外層期限仍生效。@param {string} message 問題。@param {object} ai SDK。@param {object} options 訊號。@returns {Promise<object[]>} 延遲結果。 */
  async function retrieve(message, ai, options) { signal = options.signal; return waiting; }
  /** 記錄是否不當啟動下一階段。@returns {Promise<object>} 模型結果。 */
  async function generateContent() { generated = true; return { text: JSON.stringify(auto) }; }
  /** 取得替身 SDK。@returns {object} SDK。 */
  function getAI() { return { models: { generateContent } }; }
  const run = createHelpdeskAgent({ getAI, retrieve, timeoutMs: 20 });
  await assert.rejects(run('一般問題'), { status: 500, code: 'SERVER_ERROR', agentTimeout: true });
  assert.equal(signal.aborted, true);
  complete([]);
  await delay(0);
  assert.equal(generated, false);
}
test('總期限取消檢索等待且不啟動晚到的推理', retrievalDeadline);

/** 驗證推理 SDK 收到總期限訊號，且成功呼叫的計時器會清除。@returns {Promise<void>} */
async function generationDeadline() {
  let signal;
  /** 提供快速檢索。@returns {Promise<object[]>} 空來源。 */
  async function retrieve() { return []; }
  /** 模擬永不完成的模型，外層期限必須結束等待。@param {object} request SDK 請求。@returns {Promise<never>} 未完成結果。 */
  async function generateContent(request) {
    signal = request.config.abortSignal;
    /** 保持未完成，模擬上游沒有回覆。@returns {void} */
    function pending() {}
    return new Promise(pending);
  }
  /** 提供替身 SDK。@returns {object} SDK。 */
  function getAI() { return { models: { generateContent } }; }
  await assert.rejects(createHelpdeskAgent({ getAI, retrieve, timeoutMs: 20 })('一般問題'), { agentTimeout: true });
  assert.equal(signal.aborted, true);
}
test('總期限會傳遞取消訊號至推理 SDK', generationDeadline);

/** 驗證一人取消不破壞共用索引，也不替已取消的使用者建立查詢向量。@returns {Promise<void>} */
async function sharedIndexCancellation() {
  let complete;
  let queries = 0;
  /** 保存文件索引完成函式。@param {Function} resolve 完成。@returns {void} */
  function pending(resolve) { complete = resolve; }
  const waiting = new Promise(pending);
  /** 模擬共用索引與查詢。@param {object} request 向量請求。@returns {Promise<object>} 向量。 */
  async function embedContent(request) {
    if (request.config.taskType === 'RETRIEVAL_DOCUMENT') {
      assert.equal(request.config.abortSignal, undefined);
      await waiting;
    } else { queries += 1; }
    return { embeddings: [{ values: [1, 0] }] };
  }
  const retrieve = createKnowledgeRetriever({ documents: [{ doc_name: 'test', content: 'test' }] });
  const ai = { models: { embedContent } };
  const controller = new AbortController();
  const cancelled = retrieve('first', ai, { signal: controller.signal });
  const surviving = retrieve('second', ai);
  controller.abort();
  complete();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal((await surviving).length, 1);
  assert.equal(queries, 1);
}
test('單一請求取消不破壞共用文件索引', sharedIndexCancellation);

/** 驗證關機等待 HTTP 關閉後仍未完成的清理，並禁止新工作。@returns {Promise<void>} */
async function gracefulDrain() {
  const tasks = createChatTasks();
  let finish;
  let drained = false;
  /** 保存清理的完成控制。@param {Function} resolve 完成。@returns {void} */
  function pending(resolve) { finish = resolve; }
  const release = new Promise(pending);
  /** 模擬仍在釋放租約的請求。@returns {Promise<void>} 清理。 */
  async function work() { await release; }
  const active = tasks.run(work);
  /** 模擬 HTTP 連線已結束，不代表非同步清理已完成。@param {Function} callback 關閉通知。@returns {void} */
  function close(callback) { callback(); }
  /** 等待整個關機流程，記錄完成狀態。@returns {Promise<void>} 關機。 */
  async function drain() { await drainServer({ close }, tasks, 1000); drained = true; }
  const shutdown = drain();
  await assert.rejects(tasks.run(work), { status: 503, code: 'SERVICE_BUSY' });
  await delay(0);
  assert.equal(drained, false);
  finish();
  await Promise.all([active, shutdown]);
  assert.equal(drained, true);
}
test('關機等待租約清理並拒絕新工作', gracefulDrain);

/** 確認未結束的 HTTP 連線仍受關機期限約束。@returns {Promise<void>} */
async function drainTimeout() {
  /** 模擬連線永不關閉。@returns {void} */
  function close() {}
  await assert.rejects(drainServer({ close }, createChatTasks(), 20), /SHUTDOWN_TIMEOUT/);
}
test('關機總期限防止無限等待', drainTimeout);

/** 驗證釋放租約後才回傳成功，避免回應完成但清理未完成。@returns {Promise<void>} */
async function releaseBeforeResponse() {
  const events = [];
  /** 回傳測試配額。@returns {Promise<object>} 租約與用量。 */
  async function reserve() { return { id: 'test', usage: { userRemaining: 1, globalRemaining: 1 } }; }
  /** 模擬推理結果。@returns {Promise<object>} 測試結果。 */
  async function reply() { return auto; }
  /** 完成租約釋放。@returns {Promise<void>} 完成。 */
  async function release() { await delay(0); events.push('released'); }
  /** 接收回應標頭。@returns {void} */
  function set() {}
  /** 記錄回應時機。@param {object} result 結果。@returns {void} */
  function json(result) { assert.equal(result, auto); events.push('responded'); }
  await createChatHandler(reply, { reserve, release })({ user: { userID: 'user-admin1' }, body: { message: 'test', userID: 'user-admin1' } }, { set, json });
  assert.deepEqual(events, ['released', 'responded']);
}
test('成功回應等待租約釋放', releaseBeforeResponse);

/** 驗證真實用量服務在 Agent 超時後保留扣額並釋放租約。@returns {Promise<void>} */
async function timeoutReleasesQuotaLease() {
  const store = createMemoryLimitStore();
  const usage = createUsageService({ store });
  /** 模擬可建立的 SDK。@returns {object} 替身 SDK。 */
  function getAI() { return {}; }
  /** 不完成檢索，讓 Agent 總期限生效。@returns {Promise<never>} 未完成的檢索。 */
  async function retrieve() {
    /** 模擬無回覆的外部依賴。@returns {void} */
    function pending() {}
    return new Promise(pending);
  }
  /** 接收回應標頭。@returns {void} */
  function set() {}
  const reply = createHelpdeskAgent({ getAI, retrieve, timeoutMs: 20 });
  const handler = createChatHandler(reply, usage);
  await assert.rejects(handler({ user: { userID: 'user-admin1' }, body: { message: 'test', userID: 'user-admin1' } }, { set }), { agentTimeout: true });
  const state = await store.read();
  assert.deepEqual(state.leases, {});
  assert.equal(state.users['user-admin1'], 1);
  assert.equal(state.total, 1);
}
test('Agent 超時仍扣額且釋放真實記憶體租約', timeoutReleasesQuotaLease);

/** 確認總期限不超過租約安全範圍且關機至少保留十秒緩衝。@returns {void} */
function deadlineConfiguration() {
  const options = { environment: { NODE_ENV: 'test', DEMO_PASSWORD: 'test-only-password' }, envFile: '/nonexistent/helpdesk/.env' };
  const config = loadEnv(options);
  assert.equal(config.agentTimeoutMs, 60000);
  assert.equal(config.shutdownTimeoutMs, 75000);
  /** 嘗試超過租約上限。@returns {object} 設定。@throws {Error} 不合法的期限。 */
  function excessive() { return loadEnv({ ...options, environment: { ...options.environment, AGENT_TIMEOUT_MS: '180000' } }); }
  /** 嘗試缺少關機緩衝。@returns {object} 設定。@throws {Error} 不合法的期限。 */
  function shortDrain() { return loadEnv({ ...options, environment: { ...options.environment, SHUTDOWN_TIMEOUT_MS: '10000' } }); }
  assert.throws(excessive, /AGENT_TIMEOUT_MS/);
  assert.throws(shortDrain, /SHUTDOWN_TIMEOUT_MS/);
}
test('總期限與關機期限設定驗證', deadlineConfiguration);
