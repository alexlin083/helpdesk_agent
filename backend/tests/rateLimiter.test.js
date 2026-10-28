import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cors from 'cors';

process.env.NODE_ENV = 'local';
process.env.ADMIN_PASSWORD = 'test-admin-only-password';
process.env.TICKETS_FILE = '/nonexistent/helpdesk-tests/tickets.json';
process.env.DEMO_PASSWORD = 'test-only-password';
process.env.GEMINI_API_KEY = '';
process.env.LIMIT_STORE = 'memory';
process.env.LOG_LEVEL = 'silent';
const { env, loadEnv } = await import('../config/env.js');
const { createRateLimiters, createBoundedRateStore } = await import('../middleware/rateLimiter.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const { authenticate } = await import('../middleware/authenticate.js');
const { authService, ACCOUNTS } = await import('../services/authService.js');
const { createTicketHandler, createDepartmentsHandler } = await import('../controllers/ticketController.js');
const { createDepartmentService } = await import('../services/departmentService.js');
const { createAccountService } = await import('../services/accountService.js');
const { createMemoryLimitStore } = await import('../services/limitStore.js');
const { createUsageService } = await import('../services/usageService.js');
const departments = createDepartmentService({ departments: [
  { id: 'dept-it-1', name: '資訊管理一部', duty: 'IT資訊服務台', business: ['IT資訊服務台'] },
] });
const accounts = createAccountService({ accounts: [{ username: 'one.it', department_id: 'dept-it-1' }], departments });

/**
 * 啟動隔離測試用 HTTP server，完成後關閉連線，不呼叫 Gemini 或 AWS。
 * @param {object} app Express app。
 * @param {Function} check 接收本機 URL 的檢查函式。
 * @returns {Promise<void>} 完成測試。
 */
async function withServer(app, check) {
  const server = app.listen(0, '127.0.0.1');
  /** 等待本機監聽。@param {Function} resolve 完成。@param {Function} reject 失敗。@returns {void} */
  function listening(resolve, reject) { server.once('listening', resolve); server.once('error', reject); }
  await new Promise(listening);
  try { await check(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); server.close(); }
}

/** 回傳固定健康資訊，避免觸及外部服務。@param {object} req 請求。@param {object} res 回應。@returns {void} */
function ok(req, res) { res.json({ ok: true }); }

/** 驗證 IP 限流有界、固定視窗到期後回復容量，不會淘汰有效限制。@param {object} context 可控制時間。@returns {Promise<void>} */
async function boundedStorage(context) {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const store = createBoundedRateStore(1);
  store.init({ windowMs: 1000 });
  assert.equal((await store.increment('first')).totalHits, 1);
  await assert.rejects(store.increment('second'), { status: 503, code: 'SERVICE_BUSY' });
  assert.equal((await store.increment('first')).totalHits, 2);
  context.mock.timers.tick(1001);
  assert.equal((await store.increment('second')).totalHits, 1);
  assert.equal(await store.get('first'), undefined);
}
test('HTTP 計數容量有界且到期恢復', boundedStorage);

/** 驗證總 API 限流先於 JSON，保留 CORS 與健康／OPTIONS，Retry-After 與 JSON 一致。@returns {Promise<void>} */
async function ingressProtection() {
  const { apiRateLimiter } = createRateLimiters({ ...env, httpApiLimit: 2 });
  const app = express();
  app.use(cors({ origin: 'http://localhost:5173', exposedHeaders: ['Retry-After'] }));
  app.use('/api', apiRateLimiter);
  app.use(express.json());
  app.get('/api/health', ok);
  app.post('/api/test', ok);
  app.use(errorHandler);
  /** 呼叫同一 IP 的多個端點並驗證失敗時的瀏覽器可讀標頭。@param {string} base 測試 URL。@returns {Promise<void>} */
  async function check(base) {
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
      assert.equal((await fetch(`${base}/api/test`, { method: 'OPTIONS' })).status, 204);
    }
    const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' };
    for (let index = 0; index < 2; index += 1) assert.equal((await fetch(`${base}/api/test`, { method: 'POST', headers, body: '{}' })).status, 200);
    const blocked = await fetch(`${base}/api/test`, { method: 'POST', headers, body: '{' });
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error.code, 'RATE_LIMIT_EXCEEDED');
    assert.ok(body.error.retry_after > 0 && body.error.retry_after <= 60);
    assert.equal(blocked.headers.get('Retry-After'), String(body.error.retry_after));
    assert.equal(blocked.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
  }
  await withServer(app, check);
}
test('總 API 保護先於 JSON 且不影響健康檢查與 CORS', ingressProtection);

