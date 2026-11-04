import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestEnv } from './helpers/testEnv.js';

setupTestEnv();
const { loadEnv } = await import('../src/config/env.js');

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
        NODE_ENV: 'production', AI_PROVIDER: 'gemini', DEMO_PASSWORD: 'test-only-password', ADMIN_PASSWORD: 'test-admin-only-password', GEMINI_API_KEY: 'fake-cloud-key', AUTH_SECRET: 'a'.repeat(32), LIMIT_STORE: 'memory',
        CORS_ORIGIN: 'https://example.github.io', PORT: '8080', GEMINI_MODEL: 'test-model',
      },
      envFile,
    });
    assert.equal(config.geminiApiKey, 'fake-cloud-key');
    assert.equal(config.port, 8080);
    assert.equal(config.corsOrigin, 'https://example.github.io');
    assert.equal(config.geminiModel, 'test-model');
    assert.match(config.ticketsFile, /tickets\.json$/);
    assert.equal(config.aiApiKey, 'fake-cloud-key');
    assert.equal(config.aiModel, 'test-model');
    assert.throws(() => loadEnv({ environment: { NODE_ENV: 'production' }, envFile }), /GEMINI_API_KEY/, '預設主要供應商 gemini 需要 GEMINI_API_KEY');
    assert.throws(() => loadEnv({ environment: { NODE_ENV: 'production', AI_PROVIDER: 'anthropic' }, envFile }), /ANTHROPIC_API_KEY/);
    assert.throws(() => loadEnv({
      environment: { NODE_ENV: 'production', AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake-cloud-key' }, envFile,
    }), /CORS_ORIGIN/);
  });
});

/**
 * 驗證 AI 供應商設定：主要供應商預設 gemini（模型 gemini-3.5-flash，金鑰 GEMINI_API_KEY）；另一家有金鑰時為備援（aiFallbackProvider），
 * 沒有金鑰時為 null；AI_PROVIDER=anthropic 時主要改為 Claude（claude-sonnet-5-5，可用 ANTHROPIC_MODEL 覆寫）、備援為 Gemini；
 * 大小寫與前後空白不影響；不支援的供應商啟動失敗；production 只要求主要供應商的金鑰。
 * @returns {void}
 */
function aiProviderConfig() {
  const envFile = '/nonexistent/helpdesk/.env';
  const base = { DEMO_PASSWORD: 'test-only-password', ADMIN_PASSWORD: 'test-admin-only-password', GEMINI_API_KEY: 'fake-gemini-key', ANTHROPIC_API_KEY: 'fake-anthropic-key' };
  const gemini = loadEnv({ environment: { ...base }, envFile });
  assert.deepEqual([gemini.aiProvider, gemini.aiApiKey, gemini.aiModel, gemini.aiKeyName, gemini.aiFallbackProvider], ['gemini', 'fake-gemini-key', 'gemini-3.5-flash', 'GEMINI_API_KEY', 'anthropic']);
  assert.equal(loadEnv({ environment: { ...base, ANTHROPIC_API_KEY: '' }, envFile }).aiFallbackProvider, null, '沒有 Claude 金鑰時沒有備援');
  const claude = loadEnv({ environment: { ...base, AI_PROVIDER: ' Anthropic ', ANTHROPIC_MODEL: 'claude-haiku-5-5' }, envFile });
  assert.deepEqual([claude.aiProvider, claude.aiApiKey, claude.aiModel, claude.aiKeyName, claude.aiFallbackProvider], ['anthropic', 'fake-anthropic-key', 'claude-haiku-5-5', 'ANTHROPIC_API_KEY', 'gemini']);
  assert.throws(() => loadEnv({ environment: { ...base, AI_PROVIDER: 'openai' }, envFile }), /AI_PROVIDER 只接受 gemini 或 anthropic/);
  const production = { NODE_ENV: 'production', GEMINI_API_KEY: 'fake-gemini-key', CORS_ORIGIN: 'https://example.github.io', AUTH_SECRET: 'x'.repeat(32), DEMO_PASSWORD: 'test-user', ADMIN_PASSWORD: 'test-admin' };
  assert.deepEqual([loadEnv({ environment: production }).aiProvider, loadEnv({ environment: production }).aiFallbackProvider], ['gemini', null], '只有 Gemini 金鑰也能啟動');
}
test('AI 主要供應商預設 Gemini，另一家有金鑰時為備援，production 只要求主要供應商的金鑰', aiProviderConfig);

test('沒有 .env 時仍可使用平台參數；非法 PORT 被拒絕', () => {
  const config = loadEnv({ environment: { GEMINI_API_KEY: 'fake-key', DEMO_PASSWORD: 'test-only-password', ADMIN_PASSWORD: 'test-admin-only-password' }, envFile: '/nonexistent/helpdesk/.env' });
  assert.equal(config.geminiApiKey, 'fake-key');
  assert.equal(config.port, 3000);
  for (const port of ['abc', '0', '65536', '1.5']) {
    assert.throws(() => loadEnv({ environment: { NODE_ENV: 'production', PORT: port } }), /PORT/);
  }
});

/**
 * 驗證需求單儲存路徑：SQLite 預設在 storage/helpdesk.db、可用 DATABASE_FILE 覆寫；舊版匯入來源預設 storage/tickets.json、
 * 可用 TICKETS_FILE 覆寫；HTTP_QUERY_LIMIT 預設 60。
 * @returns {void}
 */
