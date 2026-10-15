import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = '';
process.env.LOG_LEVEL = 'debug';
const { createLogger, diagnoseError, requestContext } = await import('../utils/logger.js');
const { createHelpdeskAgent } = await import('../services/geminiAgent.js');
const { requestLogger } = await import('../middleware/requestLogger.js');
const { loadEnv } = await import('../config/env.js');

/**
 * 驗證一般模式過濾 debug，並遮蔽金鑰、本文、提示詞、回覆與 Error 原文。
 * @returns {void}
 */
function verifyRedaction() {
  const records = [];
  /**
   * 收集結構化日誌供斷言檢查，不寫入終端機。
   * @param {string} record 序列化的 JSON 日誌。
   * @returns {void}
   */
  function capture(record) { records.push(JSON.parse(record)); }
  const sink = { log: capture, warn: capture, error: capture };
  const log = createLogger({ level: 'info', secret: 'test-secret-value', sink });
  log('debug', 'hidden');
  log('info', 'visible', { apiKey: 'private', body: { message: '員工問題' },
    nested: { prompt: '企業文件', reply: '回答', error: new Error('private') },
    safe: 'prefix test-secret-value suffix', provider: 'AIzaExampleCredential' });
  assert.equal(records.length, 1);
  assert.equal(records[0].event, 'visible');
  assert.equal(records[0].safe, 'prefix [REDACTED] suffix');
  assert.equal(records[0].provider, '[REDACTED]');
  const output = JSON.stringify(records);
  for (const sensitive of ['test-secret-value', '員工問題', '企業文件', '回答', 'private']) assert.ok(!output.includes(sensitive));
  createLogger({ level: 'silent', sink })('error', 'hidden');
  createLogger({ level: 'debug', sink })('debug', 'shown');
  assert.equal(records.length, 2);
  assert.equal(records[1].event, 'shown');
}
test('日誌等級過濾與敏感資訊遮蔽', verifyRedaction);

/**
 * 驗證 SDK 與網路錯誤的固定分類，不將原始錯誤訊息傳至日誌。
 * @returns {void}
 */
function verifyDiagnostics() {
  const cases = [
    [{ status: 400, message: '{"error":{"message":"API key not valid secret-example"}}' }, 'API_KEY_INVALID'],
    [{ message: '{"error":{"code":404,"message":"model missing"}}' }, 'MODEL_NOT_FOUND'],
    [{ status: 403 }, 'ACCESS_DENIED'], [{ status: 429 }, 'RATE_LIMIT_OR_QUOTA'],
    [{ status: 400 }, 'INVALID_ARGUMENT'], [{ status: 503 }, 'UPSTREAM_UNAVAILABLE'],
    [{ name: 'TimeoutError' }, 'TIMEOUT'], [{ cause: { code: 'ENOTFOUND' } }, 'NETWORK_ERROR'],
    [new Error('unknown secret-example'), 'UNKNOWN'],
  ];
  for (const [error, reason] of cases) {
    const diagnostic = diagnoseError(error);
    assert.equal(diagnostic.reason, reason);
    assert.ok(diagnostic.hint.length > 0);
    assert.ok(!JSON.stringify(diagnostic).includes('secret-example'));
  }
}
test('SDK 錯誤歸類與安全排查建議', verifyDiagnostics);

/**
 * 驗證同時進行的非同步操作保有各自 requestId，不因並行而混用請求脈絡。
 * @returns {Promise<void>}
 */
async function verifyContext() {
  const records = [];
  /**
   * 收集每筆日誌的 requestId。
   * @param {string} record JSON 日誌。
   * @returns {void}
   */
  function capture(record) { records.push(JSON.parse(record)); }
  const log = createLogger({ level: 'debug', sink: { log: capture } });
  /**
   * 讓出一次非同步執行後記錄事件，確認脈絡持續存在。
   * @returns {Promise<void>}
   */
  async function operation() { await Promise.resolve(); log('debug', 'context'); }
  await Promise.all([requestContext.run({ requestId: 'first' }, operation), requestContext.run({ requestId: 'second' }, operation)]);
  assert.deepEqual(new Set([records[0].requestId, records[1].requestId]), new Set(['first', 'second']));
}
test('並行請求的 requestId 不互相污染', verifyContext);

