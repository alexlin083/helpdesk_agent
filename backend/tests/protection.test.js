import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/testEnv.js';
setupTestEnv();
const { env } = await import('../src/config/env.js');
const { createAuthService, accountFor, ACCOUNTS } = await import('../src/services/authService.js');
const { createUsageService, taipeiDay } = await import('../src/services/usageService.js');
const { createMemoryLimitStore } = await import('../src/services/storage/limitStore.js');

/**
 * 以可控制時鐘驗證自動生成租約在 AI 的 60 秒期限後仍保護帳號與全站並行，90 秒才容許故障復原。
 * 同時驗證正常釋放可立即回收名額；拒絕重複請求不扣額，成功或故障過期均不退還已預扣次數。
 * 全程使用記憶體儲存與假帳號，不呼叫 AI 或使用真實資料庫。
 * @returns {Promise<void>} 租約、並行與扣額行為驗證完成。
 */
async function draftLeaseBuffer() {
  let now = 100000;
  /** 回傳測試控制的 epoch 毫秒。@returns {number} 模擬時間。 */
  function clock() { return now; }
  const store = createMemoryLimitStore();
  const usage = createUsageService({ store, clock, config: { ...env, globalConcurrency: 1 } });
  await usage.reserveDraft('test-user-a');
  now += 60000;
  await assert.rejects(usage.reserveDraft('test-user-a'), { code: 'REQUEST_IN_PROGRESS' });
  await assert.rejects(usage.reserveDraft('test-user-b'), { code: 'SERVICE_BUSY' });
  now += 29999;
  await assert.rejects(usage.reserveDraft('test-user-a'), { code: 'REQUEST_IN_PROGRESS' });
  now += 1;
  const recovered = await usage.reserveDraft('test-user-a');
  assert.equal((await store.read()).draft.total, 2);
  await usage.releaseDraft('test-user-a', recovered.id);
  const next = await usage.reserveDraft('test-user-b');
  await usage.releaseDraft('test-user-b', next.id);
  assert.deepEqual((await store.read()).leases, {});
  assert.equal((await store.read()).draft.total, 3);
}
test('自動生成租約涵蓋 60 秒回合與清理緩衝，90 秒故障復原', draftLeaseBuffer);

/**
 * 驗證十組帳密、有效簽章、偽造 token 與過期憑證，不呼叫外部服務。
 * @param {import('node:test').TestContext} context 模擬時間工具。
 * @returns {Promise<void>}
 */
async function signedIdentity(context) {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-15T00:00:00Z') });
  const auth = createAuthService({ ...env, authSecret: 'test-only-secret'.repeat(4), authTtlSeconds: 2 });
  for (let index = 1; index <= 10; index += 1) {
    const user = accountFor(ACCOUNTS[index - 1]);
    assert.equal(typeof user.department.id, 'string');
    assert.deepEqual(auth.credentials(user.username, 'test-only-password'), user);
    const session = await auth.issue(user);
    assert.deepEqual(await auth.verify(session.token), user);
    await assert.rejects(auth.verify(`${session.token}tampered`), { status: 401 });
  }
  for (const name of ['racky', 'racky.huang.jr', 'Racky.Huang', 'admin1', 'constructor', '__proto__']) assert.equal(accountFor(name), null);
  assert.equal(auth.credentials('racky.huang', 'wrong'), null);
  const session = await auth.issue(accountFor('ivy.chang'));
  context.mock.timers.tick(3000);
  await assert.rejects(auth.verify(session.token), { status: 401 });
}
test('十組帳號、簽章驗證、偽造與過期憑證', signedIdentity);

/**
 * 驗證十個並行請求不超過全站二筆，單帳號租約與十秒冷卻不可繞過。
 * @returns {Promise<void>}
 */