/** 驗證登入包含失敗請求也會計數，且發生於 JSON 解析之前。@returns {Promise<void>} */
async function loginRequestProtection() {
  const { loginRateLimiter } = createRateLimiters({ ...env, httpLoginLimit: 2 });
  const app = express();
  app.post('/login', loginRateLimiter);
  app.use(express.json());
  app.post('/login', ok);
  app.use(errorHandler);
  /** 先送格式錯誤，再確認相同 IP 已被入口阻擋。@param {string} base 本機 URL。@returns {Promise<void>} */
  async function check(base) {
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' };
    assert.equal((await fetch(`${base}/login`, options)).status, 400);
    assert.equal((await fetch(`${base}/login`, options)).status, 400);
    assert.equal((await fetch(`${base}/login`, options)).status, 429);
  }
  await withServer(app, check);
}
test('登入總請求包含失敗且先於 JSON 驗證', loginRequestProtection);

/** 驗證真實 JWT 帳號隔離：需求單與部門名單的 HTTP 限流各自依憑證身分計數，HTTP 拒絕不扣額也不呼叫判斷。@returns {Promise<void>} */
async function userProtection() {
  const { ticketRateLimiter, departmentRateLimiter } = createRateLimiters({ ...env, httpTicketLimit: 1, httpDepartmentsLimit: 1 });
  const store = createMemoryLimitStore();
  const usage = createUsageService({ store });
  let judged = 0;
  /** 不應被呼叫的判斷器，用來確認 HTTP 拒絕發生在預扣與判斷之前。@returns {Promise<never>} @throws {Error} 意外呼叫。 */
  async function judge() { judged += 1; throw new Error('must not judge'); }
  const app = express();
  app.use(express.json());
  /** 記憶體替身，不寫入真實需求單檔案。@returns {Promise<void>} 完成。 */
  async function insert() {}
  app.post('/tickets', authenticate, ticketRateLimiter, createTicketHandler({ departments, accounts, judge, store: { insert }, usage }));
  app.get('/departments', authenticate, departmentRateLimiter, createDepartmentsHandler(departments, accounts));
  app.use(errorHandler);
  /** 使用十個帳號從同一 IP 操作並測試不同帳號的隔離。@param {string} base 本機 URL。@returns {Promise<void>} */
  async function check(base) {
    assert.equal((await fetch(`${base}/tickets`, { method: 'POST' })).status, 401);
    for (let index = 1; index <= 10; index += 1) {
      const username = ACCOUNTS[index - 1];
      const userID = `user-${username}`;
      const session = await authService.issue({ username, userID });
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
      const options = { method: 'POST', headers, body: JSON.stringify({ subject: '申請 VPN 帳號', content: '新進同仁需要 VPN 連線權限', handler_id: 'one.it' }) };
      assert.equal((await fetch(`${base}/tickets`, options)).status, 200);
      const rejected = await fetch(`${base}/tickets`, { ...options, body: JSON.stringify({ subject: '申請 VPN 帳號', content: '新進同仁需要 VPN 連線權限' }) });
      assert.equal(rejected.status, 429);
      assert.equal((await rejected.json()).error.code, 'RATE_LIMIT_EXCEEDED');
      assert.equal((await usage.usage(userID)).userRemaining, env.userDailyLimit);
      assert.equal((await fetch(`${base}/departments`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/departments`, { headers })).status, 429);
    }
    assert.equal(judged, 0);
    assert.equal((await store.read()).total ?? 0, 0);
  }
  await withServer(app, check);
}
test('同 IP 十帳號的 HTTP 限流隔離且拒絕不扣額', userProtection);

/** 驗證帳號＋IP、成功不清除 IP 總失敗、未知帳號與 IPv6 子網限制。@returns {Promise<void>} */
async function loginFailureIsolation() {
  let now = 100000;
  /** 提供可控制的視窗時間。@returns {number} epoch 毫秒。 */
  function clock() { return now; }
  const store = createMemoryLimitStore();
  const usage = createUsageService({ store, clock });
  for (let index = 0; index < 5; index += 1) await usage.loginAttempt('127.0.0.1', false, 'racky.huang');
  await assert.rejects(usage.loginAttempt('127.0.0.1', true, 'racky.huang'), { code: 'LOGIN_RATE_LIMITED', retryAfter: 300 });
  for (let index = 2; index <= 10; index += 1) await usage.loginAttempt('127.0.0.1', true, ACCOUNTS[index - 1]);
  await usage.loginAttempt('127.0.0.2', true, 'racky.huang');
  // 隨機未知帳號只新增同 IP 的一個桶，不會隨 username 增長。
  for (let index = 0; index < 95; index += 1) await usage.loginAttempt('127.0.0.1', false, `unknown-${index}`);
  assert.equal(Object.keys((await store.read()).login).length, 2);
  await assert.rejects(usage.loginAttempt('127.0.0.1', true, 'amy.chen'), { code: 'LOGIN_RATE_LIMITED', retryAfter: 900 });
  now += 300001;
  await assert.rejects(usage.loginAttempt('127.0.0.1', true, 'racky.huang'), { code: 'LOGIN_RATE_LIMITED' });
  now += 600000;
  await usage.loginAttempt('127.0.0.1', true, 'racky.huang');
  for (let index = 0; index < 5; index += 1) await usage.loginAttempt(`2001:db8:1:2::${index + 1}`, false, 'racky.huang');
  await assert.rejects(usage.loginAttempt('2001:db8:1:2::99', true, 'racky.huang'), { code: 'LOGIN_RATE_LIMITED' });
}
test('登入失敗隔離、未知帳號有界與 IPv6 防繞過', loginFailureIsolation);

/** 驗證成功清除帳號組合但保留來源總失敗，封鎖組合到期後可正常登入。@returns {Promise<void>} */
async function accountWindowRecovery() {
  let now = 100000;
  /** 提供隔離的視窗時間。@returns {number} epoch 毫秒。 */
  function clock() { return now; }
  const store = createMemoryLimitStore();
  const usage = createUsageService({ store, clock });
  for (let index = 0; index < 4; index += 1) await usage.loginAttempt('127.0.0.1', false, 'racky.huang');
  await usage.loginAttempt('127.0.0.1', true, 'racky.huang');
  const afterSuccess = (await store.read()).login;
  assert.equal(Object.keys(afterSuccess).length, 1);
  assert.equal(Object.values(afterSuccess)[0].count, 4);
  for (let index = 0; index < 5; index += 1) await usage.loginAttempt('127.0.0.1', false, 'racky.huang');
  await assert.rejects(usage.loginAttempt('127.0.0.1', true, 'racky.huang'), { retryAfter: 300 });
  now += 300001;
  await usage.loginAttempt('127.0.0.1', true, 'racky.huang');
  assert.equal(Object.values((await store.read()).login)[0].count, 9);
}
test('成功登入與帳號失敗視窗到期的計數復原', accountWindowRecovery);

/** 驗證登入狀態容量不足時不部分寫入，也不淘汰有效限制；到期後恢復。@returns {Promise<void>} */
async function loginCapacity() {
  let now = 100000;
  /** 提供容量回復測試時間。@returns {number} epoch 毫秒。 */
  function clock() { return now; }
  const store = createMemoryLimitStore();
  const usage = createUsageService({ store, clock });
  for (let index = 0; index < 256; index += 1) await usage.loginAttempt(`10.0.0.${index}`, false, 'racky.huang');
  assert.equal(Object.keys((await store.read()).login).length, 512);
  await assert.rejects(usage.loginAttempt('10.0.1.1', false, 'racky.huang'), { status: 503, code: 'SERVICE_BUSY' });
  assert.equal(Object.keys((await store.read()).login).length, 512);
  now += 900001;
  await usage.loginAttempt('10.0.1.1', false, 'racky.huang');
  assert.equal(Object.keys((await store.read()).login).length, 2);
}
test('登入失敗計數滿載時保守拒絕且到期可復原', loginCapacity);

/** 驗證新增的限流設定必須為正整數，不接受停用保護的零值。@returns {void} */
function rateConfiguration() {
  for (const name of ['HTTP_API_LIMIT', 'HTTP_LOGIN_LIMIT', 'HTTP_TICKET_LIMIT', 'HTTP_DEPARTMENTS_LIMIT', 'HTTP_QUERY_LIMIT', 'HTTP_RATE_MAX_KEYS', 'HTTP_RATE_WINDOW_SECONDS', 'LOGIN_ACCOUNT_FAILURE_LIMIT', 'LOGIN_ACCOUNT_WINDOW_SECONDS']) {
    /** 嘗試無效的限制設定。@returns {object} 設定。@throws {Error} 參數不是正整數。 */
    function invalid() { return loadEnv({ environment: { DEMO_PASSWORD: 'test-only-password', ADMIN_PASSWORD: 'test-admin-only-password', [name]: '0' }, envFile: '/nonexistent/helpdesk/.env' }); }
    assert.throws(invalid, new RegExp(name));
  }
}
test('HTTP 與帳號失敗限制參數驗證', rateConfiguration);
