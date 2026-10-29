import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'local';
process.env.ADMIN_PASSWORD = 'test-metrics-admin-password';
process.env.DEMO_PASSWORD = 'test-metrics-user-password';
process.env.GEMINI_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
const { env } = await import('../config/env.js');
const { createAdminMetrics } = await import('../services/adminMetrics.js');
const { createMemoryLimitStore } = await import('../services/limitStore.js');
const { createChatTasks } = await import('../services/chatTasks.js');
const { createRateLimiters, createBoundedRateStore } = await import('../middleware/rateLimiter.js');

/** 驗證唯讀快照正確處理每日額度、過期視窗、跨午夜租約與私密欄位白名單。@returns {Promise<void>} 驗證完成。 */
async function projectedMetrics() {
  let now = Date.parse('2026-10-28T15:59:59Z');
  /** 提供台北午夜前後的可控制時間。@returns {number} epoch 毫秒。 */
  function clock() { return now; }
  const store = createMemoryLimitStore();
  /** 種入有效與過期資料，加入不可被輸出的欄位。@param {object} state 快照。@returns {void} */
  function seed(state) {
    Object.assign(state, { day: '2026-10-28', total: 3, users: { 'user-a.b': 3 }, cooldowns: { 'user-a.b': now + 5000 },
      leases: { 'user-a.b': { id: 'private-lease-id', until: now + 10000 }, expired: { id: 'expired-lease', until: now - 1 } },
      login: { 'ip:private-ip-hash': { count: 100, resetAt: now + 60000 }, 'account:private-account-hash:a.b': { count: 5, resetAt: now + 60000 }, 'ip:expired': { count: 7, resetAt: now - 1 } },
      secret: 'never-output-this-secret',
    });
  }
  await store.transact(seed);
  const before = await store.read();
  const accounts = {
    /** 回傳一般帳號與不該出現在用量表的管理員。@returns {object[]} 帳號。 */
    list() { return [{ username: 'a.b', userID: 'user-a.b', role: 'USER', department: { id: 'test', name: '測試部門' } }, { username: 'test.admin', role: 'ADMIN' }]; },
  };
  /** 不依賴全域 HTTP 儲存。@returns {object[]} 空視窗。 */
  function rates() { return []; }
  const tasks = createChatTasks();
  const get = createAdminMetrics({ store, accounts, rates, tasks, clock, config: { ...env, nodeEnv: 'production' } });
  const current = await get();
  assert.equal(current.ai.used, 3);
  assert.equal(current.ai.remaining, 97);
  assert.equal(current.ai.active, 1);
  assert.equal(current.users.length, 1);
  assert.equal(current.users[0].remaining, 27);
  assert.equal(current.users[0].cooldownSeconds, 5);
  assert.equal(current.users[0].inProgress, true);
  assert.equal(current.login.ip.activeKeys, 1);
  assert.equal(current.login.ip.failures, 100);
  assert.equal(current.login.account.atLimitKeys, 1);
  for (const value of ['private-lease-id', 'private-ip-hash', 'private-account-hash', 'never-output-this-secret']) assert.ok(!JSON.stringify(current).includes(value));
  assert.deepEqual(await store.read(), before);
  now += 2000;
  const midnight = await get();
  assert.equal(midnight.ai.day, '2026-10-29');
  assert.equal(midnight.ai.used, 0);
  assert.equal(midnight.users[0].remaining, 30);
  assert.equal(midnight.ai.active, 1);
  assert.equal(midnight.users[0].cooldownSeconds, 3);
  now += 70000;
  const expired = await get();
  assert.equal(expired.ai.active, 0);
  assert.equal(expired.login.ip.activeKeys, 0);
  assert.deepEqual(await store.read(), before, '投影過期與跨日狀態不修改儲存');
  await store.reset();
  assert.equal((await get()).ai.used, 0);
}
test('監測快照唯讀、跨日與過期處理及秘密遮蔽', projectedMetrics);

/** 驗證 HTTP 快照只讀有效視窗、回傳獨立複本，且對外彙整不揭露 IP。@param {object} context 模擬時間。@returns {Promise<void>} 驗證完成。 */
async function rateSnapshots(context) {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const store = createBoundedRateStore(2);
  store.init({ windowMs: 1000 });
  await store.increment('192.0.2.20');
  await store.increment('192.0.2.20');
  const snapshot = store.snapshot();
  assert.equal(snapshot[0].totalHits, 2);
  snapshot[0].totalHits = 999;
  assert.equal((await store.get('192.0.2.20')).totalHits, 2);
  assert.deepEqual(store.snapshot(101001), []);
  const limits = createRateLimiters({ ...env, httpApiLimit: 2 });
  const rows = limits.snapshot();
  assert.equal(rows.length, 5);
  assert.equal(rows[0].limit, 2);
  assert.equal(rows[0].windowSeconds, env.httpRateWindowSeconds);
  assert.ok(!JSON.stringify(rows).includes('192.0.2.20'));
  await limits.resetAll();
  assert.equal(limits.snapshot()[0].totalHits, 0);
}
test('HTTP 視窗快照、到期與彙整設定', rateSnapshots);

/** 驗證監測不受維護鎖阻擋，並可正確顯示維護與關機狀態。@returns {Promise<void>} 驗證完成。 */
async function maintenanceMetrics() {
  const tasks = createChatTasks();
  let finish;
  /** 取得維護完成控制點。@param {Function} resolve 完成函式。@returns {void} */
  function capture(resolve) { finish = resolve; }
  const deferred = new Promise(capture);
  /** 模擬尚未完成的維護。@returns {Promise<void>} 等待完成。 */
  async function maintain() { await deferred; }
  const pending = tasks.exclusive(maintain);
  const metrics = createAdminMetrics({ tasks, store: createMemoryLimitStore() });
  assert.equal((await metrics()).runtime.maintaining, true);
  finish();
  await pending;
  assert.equal((await metrics()).runtime.maintaining, false);
  tasks.stop();
  assert.equal((await metrics()).runtime.stopping, true);
}
test('維護期間仍可取得只讀監測狀態', maintenanceMetrics);
