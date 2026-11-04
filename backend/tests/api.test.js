import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/testEnv.js';

setupTestEnv({ CORS_ORIGIN: 'http://localhost:5173' });
const { app } = await import('../src/server.js');
const { ACCOUNTS } = await import('../src/services/authService.js');

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
 * 驗證完整 app 的健康檢查、跨來源授權標頭、登入、未登入保護、需求單輸入錯誤、JSON 與大小限制，以及共用 IP 的帳號隔離。
 * @returns {Promise<void>}
 */
async function publicRoutes() {
  /** 執行 HTTP 檢查。@param {string} base 本機位址。@returns {Promise<void>} */
  async function check(base) {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { success: true, data: { status: 'ok' } });
    const options = await fetch(`${base}/api/tickets`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-headers'), 'Content-Type,Accept,Authorization');
    assert.equal((await fetch(`${base}/api/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/agent/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404, '對話 API 已移除');
    assert.equal((await fetch(`${base}/api/tickets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"subject":"a","content":"b"}' })).status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ACCOUNTS[9], password: 'test-only-password' }) });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('Cache-Control'), 'no-store');
    const session = await login.json();
    assert.equal(session.user.userID, `user-${ACCOUNTS[9]}`);
    assert.equal(typeof session.user.department.name, 'string');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
    for (const body of [{}, { subject: ' ', content: 'x' }, { subject: 123, content: 'x' }, { subject: 'a'.repeat(101), content: 'x' }, { subject: 'x', content: '' }]) {
      const result = await fetch(`${base}/api/tickets`, { method: 'POST', headers, body: JSON.stringify(body) });
      assert.equal(result.status, 400);
      assert.equal((await result.json()).error.code, 'INVALID_PAYLOAD');
    }
    const badJSON = await fetch(`${base}/api/tickets`, { method: 'POST', headers, body: '{' });
    assert.equal(badJSON.status, 400);
    assert.equal((await badJSON.json()).error.message, '請提供有效的 JSON');
    const oversized = await fetch(`${base}/api/tickets`, { method: 'POST', headers, body: JSON.stringify({ subject: 'x', content: 'a'.repeat(20000) }) });
    assert.equal(oversized.status, 413);
    const noKey = await fetch(`${base}/api/tickets`, { method: 'POST', headers, body: '{"subject":"申請 VPN 帳號","content":"新進同仁需要 VPN 連線權限"}' });
    assert.equal(noKey.status, 500);
    assert.equal((await noKey.json()).error.code, 'SERVER_ERROR');
    for (let index = 0; index < 6; index += 1) {
      const failed = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: index === 0 ? 'racky.huang.jr' : 'racky.huang', password: 'wrong' }) });
      assert.equal(failed.status, 401);
      assert.equal((await failed.json()).error.code, index === 0 ? 'USER_NOT_FOUND' : 'INVALID_CREDENTIALS');
    }
    const blocked = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username":"racky.huang","password":"test-only-password"}' });
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error.code, 'LOGIN_RATE_LIMITED');
    for (let index = 2; index <= 10; index += 1) {
      const other = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: ACCOUNTS[index - 1], password: 'test-only-password' }) });
      assert.equal(other.status, 200);
    }
  }
  await withServer(app, check);
}
test('完整 API 的登入、CORS、身分與輸入保護', publicRoutes);

/**
 * 驗證 body-parser 與 Express 路由產生的 4xx 用戶端錯誤保留原狀態碼與固定訊息，不被誤判為 500 SERVER_ERROR；不回顯請求內容。
 * @returns {Promise<void>}
 */
async function clientErrors() {
  /** 執行 HTTP 檢查。@param {string} base 本機位址。@returns {Promise<void>} */
  async function check(base) {
    const charset = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=latin1' }, body: '{"username":"fake.user","password":"fake-password"}' });
    assert.equal(charset.status, 415);
    const charsetError = (await charset.json()).error;
    assert.equal(charsetError.code, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(charsetError.message, '不支援的請求內容格式或編碼，請使用 UTF-8 JSON');
    const malformed = await fetch(`${base}/api/tickets/%E0%A4%A/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(malformed.status, 400);
    assert.deepEqual((await malformed.json()).error, { code: 'INVALID_PAYLOAD', message: '請求內容或網址格式無效' });
  }
  await withServer(app, check);
}
test('非 HttpError 的 4xx 用戶端錯誤保留狀態碼與固定訊息', clientErrors);

/**
 * 直接呼叫 errorHandler：statusCode 413 沿用既有代碼，沒有 4xx 狀態或狀態為 5xx 的一般錯誤仍回 500 SERVER_ERROR。
 * @returns {Promise<void>}
 */
async function serverErrorsStay500() {
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  /**
   * 以假回應物件執行 errorHandler 並取回輸出。
   * @param {Error} error 測試例外。
   * @returns {{status: number, body: object}} 回應狀態與 JSON。
   */
  function run(error) {
    const result = {};
    const res = {
      headersSent: false,
      /** 記錄標頭（此處不檢查）。@returns {object} 回應本身。 */
      set() { return res; },
      /** 記錄狀態碼。@param {number} code HTTP 狀態。@returns {object} 回應本身，供串接 json。 */
      status(code) { result.status = code; return res; },
      /** 記錄 JSON 本文。@param {object} body 回應本文。@returns {void} */
      json(body) { result.body = body; },
    };
    /** 標頭已送出時才會呼叫，此測試不應發生。@returns {void} @throws {Error} 意外呼叫。 */
    function next() { throw new Error('next must not be called'); }
    errorHandler(error, {}, res, next);
    return result;
  }
  assert.deepEqual(run(Object.assign(new Error('raw too large'), { statusCode: 413 })), { status: 413, body: { error: { code: 'PAYLOAD_TOO_LARGE', message: '請求內容超過大小限制' } } });
  assert.equal(run(new Error('boom')).status, 500);
  assert.equal(run(Object.assign(new Error('upstream'), { status: 502 })).body.error.code, 'SERVER_ERROR');
  assert.equal(run(Object.assign(new Error('weird'), { status: '404' })).status, 500, '字串狀態不視為用戶端錯誤');
}
test('一般例外仍回 500，數值 4xx 才保留', serverErrorsStay500);
