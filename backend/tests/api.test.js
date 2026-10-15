import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = '';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.LIMIT_STORE = 'memory';
process.env.LOG_LEVEL = 'silent';
const { app } = await import('../server.js');
const { createChatHandler } = await import('../controllers/agentController.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const { authenticate } = await import('../middleware/authenticate.js');
const { authService } = await import('../services/authService.js');
const { createUsageService } = await import('../services/usageService.js');
const { createMemoryLimitStore } = await import('../services/limitStore.js');
const { createHelpdeskAgent } = await import('../services/geminiAgent.js');
const { env } = await import('../config/env.js');
const decision = { intent: 'IT_SUPPORT', retrieved_sources: [{ doc_name: 'VPN.md', relevance: 0.9 }], confidence_score: 88, action_route: 'AUTO_REPLY', reply_text: '請檢查 VPN 憑證。', ticket_payload: null };

/**
 * 在本機臨時埠啟動測試 app，完成後關閉所有連線；不呼叫真實 Gemini。
 * @param {object} application Express app。
 * @param {Function} run 測試操作。
 * @returns {Promise<void>}
 */
async function withServer(application, run) {
  const server = application.listen(0, '127.0.0.1');
  /** 等待監聽成功。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function listening(resolve, reject) { server.once('listening', resolve); server.once('error', reject); }
  await new Promise(listening);
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); server.close(); }
}

/**
 * 驗證完整 app 的健康檢查、跨來源授權標頭、登入、未登入保護與輸入錯誤。
 * @returns {Promise<void>}
 */
async function publicRoutes() {
  /** 執行 HTTP 檢查。@param {string} base 本機位址。@returns {Promise<void>} */
  async function check(base) {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).data.status, 'ok');
    const options = await fetch(`${base}/api/agent/chat`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-headers'), 'Content-Type,Accept,Authorization');
    assert.equal((await fetch(`${base}/api/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/agent/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":"test","userID":"user-admin1"}' })).status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username":"admin10","password":"123456"}' });
    assert.equal(login.status, 200);
    const session = await login.json();
    assert.equal(session.user.userID, 'user-admin10');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
    const usage = await fetch(`${base}/api/agent/usage`, { headers });
    assert.equal(usage.status, 200);
    assert.equal((await usage.json()).userRemaining, env.userDailyLimit);
    for (const body of [{}, { message: ' ' }, { message: 123 }, { message: 'a'.repeat(501) }]) {
      const result = await fetch(`${base}/api/agent/chat`, { method: 'POST', headers, body: JSON.stringify(body) });
      assert.equal(result.status, 400);
      assert.equal((await result.json()).error.code, 'INVALID_PAYLOAD');
    }
    const mismatch = await fetch(`${base}/api/agent/chat`, { method: 'POST', headers, body: '{"message":"test","userID":"user-admin1"}' });
    assert.equal(mismatch.status, 403);
    const badJSON = await fetch(`${base}/api/agent/chat`, { method: 'POST', headers, body: '{' });
    assert.equal(badJSON.status, 400);
    const oversized = await fetch(`${base}/api/agent/chat`, { method: 'POST', headers, body: JSON.stringify({ message: 'a'.repeat(20000) }) });
    assert.equal(oversized.status, 413);
    const noKey = await fetch(`${base}/api/agent/chat`, { method: 'POST', headers, body: '{"message":"test","userID":"user-admin10"}' });
    assert.equal(noKey.status, 500);
    assert.equal((await noKey.json()).error.code, 'SERVER_ERROR');
    for (let index = 0; index < 10; index += 1) {
      const failed = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: index === 0 ? 'admin11' : 'admin1', password: 'wrong' }) });
      assert.equal(failed.status, 401);
      assert.equal((await failed.json()).error.code, index === 0 ? 'USER_NOT_FOUND' : 'INVALID_CREDENTIALS');
    }
    const blocked = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username":"admin1","password":"123456"}' });
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error.code, 'LOGIN_RATE_LIMITED');
  }
  await withServer(app, check);
}
test('完整 API 的登入、CORS、身分與輸入保護', publicRoutes);

/**
 * 驗證真實驗證 middleware 與 controller 的成功回應、用量標頭、冷卻及配額查詢。
 * @returns {Promise<void>}
 */
async function protectedChat() {
  let calls = 0;
  /** 回傳固定決策。@param {string} message 問題。@returns {Promise<object>} 測試決策。 */
  async function reply(message) { assert.equal(message, '你好'); calls += 1; return decision; }
  const usage = createUsageService({ store: createMemoryLimitStore() });
  const application = express();
  application.use(express.json());
  application.post('/chat', authenticate, createChatHandler(reply, usage));
  application.use(errorHandler);
  const session = await authService.issue({ username: 'admin6', userID: 'user-admin6' });
  /** 執行受保護的對話檢查。@param {string} base 位址。@returns {Promise<void>} */
  async function check(base) {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
    const body = JSON.stringify({ message: ' 你好 ', userID: 'user-admin6' });
    const first = await fetch(`${base}/chat`, { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), decision);
    assert.equal(Number(first.headers.get('X-User-Remaining')), env.userDailyLimit - 1);
    const second = await fetch(`${base}/chat`, { method: 'POST', headers, body });
    assert.equal(second.status, 429);
    const error = (await second.json()).error;
    assert.equal(error.code, 'RATE_LIMIT_EXCEEDED');
    assert.ok(error.retry_after > 0);
    assert.equal(second.headers.get('Retry-After'), String(error.retry_after));
    assert.equal(calls, 1);
  }
  await withServer(application, check);
}
test('受保護對話維持 JSON 合約且後端冷卻阻擋重複推理', protectedChat);

/**
 * 驗證上游錯誤仍扣一次額度且釋放租約，不洩漏供應商錯誤。
 * @returns {Promise<void>}
 */
async function upstreamFailure() {
  const usage = createUsageService({ store: createMemoryLimitStore() });
  /** 模擬 SDK 失敗。@returns {Promise<never>} @throws {Error} 上游限流。 */
  async function generateContent() { throw { status: 429, message: 'secret-upstream-details' }; }
  /** 提供替身 SDK。@returns {object} SDK。 */
  function getAI() { return { models: { generateContent } }; }
  /** 不執行真實檢索。@returns {Promise<object[]>} 空文件。 */
  async function retrieve() { return []; }
  const application = express();
  application.use(express.json());
  application.post('/chat', authenticate, createChatHandler(createHelpdeskAgent({ getAI, retrieve }), usage));
  application.use(errorHandler);
  const session = await authService.issue({ username: 'admin7', userID: 'user-admin7' });
  /** 執行上游錯誤檢查。@param {string} base 位址。@returns {Promise<void>} */
  async function check(base) {
    const result = await fetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: '{"message":"test","userID":"user-admin7"}' });
    assert.equal(result.status, 429);
    assert.ok(!(await result.text()).includes('secret-upstream-details'));
    assert.equal((await usage.usage('user-admin7')).userRemaining, env.userDailyLimit - 1);
  }
  await withServer(application, check);
}
test('上游限流保留安全錯誤格式並計入使用量', upstreamFailure);
