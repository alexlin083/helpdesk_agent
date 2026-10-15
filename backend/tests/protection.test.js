import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.DEMO_PASSWORD = 'test-only-password';
process.env.LIMIT_STORE = 'memory';
process.env.GEMINI_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
const { env } = await import('../config/env.js');
const { createAuthService, accountFor } = await import('../services/authService.js');
const { createUsageService, taipeiDay } = await import('../services/usageService.js');
const { createMemoryLimitStore, createDynamoLimitStore } = await import('../services/limitStore.js');

/**
 * 驗證十組帳密、有效簽章、偽造 token 與過期憑證，不呼叫外部服務。
 * @param {import('node:test').TestContext} context 模擬時間工具。
 * @returns {Promise<void>}
 */
async function signedIdentity(context) {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-15T00:00:00Z') });
  const auth = createAuthService({ ...env, authSecret: 'test-only-secret'.repeat(4), authTtlSeconds: 2 });
  for (let index = 1; index <= 10; index += 1) {
    const user = accountFor(`admin${index}`);
    assert.deepEqual(auth.credentials(user.username, 'test-only-password'), user);
    const session = await auth.issue(user);
    assert.deepEqual(await auth.verify(session.token), user);
    await assert.rejects(auth.verify(`${session.token}tampered`), { status: 401 });
  }
  for (const name of ['admin0', 'admin11', 'constructor', '__proto__', 'Admin1']) assert.equal(accountFor(name), null);
  assert.equal(auth.credentials('admin1', 'wrong'), null);
  const session = await auth.issue(accountFor('admin10'));
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
  for (let index = 1; index <= 10; index += 1) tasks.push(usage.reserve(`user-admin${index}`));
  const results = await Promise.allSettled(tasks);
  const allowed = [];
  for (const [index, result] of results.entries()) if (result.status === 'fulfilled') allowed.push([`user-admin${index + 1}`, result.value]);
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
  const first = await usage.reserve('user-admin1');
  await usage.release('user-admin1', first.id);
  now += 10000;
  await assert.rejects(usage.reserve('user-admin1'), { code: 'DAILY_QUOTA_EXCEEDED' });
  const second = await usage.reserve('user-admin2');
  await assert.rejects(usage.reserve('user-admin3'), { code: 'GLOBAL_QUOTA_EXCEEDED' });
  assert.equal((await usage.usage('user-admin3')).globalRemaining, 0);
  assert.equal(taipeiDay(now).day, '2026-10-15');
  now = Date.parse('2026-10-15T16:00:00Z');
  assert.equal(taipeiDay(now).day, '2026-10-16');
  assert.equal((await usage.usage('user-admin1')).globalRemaining, 2);
  await assert.rejects(usage.reserve('user-admin2'), { code: 'REQUEST_IN_PROGRESS' });
  assert.equal((await usage.reserve('user-admin1')).usage.userRemaining, 0);
  await usage.release('user-admin2', second.id);
}
test('帳號及全站配額一起扣除，台北午夜重置且保留並行保護', dailyQuota);

/**
 * 驗證 IP 十次失敗後需等待十五分鐘，與程序中斷後的租約到期復原。
 * @returns {Promise<void>}
 */
async function failureWindows() {
  let now = 100000;
  /** 提供測試時間。@returns {number} epoch 毫秒。 */
  function clock() { return now; }
  const usage = createUsageService({ store: createMemoryLimitStore(), clock });
  for (let index = 0; index < 10; index += 1) await usage.loginAttempt('127.0.0.1', false);
  await assert.rejects(usage.loginAttempt('127.0.0.1', true), { code: 'LOGIN_RATE_LIMITED', retryAfter: 900 });
  await usage.loginAttempt('127.0.0.2', true);
  await usage.reserve('user-admin1');
  now += 180001;
  const recovered = await usage.reserve('user-admin1');
  assert.equal(recovered.usage.userRemaining, env.userDailyLimit - 2);
  now += 900000;
  await usage.loginAttempt('127.0.0.1', true);
}
test('登入失敗限流與崩潰租約到期復原', failureWindows);

/**
 * 模擬同一 DynamoDB 項目版本鎖定，驗證多個服務共用配額、條件衝突重試及故障拒絕。
 * @returns {Promise<void>}
 */
async function dynamoAtomicity() {
  let item;
  let failed = false;
  const client = {
    /**
     * 模擬強一致 Get 與帶版本條件的 Put，不呼叫 AWS。
     * @param {object} command AWS SDK command。
     * @returns {Promise<object>} 模擬的 AWS 回應。
     * @throws {Error} 條件衝突或服務故障。
     */
    async send(command) {
      if (failed) throw new Error('offline');
      if (command.constructor.name === 'GetCommand') return { Item: structuredClone(item) };
      const expected = command.input.ExpressionAttributeValues?.[':version'];
      if ((item && expected !== item.version) || (!item && expected !== undefined)) throw Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
      item = structuredClone(command.input.Item);
      return {};
    },
  };
  const config = { ...env, globalConcurrency: 10, globalDailyLimit: 1 };
  const first = createUsageService({ store: createDynamoLimitStore({ client, table: 'test' }), config });
  const second = createUsageService({ store: createDynamoLimitStore({ client, table: 'test' }), config });
  const results = await Promise.allSettled([first.reserve('user-admin1'), second.reserve('user-admin2')]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.code, 'GLOBAL_QUOTA_EXCEEDED');
  assert.equal((await second.usage('user-admin2')).globalRemaining, 0);
  failed = true;
  await assert.rejects(first.reserve('user-admin3'), { status: 503, code: 'LIMIT_STORE_UNAVAILABLE' });
  await assert.rejects(second.usage('user-admin1'), { status: 503 });
}
test('DynamoDB 跨服務原子配額、版本競爭與故障時拒絕放行', dynamoAtomicity);
