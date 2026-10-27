import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

process.env.NODE_ENV = 'test';
process.env.TICKETS_FILE = '/nonexistent/helpdesk-tests/tickets.json';
process.env.DEMO_PASSWORD = 'test-only-password';
process.env.GEMINI_API_KEY = '';
process.env.LIMIT_STORE = 'memory';
process.env.LOG_LEVEL = 'silent';
const { createChatTasks } = await import('../services/chatTasks.js');
const { createTicketHandler } = await import('../controllers/ticketController.js');
const { createTicketJudge } = await import('../services/ticketJudge.js');
const { createDepartmentService } = await import('../services/departmentService.js');
const { drainServer } = await import('../utils/shutdown.js');
const { loadEnv } = await import('../config/env.js');
const { createMemoryLimitStore } = await import('../services/limitStore.js');
const { createUsageService } = await import('../services/usageService.js');

const departments = createDepartmentService({ departments: [
  { id: 'dept-it-1', name: '資訊管理一部', duty: 'IT資訊服務台', business: ['IT資訊服務台'] },
] });
const request = { user: { userID: 'user-racky.huang', username: 'racky.huang', department: { id: 'dept-it-1', name: '資訊管理一部' } }, body: { subject: '申請 VPN 帳號', content: '新進同仁需要 VPN 連線權限' } };

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

/** 驗證需求單在釋放租約後才回傳成功，避免回應完成但清理未完成；關機中的追蹤器拒絕新需求單。@returns {Promise<void>} */
async function releaseBeforeResponse() {
  const events = [];
  /** 回傳測試配額。@returns {Promise<object>} 租約與用量。 */
  async function reserve() { return { id: 'test', usage: { userRemaining: 1, globalRemaining: 1 } }; }
  /** 完成租約釋放。@returns {Promise<void>} 完成。 */
  async function release() { await delay(0); events.push('released'); }
  /** 模擬判斷結果。@returns {Promise<object>} 分流。 */
  async function judge() { return { route: 'FALLBACK', department: departments.defaultDepartment(), aiDepartment: null, confidence: 10, basis: '', model: 'test' }; }
  /** 記錄保存。@returns {Promise<void>} 完成。 */
  async function insert() { events.push('saved'); }
  /** 接收回應標頭。@returns {void} */
  function set() {}
  /** 記錄回應時機。@param {object} result 結果。@returns {void} */
  function json(result) { assert.equal(result.route, 'FALLBACK'); events.push('responded'); }
  const tasks = createChatTasks();
  const handler = createTicketHandler({ departments, judge, store: { insert }, usage: { reserve, release }, tasks });
  await handler(request, { set, json });
  assert.deepEqual(events, ['saved', 'released', 'responded']);
  tasks.stop();
  await assert.rejects(handler(request, { set, json }), { status: 503, code: 'SERVICE_BUSY' });
}
test('成功回應等待租約釋放，關機中拒絕新需求單', releaseBeforeResponse);

/** 驗證真實用量服務在判斷逾時後保留扣額並釋放租約。@returns {Promise<void>} */
async function timeoutReleasesQuotaLease() {
  const store = createMemoryLimitStore();
  const usage = createUsageService({ store });
  let signal;
  /** 模擬永不回應的模型，外層期限必須結束等待。@param {object} call SDK 請求。@returns {Promise<never>} 未完成結果。 */
  function generateContent(call) {
    signal = call.config.abortSignal;
    /** 保持未完成，模擬上游沒有回覆。@returns {void} */
    function pending() {}
    return new Promise(pending);
  }
  /** 提供替身 SDK。@returns {object} SDK。 */
  function getAI() { return { models: { generateContent } }; }
  /** 接收回應標頭。@returns {void} */
  function set() {}
  const judge = createTicketJudge({ getAI, departments, timeoutMs: 20 });
  const handler = createTicketHandler({ departments, judge, store: { insert: async () => {} }, usage });
  await assert.rejects(handler(request, { set }), { status: 500, code: 'SERVER_ERROR' });
  assert.equal(signal.aborted, true);
  const state = await store.read();
  assert.deepEqual(state.leases, {});
  assert.equal(state.users['user-racky.huang'], 1);
  assert.equal(state.total, 1);
}
test('判斷逾時仍扣額、取消上游等待並釋放真實記憶體租約', timeoutReleasesQuotaLease);

/** 確認關機期限的預設值與下限。@returns {void} */
function shutdownConfiguration() {
  const options = { environment: { NODE_ENV: 'test', DEMO_PASSWORD: 'test-only-password' }, envFile: '/nonexistent/helpdesk/.env' };
  assert.equal(loadEnv(options).shutdownTimeoutMs, 75000);
  assert.equal(loadEnv({ ...options, environment: { ...options.environment, SHUTDOWN_TIMEOUT_MS: '25000' } }).shutdownTimeoutMs, 25000);
  /** 嘗試過短的關機緩衝。@returns {object} 設定。@throws {Error} 不合法的期限。 */
  function shortDrain() { return loadEnv({ ...options, environment: { ...options.environment, SHUTDOWN_TIMEOUT_MS: '10000' } }); }
  assert.throws(shortDrain, /SHUTDOWN_TIMEOUT_MS/);
}
test('關機期限設定驗證', shutdownConfiguration);
