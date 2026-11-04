import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestEnv } from './helpers/testEnv.js';

const directory = await mkdtemp(join(tmpdir(), 'helpdesk-admin-'));
setupTestEnv({
  DEMO_PASSWORD: 'test-only-user-password',
  ADMIN_PASSWORD: 'test-only-admin-password',
  ORIGIN_VERIFY_SECRET: '',
  DATABASE_FILE: join(directory, 'helpdesk.db'),
  HTTP_QUERY_LIMIT: '1',
  HTTP_API_LIMIT: '30',
});
const { app } = await import('../src/server.js');
const { authService, accountFor } = await import('../src/services/authService.js');
const { accountService } = await import('../src/services/personnel/accountService.js');
const { dataStore, createSqliteDataStore } = await import('../src/services/storage/dataStore.js');
const { usageService } = await import('../src/services/usageService.js');
const { limitStore, createMemoryLimitStore } = await import('../src/services/storage/limitStore.js');
const { createTaskTracker } = await import('../src/services/taskTracker.js');
const { createAdminReset } = await import('../src/services/admin/adminService.js');
const Database = createRequire(import.meta.url)('better-sqlite3');

const openedStores = [dataStore];
/** 測試結束後先關閉資料庫連線（Windows 不能刪除仍開啟的檔案），再移除全部隔離資料，不觸及專案工作單。@returns {Promise<void>} */
async function cleanup() {
  for (const store of openedStores) store.close();
  await rm(directory, { recursive: true, force: true });
}
test.after(cleanup);

/**
 * 驗證管理密碼隔離、後端角色、一般帳號不得管理、管理員不得操作工作單，以及完整重置與磁碟結果。
 * 同時驗證 IP 與帳號 HTTP 限流耗盡後，已登入管理員仍能維護，清除後一般操作恢復。
 * @returns {Promise<void>} 完成真實 HTTP 與暫存檔整合測試。
 */