async function concurrencyAndCooldown() {
  let now = 100000;
  /** 提供可控制時間。@returns {number} epoch 毫秒。 */
  function clock() { return now; }
  const usage = createUsageService({ store: createMemoryLimitStore(), clock });
  const tasks = [];
  for (let index = 1; index <= 10; index += 1) tasks.push(usage.reserve(`user-${ACCOUNTS[index - 1]}`));
  const results = await Promise.allSettled(tasks);
  const allowed = [];
  for (const [index, result] of results.entries()) if (result.status === 'fulfilled') allowed.push([`user-${ACCOUNTS[index]}`, result.value]);
  assert.equal(allowed.length, 2);
  await assert.rejects(usage.reserve(allowed[0][0]), { code: 'REQUEST_IN_PROGRESS' });
  await usage.release(allowed[0][0], allowed[0][1].id);
  await assert.rejects(usage.reserve(allowed[0][0]), { code: 'RATE_LIMIT_EXCEEDED', retryAfter: 10 });
  now += 10000;
  const next = await usage.reserve(allowed[0][0]);
  // 舊租約不能釋放新請求。
  await usage.release(allowed[0][0], allowed[0][1].id);
  await assert.rejects(usage.reserve(allowed[0][0]), { code: 'REQUEST_IN_PROGRESS' });
  await usage.release(allowed[0][0], next.id);
  assert.equal((await usage.usage(allowed[0][0])).userRemaining, env.userDailyLimit - 2);
}
test('原子性並行上限、冷卻及舊租約隔離', concurrencyAndCooldown);

/**
 * 驗證帳號與全站配額、台北午夜重置，並保留跨午夜的處理中租約。
 * @returns {Promise<void>}
 */
async function dailyQuota() {
  let now = Date.parse('2026-10-15T15:59:00Z');
  /** 提供台北午夜前後的時間。@returns {number} epoch 毫秒。 */
  function clock() { return now; }
  const config = { ...env, userDailyLimit: 1, globalDailyLimit: 2 };
  const usage = createUsageService({ store: createMemoryLimitStore(), config, clock });
  const first = await usage.reserve('user-racky.huang');
  await usage.release('user-racky.huang', first.id);
  now += 10000;
  await assert.rejects(usage.reserve('user-racky.huang'), { code: 'DAILY_QUOTA_EXCEEDED' });
  const second = await usage.reserve('user-amy.chen');
  await assert.rejects(usage.reserve('user-brian.lin'), { code: 'GLOBAL_QUOTA_EXCEEDED' });
  assert.equal((await usage.usage('user-brian.lin')).globalRemaining, 0);
  assert.equal(taipeiDay(now).day, '2026-10-15');
  now = Date.parse('2026-10-15T16:00:00Z');
  assert.equal(taipeiDay(now).day, '2026-10-16');
  assert.equal((await usage.usage('user-racky.huang')).globalRemaining, 2);
  await assert.rejects(usage.reserve('user-amy.chen'), { code: 'REQUEST_IN_PROGRESS' });
  assert.equal((await usage.reserve('user-racky.huang')).usage.userRemaining, 0);
  await usage.release('user-amy.chen', second.id);
}
test('帳號及全站配額一起扣除，台北午夜重置且保留並行保護', dailyQuota);

/**
 * 驗證 IP 一百次失敗後需等待十五分鐘，與程序中斷後的租約到期復原。
 * @returns {Promise<void>}
 */
async function failureWindows() {
  let now = 100000;
  /** 提供測試時間。@returns {number} epoch 毫秒。 */
  function clock() { return now; }
  const usage = createUsageService({ store: createMemoryLimitStore(), clock });
  for (let index = 0; index < 100; index += 1) await usage.loginAttempt('127.0.0.1', false);
  await assert.rejects(usage.loginAttempt('127.0.0.1', true), { code: 'LOGIN_RATE_LIMITED', retryAfter: 900 });
  await usage.loginAttempt('127.0.0.2', true);
  await usage.reserve('user-racky.huang');
  now += 180001;
  const recovered = await usage.reserve('user-racky.huang');
  assert.equal(recovered.usage.userRemaining, env.userDailyLimit - 2);
  now += 900000;
  await usage.loginAttempt('127.0.0.1', true);
}
test('登入失敗限流與崩潰租約到期復原', failureWindows);
