import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DEMO_PASSWORD = 'test-only-password';
process.env.GEMINI_API_KEY = '';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.LIMIT_STORE = 'memory';
process.env.LOG_LEVEL = 'silent';
process.env.TICKETS_FILE = '/nonexistent/helpdesk-api-test/tickets.json';
const { app } = await import('../server.js');
const { ACCOUNTS } = await import('../services/authService.js');

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