function ticketsFileConfig() {
  const envFile = '/nonexistent/helpdesk/.env';
  const base = { DEMO_PASSWORD: 'test-only-password', ADMIN_PASSWORD: 'test-admin-only-password' };
  const local = loadEnv({ environment: base, envFile });
  assert.match(local.databaseFile, /[\\/]storage[\\/]helpdesk\.db$/);
  assert.match(local.ticketsFile, /[\\/]storage[\\/]tickets\.json$/);
  assert.equal(local.httpQueryLimit, 60);
  assert.equal(loadEnv({ environment: { ...base, DATABASE_FILE: '/tmp/custom.db' }, envFile }).databaseFile, '/tmp/custom.db');
  assert.equal(loadEnv({ environment: { ...base, TICKETS_FILE: '/tmp/custom.json' }, envFile }).ticketsFile, '/tmp/custom.json');
  /** 嘗試無效的查詢限制。@returns {object} 設定。@throws {Error} 參數不是正整數。 */
  function invalid() { return loadEnv({ environment: { ...base, HTTP_QUERY_LIMIT: '0' }, envFile }); }
  assert.throws(invalid, /HTTP_QUERY_LIMIT/);
}
test('需求單檔案路徑與查詢限制設定', ticketsFileConfig);

/** 驗證只接受兩種模式，且限流儲存只用記憶體；密碼與舊儲存設定錯誤時明確拒絕。@returns {void} */
function productionMemory() {
  const environment = { NODE_ENV: 'production', GEMINI_API_KEY: 'fake-key', CORS_ORIGIN: 'https://example.github.io', AUTH_SECRET: 'x'.repeat(32), DEMO_PASSWORD: 'test-user', ADMIN_PASSWORD: 'test-admin' };
  assert.equal(loadEnv({ environment }).limitStore, 'memory');
  assert.equal(loadEnv({ environment: { ...environment, LIMIT_STORE: 'memory' } }).nodeEnv, 'production');
  /** 嘗試不支援的第三種環境。@returns {object} 設定。 */
  function invalidMode() { return loadEnv({ environment: { ...environment, NODE_ENV: 'development' } }); }
  /** 嘗試已移除的資料庫限流儲存。@returns {object} 設定。 */
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

/**
 * 驗證 TRUST_PROXY：未設定為 false、整數為跳數、loopback 等關鍵字與逗號分隔 IP／CIDR 照原字串交給 Express；
 * true／false 與無法編譯的值在 loadEnv 就以固定訊息拒絕，且訊息不回顯原始值。
 * @returns {void}
 */
function trustProxyConfig() {
  const envFile = '/nonexistent/helpdesk/.env';
  const base = { DEMO_PASSWORD: 'test-only-password', ADMIN_PASSWORD: 'test-admin-only-password' };
  /**
   * 以指定 TRUST_PROXY 載入設定。
   * @param {string|undefined} value 測試值。
   * @returns {number|string|false} 解析後的 trustProxy。
   */
  function trust(value) { return loadEnv({ environment: { ...base, ...(value === undefined ? {} : { TRUST_PROXY: value }) }, envFile }).trustProxy; }
  assert.equal(trust(undefined), false);
  assert.equal(trust('  '), false);
  assert.equal(trust('1'), 1);
  assert.equal(trust('loopback'), 'loopback');
  assert.equal(trust('loopback, linklocal, uniquelocal'), 'loopback, linklocal, uniquelocal');
  assert.equal(trust('10.0.0.0/8,192.0.2.1'), '10.0.0.0/8,192.0.2.1');
  for (const value of ['true', 'false', 'TRUE', 'not-an-ip-sentinel', '10.0.0.0/99', '1.5', 'loopback,,10.0.0.1']) {
    /** 嘗試無效的 TRUST_PROXY。@returns {number|string|false} 設定。@throws {Error} 格式無效。 */
    function invalid() { return trust(value); }
    /**
     * 檢查拒絕訊息使用固定前綴，且不回顯本次測試的原始 TRUST_PROXY 值。
     * @param {Error} error loadEnv 拋出的錯誤。
     * @returns {boolean} 訊息符合規則時為 true，否則 assert.throws 判定失敗。
     */
    function rejectsWithoutEcho(error) { return error.message.startsWith('TRUST_PROXY 格式無效') && !error.message.includes(value); }
    assert.throws(invalid, rejectsWithoutEcho, value);
  }
}
test('TRUST_PROXY 在載入時驗證，拒絕布林字串與無效位址', trustProxyConfig);

/**
 * 驗證 compose.yaml 的 backend.environment 不設定 NODE_ENV 與 CORS_ORIGIN（environment 會蓋過 env_file，讓 HELPDESK_ENV_FILE 指定的值失效），
 * 且根目錄 .env.example 仍以佔位或本機值記載這兩個參數。只讀取版本控制中的範本與設定檔，不讀任何 .env。
 * @returns {void}
 */
function composeEnvironmentSource() {
  const compose = readFileSync(new URL('../../compose.yaml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const backend = compose.slice(compose.indexOf('\n  backend:'), compose.indexOf('\n  web:'));
  assert.match(backend, /env_file: \$\{HELPDESK_ENV_FILE:-\.env\}/);
  const block = backend.slice(backend.indexOf('\n    environment:'), backend.indexOf('\n    volumes:'));
  assert.ok(block.includes('PORT: "3000"'), '找到 environment 區塊');
  for (const name of ['NODE_ENV', 'CORS_ORIGIN']) {
    assert.doesNotMatch(block, new RegExp(`^\\s+${name}:`, 'm'), `${name} 不可由 environment 覆寫 env_file`);
  }
  const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  assert.match(example, /^NODE_ENV=local$/m);
  assert.match(example, /^CORS_ORIGIN=http:\/\/localhost:8080$/m);
}
test('Compose 的 NODE_ENV 與 CORS_ORIGIN 只由 env_file 提供', composeEnvironmentSource);