async function adminIntegration() {
  assert.equal(authService.credentials('alex.admin', 'test-only-user-password'), null);
  assert.equal(authService.credentials('racky.huang', 'test-only-admin-password'), null);
  assert.equal(accountFor('alex.admin').role, 'ADMIN');
  assert.equal(accountFor('alex.admin').department.id, 'dept-it-1');
  assert.equal(accountService.findHandler('alex.admin'), null);
  assert.ok(!accountService.handlersOf('dept-it-1').some(isAdmin));
  /** 判斷處理人名單是否誤含管理員。@param {object} handler 處理人。@returns {boolean} 是否為管理員。 */
  function isAdmin(handler) { return handler.id === 'alex.admin'; }
  const server = app.listen(0, '127.0.0.1');
  /** 等待本機測試埠就緒。@param {Function} resolve 完成。@param {Function} reject 失敗。@returns {void} */
  function listening(resolve, reject) { server.once('listening', resolve); server.once('error', reject); }
  await new Promise(listening);
  const base = `http://127.0.0.1:${server.address().port}`;
  /** 執行不含實際機密的 API 請求。@param {string} path 路徑。@param {string} [token] 假測試憑證。@param {object} [body] POST 本文。@returns {Promise<Response>} HTTP 回應。 */
  async function call(path, token, body) {
    return fetch(`${base}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  try {
    const login = await call('/auth/login', undefined, { username: 'alex.admin', password: 'test-only-admin-password', role: 'USER' });
    assert.equal(login.status, 200);
    const admin = (await login.json()).token;
    const user = (await authService.issue(accountFor('racky.huang'))).token;
    const confirmation = { confirmation: 'RESET_HELPDESK' };
    assert.equal((await call('/admin/reset', undefined, confirmation)).status, 401);
    assert.equal((await call('/admin/metrics')).status, 401);
    assert.equal((await call('/admin/metrics', user)).status, 403);
    const firstMetrics = await call('/admin/metrics', admin);
    assert.equal(firstMetrics.status, 200);
    assert.equal(firstMetrics.headers.get('cache-control'), 'no-store');
    assert.equal((await firstMetrics.json()).users.length, 16, '十六組一般帳號（含六組假資料代理人帳號）');
    assert.equal((await call('/admin/reset', user, { ...confirmation, role: 'ADMIN' })).status, 403);
    assert.equal((await call('/admin/reset', admin, {})).status, 400);
    assert.equal((await call('/departments', admin)).status, 403);
    assert.equal((await call('/tickets/mine', admin)).status, 403);
    assert.equal((await call('/tickets/department', admin)).status, 403);
    assert.equal((await call('/tickets/completed', admin)).status, 403);
    for (const path of ['/tickets', '/tickets/fake/decision', '/tickets/fake/transfer', '/tickets/fake/cancel']) {
      assert.equal((await call(path, admin, { subject: '測試', content: '內容' })).status, 403);
    }
    assert.equal((await call('/tickets', user, { subject: '指定管理員', content: '不可送達', handler_id: 'alex.admin' })).status, 400);
    assert.equal((await call('/tickets', user, { subject: '測試工作單', content: '暫存測試', handler_id: 'racky.huang' })).status, 200);
    assert.equal((await call('/tickets/mine', user)).status, 200);
    assert.equal((await call('/tickets/mine', user)).status, 429);
    for (let index = 0; index < 4; index += 1) assert.equal((await call('/admin/metrics', admin)).status, 200, '監測不消耗工作單查詢額度');
    const snapshot = await (await call('/admin/metrics', admin)).json();
    assert.equal(snapshot.ticketStore.available, true);
    assert.equal(snapshot.ticketStore.total, 1);
    assert.equal(snapshot.ticketStore.pending, 1);
    assert.ok(snapshot.ticketStore.fileBytes > 0, '回報實際資料庫檔大小');
    assert.ok(!JSON.stringify(snapshot).includes('暫存測試'), '監測不含需求單內容');
    const queries = snapshot.http.find(queryScope);
    /** 找出一般查詢視窗。@param {object} entry 頻率摘要。@returns {boolean} 是否為查詢。 */
    function queryScope(entry) { return entry.scope === 'query'; }
    assert.equal(queries.totalHits, 2);
    assert.equal(queries.atLimitKeys, 1);
    assert.equal(queries.overLimitRequests, 1);
    assert.ok(!JSON.stringify(snapshot).includes('127.0.0.1'));
    const beforeReset = await limitStore.read();
    await call('/admin/metrics', admin);
    assert.deepEqual(await limitStore.read(), beforeReset, '監測不修改配額或登入記錄');
    const reservation = await usageService.reserve('user-racky.huang');
    await usageService.release('user-racky.huang', reservation.id);
    await usageService.loginAttempt('127.0.0.2', false, 'racky.huang');
    const reset = await call('/admin/reset', admin, confirmation);
    assert.equal(reset.status, 200);
    assert.equal(reset.headers.get('cache-control'), 'no-store');
    assert.equal((await reset.json()).deletedTickets, 1);
    assert.deepEqual(await dataStore.all(), []);
    const reopened = createSqliteDataStore({ file: process.env.DATABASE_FILE });
    openedStores.push(reopened);
    assert.deepEqual(await reopened.all(), [], '重置結果已寫入資料庫檔');
    assert.equal(reopened.listAccounts().length, 17, '重置不動人員資料表（帳號）');
    assert.equal(reopened.listEmployees().length, 16, '重置不動人員資料表（員工與額度）');
    assert.deepEqual(await limitStore.read(), {}, '配額、冷卻、租約與登入失敗狀態全部清除');
    assert.equal((await usageService.usage('user-racky.huang')).userRemaining, 30);
    assert.equal((await usageService.usage('user-racky.huang')).globalRemaining, 100);
    assert.equal((await usageService.usage('user-racky.huang')).cooldownSeconds, 0);
    assert.equal((await call('/tickets/mine', user)).status, 200);
    const afterReset = await (await call('/admin/metrics', admin)).json();
    assert.equal(afterReset.ticketStore.total, 0, '重置後資料庫筆數歸零');
    assert.equal(afterReset.ai.used, 0);
    assert.equal(afterReset.ai.active, 0);
    // 入口 IP 額度耗盡仍不阻擋已驗證的管理路徑。
    for (let index = 0; index < 35; index += 1) await call('/unknown', user);
    assert.equal((await call('/tickets/mine', user)).status, 429);
    assert.equal((await call('/admin/metrics', admin)).status, 200, '一般入口超限不影響監測');
    assert.equal((await call('/admin/reset', admin, confirmation)).status, 200);
    assert.equal((await call('/tickets/mine', user)).status, 200);
    let monitorBlocked;
    for (let index = 0; index < 61; index += 1) monitorBlocked = await call('/admin/metrics', admin);
    assert.equal(monitorBlocked.status, 429);
    assert.ok(Number(monitorBlocked.headers.get('retry-after')) > 0);
    assert.equal((await call('/admin/reset', admin, confirmation)).status, 200, '監測超限不阻擋管理重置');
    assert.equal((await call('/admin/metrics', admin)).status, 429, '重置不清除監測的獨立保護');
    // 管理頻率計數不會被自己的重置洗掉。
    let final;
    for (let index = 0; index < 12; index += 1) final = await call('/admin/reset', admin, confirmation);
    assert.equal(final.status, 429);
  } finally { server.closeAllConnections(); await new Promise(close); }
  /** 關閉本機伺服器。@param {Function} resolve 關閉完成。@returns {void} */
  function close(resolve) { server.close(resolve); }
}
test('管理員權限、獨立密碼、全站重置與不可自洗的管理限流', adminIntegration);

/**
 * 驗證維護會等待尚未完成的 AI／登入工作，拒絕新工作與第二次重置，結束後恢復使用。
 * @returns {Promise<void>} 並行驗證完成。
 */
async function resetConcurrency() {
  const tasks = createTaskTracker();
  const limits = createMemoryLimitStore();
  let finish;
  /** 捕捉既有工作的完成控制點。@param {Function} resolve 解除阻塞。@returns {void} */
  function deferred(resolve) { finish = resolve; }
  const waiting = new Promise(deferred);
  let saved = false;
  let cleared = false;
  let rates = false;
  /** 模擬尚在執行中的工作，完成前不能重置。@returns {Promise<void>} 寫入結束。 */
  async function oldWork() { await waiting; saved = true; }
  const pending = tasks.run(oldWork);
  /** 驗證舊寫入已完成才清空。@returns {Promise<number>} 清除筆數。 */
  async function clear() { assert.equal(saved, true); cleared = true; return 1; }
  /** 模擬重置 HTTP 計數。@returns {Promise<void>} 完成。 */
  async function resetRates() { rates = true; }
  const reset = createAdminReset({ tasks, limits, tickets: { clear }, resetRates });
  const maintenance = reset({ userID: 'test-admin' });
  assert.equal(cleared, false);
  await assert.rejects(tasks.run(oldWork), { code: 'SERVICE_BUSY' });
  await assert.rejects(reset({ userID: 'test-admin' }), { code: 'SERVICE_BUSY' });
  finish();
  await pending;
  assert.equal((await maintenance).deletedTickets, 1);
  assert.equal(rates, true);
  assert.equal(await tasks.run(recovered), 'ok');
  /** 驗證維護後一般操作恢復。@returns {string} 測試結果。 */
  function recovered() { return 'ok'; }
}
test('重置排空既有工作並在維護期間拒絕新工作', resetConcurrency);

/** 驗證清除失敗時保留工作單與保護計數，並解除維護鎖。@returns {Promise<void>} 驗證完成。 */
async function resetFailure() {
  const file = join(directory, 'failure.db');
  const tickets = createSqliteDataStore({ file });
  openedStores.push(tickets);
  await tickets.insert({ ticket_id: 'test-one' });
  // 以另一條連線建立觸發器讓刪除失敗，不依賴使用者的檔案權限。
  const saboteur = new Database(file);
  saboteur.exec("CREATE TRIGGER block_delete BEFORE DELETE ON tickets BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
  const limits = createMemoryLimitStore();
  /** 寫入不可遺失的假保護計數。@param {object} state 快照。@returns {void} */
  function seed(state) { state.total = 4; }
  await limits.transact(seed);
  const tasks = createTaskTracker();
  /** 清檔失敗時不得執行 HTTP 重置。@returns {Promise<never>} 永遠失敗。 */
  async function resetRates() { assert.fail('不應重置 HTTP 計數'); }
  const reset = createAdminReset({ tickets, limits, tasks, resetRates });
  await assert.rejects(reset({ userID: 'test-admin' }), { code: 'TICKET_STORE_UNAVAILABLE' });
  assert.equal((await tickets.all()).length, 1);
  assert.equal((await limits.read()).total, 4);
  /** 取回維護後可執行的結果。@returns {boolean} true。 */
  function recovered() { return true; }
  assert.equal(await tasks.run(recovered), true);
  // 移除觸發器，確認下一次清除可正常刪除並寫入資料庫檔。
  saboteur.exec('DROP TRIGGER block_delete;');
  saboteur.close();
  assert.equal(await tickets.clear(), 1);
  assert.deepEqual(await tickets.all(), []);
  tickets.close();
  assert.deepEqual(await tickets.all(), [], '重新開啟後仍是空的');
}
test('清除失敗保留工作單及計數並釋放維護鎖', resetFailure);

/** 驗證 CloudFront 來源秘密的必要性、正確通過、健康檢查例外與本機停用。@returns {Promise<void>} 驗證完成。 */
async function originProtection() {
  const { createOriginGuard } = await import('../src/middleware/originGuard.js');
  const secret = 'test-origin-secret-not-a-real-key-12345';
  const guard = createOriginGuard(secret);
  let passed = 0;
  /** 記錄 middleware 通過次數。@returns {void} */
  function next() { passed += 1; }
  /** 建立來源請求替身。@param {string} method HTTP 方法。@param {string} path 路徑。@param {string} [value] 來源標頭。@returns {object} 請求。 */
  function request(method, path, value = '') {
    return { method, path,
      /** 只回傳測試來源標頭。@returns {string} 標頭。 */
      get() { return value; },
    };
  }
  /** 測試未經 CloudFront 的業務請求。@returns {void} */
  function direct() { guard(request('POST', '/admin/reset'), {}, next); }
  /** 測試缺少代理標頭的預檢。@returns {void} */
  function preflightWithoutOrigin() { guard(request('OPTIONS', '/tickets'), {}, next); }
  /** 測試錯誤的代理標頭。@returns {void} */
  function wrongOrigin() { guard(request('GET', '/tickets/mine', 'fake'), {}, next); }
  assert.throws(direct, { status: 403 });
  assert.throws(preflightWithoutOrigin, { status: 403 });
  assert.throws(wrongOrigin, { status: 403 });
  guard(request('OPTIONS', '/tickets', secret), {}, next);
  guard(request('POST', '/admin/reset', secret), {}, next);
  guard(request('GET', '/health'), {}, next);
  createOriginGuard('')(request('POST', '/auth/login'), {}, next);
  assert.equal(passed, 4);
}
test('CloudFront 來源驗證與健康檢查例外', originProtection);