/**
 * 驗證 embedding 失敗可定位 taskType、模型與狀態，並維持前端原有的安全錯誤合約。
 * @param {import('node:test').TestContext} context 測試隔離與 mock 管理器。
 * @returns {Promise<void>}
 */
async function verifyPipelineFailure(context) {
  const records = [];
  /**
   * 捕捉 Agent 與檢索器的實際日誌，不對外輸出測試內容。
   * @param {string} record JSON 日誌。
   * @returns {void}
   */
  function capture(record) { records.push(JSON.parse(record)); }
  context.mock.method(console, 'log', capture);
  context.mock.method(console, 'error', capture);
  /**
   * 模擬文件 embedding 的模型不存在錯誤，錯誤原文刻意包含不得輸出的內容。
   * @returns {Promise<never>}
   * @throws {Error} 模擬 SDK HTTP 404。
   */
  async function embedContent() { throw Object.assign(new Error('private-user-question private-document'), { status: 404 }); }
  /**
   * 提供替身 client，避免呼叫真實 API。
   * @returns {object} 僅提供 embedding 的 SDK 替身。
   */
  function getAI() { return { models: { embedContent } }; }
  const run = createHelpdeskAgent({ getAI });
  await assert.rejects(run('private-user-question'), { status: 500, code: 'SERVER_ERROR', message: '檢索或 AI 服務暫時無法回應' });
  const events = new Map();
  for (const record of records) events.set(record.event, record);
  assert.equal(events.get('gemini.embedding.failed').taskType, 'RETRIEVAL_DOCUMENT');
  assert.equal(events.get('gemini.embedding.failed').reason, 'MODEL_NOT_FOUND');
  assert.equal(events.get('gemini.embedding.failed').upstreamStatus, 404);
  assert.equal(events.get('agent.failed').stage, 'knowledge.retrieve');
  assert.ok(!events.has('gemini.generate.started'));
  assert.ok(!JSON.stringify(records).includes('private-user-question'));
  assert.ok(!JSON.stringify(records).includes('private-document'));
}
test('真實 Agent 管線的日誌指出失敗階段且不洩漏原文', verifyPipelineFailure);

/**
 * 驗證連線在原請求脈絡之外結束時仍保有 requestId，且 finish／close 不重複記錄。
 * @param {import('node:test').TestContext} context 測試的 mock 管理器。
 * @returns {void}
 */
function verifyRequestCompletion(context) {
  const records = [];
  /**
   * 捕捉 HTTP 日誌。
   * @param {string} record JSON 日誌。
   * @returns {void}
   */
  function capture(record) { records.push(JSON.parse(record)); }
  context.mock.method(console, 'log', capture);
  const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true });
  let nextCalls = 0;
  /** 執行替代的後續處理。@returns {void} */
  function next() { nextCalls += 1; }
  requestLogger({ method: 'POST', path: '/api/agent/chat' }, res, next);
  res.emit('finish');
  res.emit('close');
  assert.equal(nextCalls, 1);
  assert.equal(records.length, 2);
  assert.match(records[0].requestId, /^[a-f0-9-]{36}$/);
  assert.equal(records[1].requestId, records[0].requestId);
  assert.equal(records[1].completed, true);
  assert.equal(records[1].status, 200);
}
test('HTTP 完成日誌保留 requestId 且只記錄一次', verifyRequestCompletion);

/**
 * 驗證日誌等級預設、大小寫正規化與無效設定拒絕，不讀取實際 .env。
 * @returns {void}
 */
function verifyLogLevelConfig() {
  const envFile = '/nonexistent/helpdesk-logger/.env';
  assert.equal(loadEnv({ environment: {}, envFile }).logLevel, 'info');
  assert.equal(loadEnv({ environment: { LOG_LEVEL: ' DEBUG ' }, envFile }).logLevel, 'debug');
  /**
   * 嘗試載入不支援的日誌等級，供錯誤斷言檢查。
   * @returns {object} 有效時才回傳設定。
   * @throws {Error} LOG_LEVEL 無效。
   */
  function invalidLevel() { return loadEnv({ environment: { LOG_LEVEL: 'verbose' }, envFile }); }
  assert.throws(invalidLevel, /LOG_LEVEL/);
}
test('LOG_LEVEL 預設值、正規化與驗證', verifyLogLevelConfig);
