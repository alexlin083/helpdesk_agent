import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'local';
process.env.ADMIN_PASSWORD = 'test-admin-only-password';
process.env.DEMO_PASSWORD = 'test-only-password';
process.env.GEMINI_API_KEY = '';
const { loadEnv } = await import('../config/env.js');

/**
 * 確認登入密碼必須由環境提供，不再悄悄回退至公開的預設密碼。
 * @returns {void}
 */
function requireConfiguredPassword() {
  /** 嘗試缺少密碼的設定。@returns {object} 設定。@throws {Error} 必填參數缺少。 */
  function missing() { return loadEnv({ environment: {}, envFile: '/nonexistent/helpdesk/.env' }); }
  /** 嘗試空白密碼。@returns {object} 設定。@throws {Error} 密碼不可空白。 */
  function blank() { return loadEnv({ environment: { DEMO_PASSWORD: '  ' }, envFile: '/nonexistent/helpdesk/.env' }); }
  assert.throws(missing, /DEMO_PASSWORD|ADMIN_PASSWORD/);
  assert.throws(blank, /DEMO_PASSWORD|ADMIN_PASSWORD/);
}
test('登入密碼必填且無公開預設值', requireConfiguredPassword);

/**
 * 建立包含假密碼的隔離環境檔並於測試結束後清除，不讀取真實登入資訊。
 * @param {Function} run 接收測試環境檔路徑的操作。
 * @returns {void}
 */
function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'helpdesk-env-'));
  const envFile = join(directory, '.env');
  writeFileSync(envFile, 'DEMO_PASSWORD=test-only-password\nADMIN_PASSWORD=test-admin-only-password\nGEMINI_API_KEY=fake-local-key\nPORT=3456\nCORS_ORIGIN=http://localhost:5173\n');
  try {
    run(envFile);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('本機讀取指定 .env，平台參數與空值不被覆寫', () => {
  withFixture((envFile) => {
    const local = loadEnv({ environment: {}, envFile });
    assert.equal(local.geminiApiKey, 'fake-local-key');
    assert.equal(local.port, 3456);
    const external = loadEnv({ environment: { GEMINI_API_KEY: 'fake-platform-key', PORT: '8080' }, envFile });
    assert.equal(external.geminiApiKey, 'fake-platform-key');
    assert.equal(external.port, 8080);
    assert.equal(loadEnv({ environment: { GEMINI_API_KEY: '' }, envFile }).geminiApiKey, '');
  });
});

test('production 忽略 .env，使用平台參數及 PORT', () => {
  withFixture((envFile) => {
    const config = loadEnv({
      environment: {
        NODE_ENV: 'production', DEMO_PASSWORD: 'test-only-password', ADMIN_PASSWORD: 'test-admin-only-password', GEMINI_API_KEY: 'fake-cloud-key', AUTH_SECRET: 'a'.repeat(32), LIMIT_STORE: 'memory',
        CORS_ORIGIN: 'https://example.github.io', PORT: '8080', GEMINI_MODEL: 'test-model',
      },
      envFile,
    });
    assert.equal(config.geminiApiKey, 'fake-cloud-key');
    assert.equal(config.port, 8080);
    assert.equal(config.corsOrigin, 'https://example.github.io');
    assert.equal(config.geminiModel, 'test-model');
    assert.match(config.ticketsFile, /tickets\.json$/);
    assert.throws(() => loadEnv({ environment: { NODE_ENV: 'production' }, envFile }), /GEMINI_API_KEY/);
    assert.throws(() => loadEnv({
      environment: { NODE_ENV: 'production', GEMINI_API_KEY: 'fake-cloud-key' }, envFile,
    }), /CORS_ORIGIN/);
  });
});

test('沒有 .env 時仍可使用平台參數；非法 PORT 被拒絕', () => {
  const config = loadEnv({ environment: { GEMINI_API_KEY: 'fake-key', DEMO_PASSWORD: 'test-only-password', ADMIN_PASSWORD: 'test-admin-only-password' }, envFile: '/nonexistent/helpdesk/.env' });
  assert.equal(config.geminiApiKey, 'fake-key');
  assert.equal(config.port, 3000);
  for (const port of ['abc', '0', '65536', '1.5']) {
    assert.throws(() => loadEnv({ environment: { NODE_ENV: 'production', PORT: port } }), /PORT/);
  }
});

/**
 * 驗證需求單 JSON 檔路徑：預設在 data/tickets.json，可用 TICKETS_FILE 覆寫；HTTP_QUERY_LIMIT 預設 60。
 * @returns {void}
 */
function ticketsFileConfig() {
  const envFile = '/nonexistent/helpdesk/.env';
  const base = { DEMO_PASSWORD: 'test-only-password', ADMIN_PASSWORD: 'test-admin-only-password' };
  const local = loadEnv({ environment: base, envFile });
  assert.match(local.ticketsFile, /[\\/]data[\\/]tickets\.json$/);
  assert.equal(local.httpQueryLimit, 60);
  assert.equal(loadEnv({ environment: { ...base, TICKETS_FILE: '/tmp/custom.json' }, envFile }).ticketsFile, '/tmp/custom.json');
  /** 嘗試無效的查詢限制。@returns {object} 設定。@throws {Error} 參數不是正整數。 */
  function invalid() { return loadEnv({ environment: { ...base, HTTP_QUERY_LIMIT: '0' }, envFile }); }
  assert.throws(invalid, /HTTP_QUERY_LIMIT/);
}
test('需求單檔案路徑與查詢限制設定', ticketsFileConfig);

/** 驗證只接受兩種模式，且正式環境不依賴資料庫；密碼與舊儲存設定錯誤時明確拒絕。@returns {void} */
function productionMemory() {
  const environment = { NODE_ENV: 'production', GEMINI_API_KEY: 'fake-key', CORS_ORIGIN: 'https://example.github.io', AUTH_SECRET: 'x'.repeat(32), DEMO_PASSWORD: 'test-user', ADMIN_PASSWORD: 'test-admin' };
  assert.equal(loadEnv({ environment }).limitStore, 'memory');
  assert.equal(loadEnv({ environment: { ...environment, LIMIT_STORE: 'memory' } }).nodeEnv, 'production');
  /** 嘗試不支援的第三種環境。@returns {object} 設定。 */
  function invalidMode() { return loadEnv({ environment: { ...environment, NODE_ENV: 'development' } }); }
  /** 嘗試已移除的資料庫儲存。@returns {object} 設定。 */
  function invalidStore() { return loadEnv({ environment: { ...environment, LIMIT_STORE: 'dynamodb' } }); }
  /** 嘗試共用一般與管理員密碼。@returns {object} 設定。 */
  function sharedPassword() { return loadEnv({ environment: { ...environment, ADMIN_PASSWORD: environment.DEMO_PASSWORD } }); }
  /** 嘗試缺少管理密碼。@returns {object} 設定。 */
  function missingAdmin() { return loadEnv({ environment: { ...environment, ADMIN_PASSWORD: '' } }); }
  assert.throws(invalidMode, /NODE_ENV/);
  assert.throws(invalidStore, /LIMIT_STORE/);
  assert.throws(sharedPassword, /不得與/);
  assert.throws(missingAdmin, /ADMIN_PASSWORD/);
}
test('正式環境使用記憶體且明確拒絕舊設定與共用管理密碼', productionMemory);
