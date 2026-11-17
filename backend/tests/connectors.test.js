import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestEnv } from './helpers/testEnv.js';

setupTestEnv({ CORS_ORIGIN: 'http://localhost:5173' });
const { createSealer } = await import('../src/services/connectors/crypto.js');
const { createConnectorRegistry, createLazyRegistry, getConnectorRegistry } = await import('../src/services/connectors/registry.js');
const { createConnectionService, STATE_TTL_MS } = await import('../src/services/connectors/connectionService.js');
const { loadEnv } = await import('../src/config/env.js');
const { buildAuthorizeUrl, createGoogleOAuth, emailFromIdToken } = await import('../src/services/connectors/googleOAuth.js');
const { createSqliteDataStore, dataStore } = await import('../src/services/storage/dataStore.js');
const { openTicketDatabase, backupTicketDatabase, restoreTicketDatabase } = await import('../src/services/storage/database.js');
const { connectionKey, settingKey, parseConnection, parseSetting, serializeConnection } = await import('../src/services/connectors/metaRecords.js');
const { default: Database } = await import('better-sqlite3');
const { app } = await import('../src/server.js');
const { ACCOUNTS } = await import('../src/services/authService.js');

const SECRET = 'connectors-test-secret-0123456789abcdef';
// 測試用的假權杖與假用戶端，都不是實際值
const FAKE = Object.freeze({ clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'test-client-secret', refreshToken: 'test-refresh-token-value', accessToken: 'test-access-token-value' });

/**
 * 組出 Google 回傳的假 id_token（只有內容段有意義）
 * @param {string} email 帳號
 * @returns {string} 三段式字串
 */
function fakeIdToken(email) {
  return ['e30', Buffer.from(JSON.stringify({ email })).toString('base64url'), 'sig'].join('.');
}

/**
 * 建立假的 Google OAuth 用戶端，記錄每次呼叫；行為可在測試中改
 * @returns {object} 假用戶端與呼叫紀錄
 */
function fakeOAuth() {
  const calls = { exchange: [], refresh: [], revoke: [] };
  const behavior = { scope: '', refreshError: null, refreshToken: FAKE.refreshToken, email: 'racky@example.com', beforeRefresh: null, exchangeError: null };
  return {
    calls, behavior,
    /** 換權杖 @param {object} options 參數 @returns {Promise<object>} 權杖 */
    async exchangeCode(options) {
      calls.exchange.push(options);
      if (behavior.exchangeError) throw Object.assign(new Error('x'), { code: behavior.exchangeError });
      return { refreshToken: behavior.refreshToken, accessToken: FAKE.accessToken, expiresIn: 3600, email: emailFromIdToken(fakeIdToken(behavior.email)), scope: behavior.scope };
    },
    /** 更新存取權杖；beforeRefresh 可在回應前插入動作（模擬同一時間的其他請求） @param {object} options 參數 @returns {Promise<object>} 權杖 */
    async refresh(options) {
      calls.refresh.push(options);
      if (behavior.beforeRefresh) await behavior.beforeRefresh(options);
      if (behavior.refreshError && options.refreshToken !== behavior.validToken) throw Object.assign(new Error('x'), { code: behavior.refreshError });
      return { accessToken: `${FAKE.accessToken}-${calls.refresh.length}`, expiresIn: 3600 };
    },
    /** 撤銷 @param {string} token 權杖 @returns {Promise<boolean>} 成功 */
    async revoke(token) { calls.revoke.push(token); return true; },
  };
}

/**
 * 建立一組使用記憶體資料庫（或指定的資料庫檔）與假 Google 的連接服務；帳號一律可用，放進 inactive 的帳號視為停用
 * @param {string} [file=':memory:'] 資料庫檔
 * @param {object} [options={}] 選項
 * @param {string} [options.secret=SECRET] 加密金鑰（測試更換 AUTH_SECRET）
 * @param {object} [options.store] 沿用另一組的資料庫
 * @param {object} [options.registry] 連接器查詢（測試設定檔壞掉）
 * @returns {object} 服務、資料庫、假 Google、時鐘、停用帳號集合與日誌紀錄
 */
function harness(file = ':memory:', { secret = SECRET, store: shared, registry = getConnectorRegistry() } = {}) {
  const store = shared ?? createSqliteDataStore({ file });
  const oauth = fakeOAuth();
  const time = { now: Date.parse('2026-11-16T01:00:00Z') };
  const inactive = new Set();
  const logs = [];
  const accounts = { /** 停用的帳號回 null @param {string} username 帳號 @returns {object|null} 身分 */ find: (username) => (inactive.has(username) ? null : { username }) };
  const service = createConnectionService({ store, accounts, registry, sealer: createSealer(() => secret), oauth,
    publicAppUrl: 'https://example.test/helpdesk', clock: () => time.now,
    log: /** 記錄日誌 @param {string} level 等級 @param {string} event 事件 @param {object} fields 欄位 @returns {void} */ (level, event, fields) => { logs.push({ level, event, fields }); } });
  return { store, oauth, time, service, inactive, logs };
}

/**
 * 讀出並解析某帳號的行事曆連接紀錄
 * @param {object} store 資料存取
 * @param {string} username 帳號
 * @returns {object|null} 連接，沒有或格式不對時 null
 */
function recordOf(store, username) {
  return parseConnection(store.readConnectorRecord(connectionKey(username, 'google_calendar')), ['basic', 'advanced']);
}

/**
 * 組出一筆格式正確的行事曆連接紀錄（授權是用測試金鑰加密、綁在這個帳號名稱上的假權杖）
 * @param {string} username 紀錄所屬的帳號
 * @returns {string} JSON 字串
 */
function validRecord(username) {
  return serializeConnection({ accountEmail: 'someone@example.com', level: 'basic', scopes: 'openid email https://www.googleapis.com/auth/calendar.freebusy', clientId: FAKE.clientId,
    refreshTokenEnc: createSealer(() => SECRET).seal(FAKE.refreshToken, connectionKey(username, 'google_calendar')), status: 'ACTIVE', connectedAt: '2026-11-16T01:00:00.000Z', updatedAt: '2026-11-16T01:00:00.000Z' });
}

/**
 * 用功能上線前的 v1 舊格式（沒有 AAD）加密，只給測試組出舊資料
 * @param {string} text 明文
 * @returns {string} v1 密文
 */
function sealV1(text) {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET), Buffer.alloc(0), Buffer.from('helpdesk-connectors-v1'), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(':');
}

/** 從連接器清單找行事曆 @param {object[]} list 清單 @returns {object} 行事曆 */
function calendarOf(list) { return list.find(/** 找行事曆 @param {{id: string}} item 連接器 @returns {boolean} 是時 true */ (item) => item.id === 'google_calendar'); }

/**
 * 走完一次行事曆連接（假 Google）：本人發起，Google 導回前端頁後由本人送出授權碼
 * @param {object} service 連接服務
 * @param {string} username 帳號
 * @param {string} [level='basic'] 權限等級
 * @returns {Promise<string>} 結果代碼
 */
async function connect(service, username, level = 'basic') {
  const params = paramsOf(service.startConnect(username, 'google_calendar', level).authorize_url);
  return (await service.completeConnect(username, { state: params.get('state'), code: 'c' })).result;
}

/** 解開某帳號行事曆連接的授權（測試金鑰） @param {object} row 連接 @param {string} username 帳號 @returns {string} 明文 */
function openToken(row, username) { return createSealer(() => SECRET).open(row.refreshTokenEnc, connectionKey(username, 'google_calendar')); }

/**
 * 從授權網址取出查詢參數
 * @param {string} href 授權網址
 * @returns {URLSearchParams} 參數
 */
function paramsOf(href) { return new URL(href).searchParams; }

/**
 * 取得例外的 HTTP 狀態與代碼
 * @param {Function} run 會拋出的函式
 * @returns {{status: number, code: string}} 狀態與代碼
 */
function failureOf(run) {
  try { run(); } catch (error) { return { status: error.status, code: error.code }; }
  return assert.fail('應該拋出例外');
}

test('授權加密：v2 綁 meta 名稱，換名稱、內容被改、換了金鑰、格式不符、驗證標籤長度不對都拒絕；沒有 AAD 的 v1 舊格式一律拒絕；金鑰太短不加密', () => {
  const sealer = createSealer(() => SECRET);
  const name = connectionKey('ann.lee', 'google_calendar');
  const sealed = sealer.seal(FAKE.refreshToken, name);
  assert.match(sealed, /^v2:/);
  assert.ok(!sealed.includes(FAKE.refreshToken), '密文不含原文');
  assert.notEqual(sealer.seal(FAKE.refreshToken, name), sealed, '每次加密的 IV 不同');
  assert.equal(sealer.open(sealed, name), FAKE.refreshToken);
  assert.throws(() => sealer.open(sealed, connectionKey('bob.chen', 'google_calendar')), { code: 'SEAL_INVALID' }, '複製到別人的名稱底下解不開');
  assert.throws(() => sealer.open(sealed), { code: 'SEAL_INVALID' }, 'v2 一定要給名稱');
  assert.throws(() => sealer.seal('x'), TypeError, '加密一定要給名稱');
  const parts = sealed.split(':');
  const flipped = parts[3][0] === 'A' ? `B${parts[3].slice(1)}` : `A${parts[3].slice(1)}`;
  assert.throws(() => sealer.open([...parts.slice(0, 3), flipped].join(':'), name), { code: 'SEAL_INVALID' });
  assert.throws(() => sealer.open([parts[0], parts[1], parts[2].slice(0, 6), parts[3]].join(':'), name), { code: 'SEAL_INVALID' }, '驗證標籤被截短');
  assert.throws(() => createSealer(() => `${SECRET}-other`).open(sealed, name), { code: 'SEAL_INVALID' });
  assert.throws(() => sealer.open('not-sealed', name), { code: 'SEAL_INVALID' });
  assert.throws(() => createSealer(() => 'short').seal('x', name), { code: 'SEAL_KEY_MISSING' });

  assert.throws(() => sealer.open(sealV1(FAKE.refreshToken), name), { code: 'SEAL_INVALID' }, 'v1 搬到別人名下也解得開，所以不再接受');
});

test('連接器設定檔：正式設定可以載入；格式錯誤時指出鍵路徑', () => {
  const registry = getConnectorRegistry();
  assert.deepEqual(registry.list().map(/** 取 id 與狀態 @param {object} item 連接器 @returns {string} 摘要 */ (item) => `${item.id}:${item.status}`), ['google_calendar:available', 'gmail:planned', 'microsoft_365:planned']);
  const calendar = registry.find('google_calendar');
  assert.deepEqual(registry.level(calendar, 'basic').tools, ['calendar_busy']);
  assert.ok(registry.level(calendar, 'basic').scopes.includes('https://www.googleapis.com/auth/calendar.freebusy'));
  assert.ok(!registry.level(calendar, 'basic').scopes.some(/** 基本等級不讀行程內容 @param {string} scope 範圍 @returns {boolean} 讀行程時 true */ (scope) => scope.includes('events')));
  assert.throws(() => createConnectorRegistry({ raw: { connectors: [{ id: 'x_y', status: 'available', name: 'X', description: '', provider: 'google', levels: [] }] } }), /connectors\[0\]\.levels/);
  assert.throws(() => createConnectorRegistry({ raw: { connectors: [{ id: 'Bad', status: 'planned', name: 'X', description: '' }] } }), /connectors\[0\]\.id/);
});

test('授權網址：授權碼流程、PKCE S256、離線存取、每次顯示同意畫面', () => {
  const params = paramsOf(buildAuthorizeUrl({ clientId: FAKE.clientId, redirectUri: 'https://example.test/cb', scopes: ['openid', 'email'], state: 'st', codeChallenge: 'ch' }));
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('access_type'), 'offline');
  assert.equal(params.get('prompt'), 'consent');
  assert.equal(params.get('scope'), 'openid email');
  assert.equal(emailFromIdToken(fakeIdToken('a@b.c')), 'a@b.c');
  assert.equal(emailFromIdToken('broken'), '');
});

test('管理員設定：未設定時不能連接；client secret 加密保存且永遠不回傳', () => {
  const { store, service } = harness();
  assert.deepEqual(failureOf(() => service.startConnect(ACCOUNTS[0], 'google_calendar', 'basic')), { status: 409, code: 'CONNECTOR_NOT_CONFIGURED' });
  assert.deepEqual(failureOf(() => service.saveAdminSettings('google_calendar', { client_id: 'has space', client_secret: 'x' }, 'alex.admin')), { status: 400, code: 'INVALID_PAYLOAD' });
  assert.deepEqual(failureOf(() => service.saveAdminSettings('gmail', { client_id: 'a', client_secret: 'b' }, 'alex.admin')), { status: 409, code: 'CONNECTOR_PLANNED' });
  const saved = service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  assert.deepEqual(Object.keys(saved).sort(), ['client_id', 'configured', 'connector_id', 'redirect_uri', 'updated_at', 'updated_by']);
  assert.equal(saved.configured, true);
  assert.equal(saved.redirect_uri, 'https://example.test/helpdesk/pages/connections/connections.html', '回呼網址是前端的連接帳號頁');
  assert.ok(!JSON.stringify(saved).includes(FAKE.clientSecret));
  assert.ok(!store.readConnectorRecord(settingKey('google_calendar')).includes(FAKE.clientSecret), '資料庫只存密文');
  assert.equal(parseSetting(store.readConnectorRecord(settingKey('google_calendar'))).updatedBy, 'alex.admin');
});

test('連接流程：state 只能用一次、PKCE 對得上、授權加密保存並記下用戶端；拒絕與過期回對應的結果', async () => {
  const { store, oauth, time, service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  const user = ACCOUNTS[0];
  assert.deepEqual(failureOf(() => service.startConnect(user, 'google_calendar', 'premium')), { status: 400, code: 'INVALID_PAYLOAD' });
  assert.deepEqual(failureOf(() => service.startConnect(user, 'gmail', 'basic')), { status: 409, code: 'CONNECTOR_PLANNED' });
  assert.deepEqual(failureOf(() => service.startConnect(user, 'nope', 'basic')), { status: 404, code: 'CONNECTOR_NOT_FOUND' });

  assert.deepEqual(await service.completeConnect(user, { state: 'unknown', code: 'c' }), { result: 'expired', connector: null });
  const denied = paramsOf(service.startConnect(user, 'google_calendar', 'basic').authorize_url);
  assert.deepEqual(await service.completeConnect(user, { state: denied.get('state'), error: 'access_denied' }), { result: 'denied', connector: 'google_calendar' });

  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  const params = paramsOf(service.startConnect(user, 'google_calendar', 'basic').authorize_url);
  assert.equal(params.get('client_id'), FAKE.clientId);
  assert.equal(params.get('redirect_uri'), 'https://example.test/helpdesk/pages/connections/connections.html');
  assert.deepEqual(await service.completeConnect(user, { state: params.get('state'), code: 'auth-code' }), { result: 'connected', connector: 'google_calendar' });
  const exchanged = oauth.calls.exchange.at(-1);
  assert.equal(createHash('sha256').update(exchanged.codeVerifier).digest('base64url'), params.get('code_challenge'), 'PKCE 驗證碼對得上');
  const row = recordOf(store, user);
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.accountEmail, 'racky@example.com');
  assert.equal(row.clientId, FAKE.clientId, '記下授權當時的用戶端');
  assert.equal(openToken(row, user), FAKE.refreshToken);
  assert.ok(!store.readConnectorRecord(connectionKey(user, 'google_calendar')).includes(FAKE.refreshToken), '資料庫只存密文');
  assert.equal((await service.completeConnect(user, { state: params.get('state'), code: 'auth-code' })).result, 'expired', '同一個 state 不能再用');

  const listed = service.list(user).find(/** 找行事曆 @param {{id: string}} item 連接器 @returns {boolean} 是時 true */ (item) => item.id === 'google_calendar');
  assert.deepEqual(listed.connection, { status: 'ACTIVE', account_email: 'racky@example.com', level: 'basic', connected_at: row.connectedAt });
  assert.equal(listed.configured, true);
  assert.ok(!JSON.stringify(service.list(user)).includes('scopes'), '清單不列 scopes 與權杖');
  assert.equal(service.list(ACCOUNTS[1]).find(/** 找行事曆 @param {{id: string}} item 連接器 @returns {boolean} 是時 true */ (item) => item.id === 'google_calendar').connection.status, 'NOT_CONNECTED', '別人看不到這筆連接');

  const late = paramsOf(service.startConnect(user, 'google_calendar', 'basic').authorize_url);
  time.now += STATE_TTL_MS + 1;
  assert.equal((await service.completeConnect(user, { state: late.get('state'), code: 'auth-code' })).result, 'expired', '超過 10 分鐘的 state 失效');
});

test('使用者只勾了部分權限時撤銷並不保存', async () => {
  const { store, oauth, service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  oauth.behavior.scope = 'openid email';
  const params = paramsOf(service.startConnect(ACCOUNTS[0], 'google_calendar', 'basic').authorize_url);
  assert.equal((await service.completeConnect(ACCOUNTS[0], { state: params.get('state'), code: 'c' })).result, 'partial');
  assert.deepEqual(oauth.calls.revoke, [FAKE.refreshToken], '原本沒有連接時撤銷這次的授權');
  assert.equal(store.readConnectorRecord(connectionKey(ACCOUNTS[0], 'google_calendar')), null);
});

test('存取權杖：先用快取，過期才更新；授權被撤銷時改成需要重新連接；中斷連接會撤銷並刪除', async () => {
  const { store, oauth, time, service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  const user = ACCOUNTS[0];
  await assert.rejects(service.accessFor(user, 'google_calendar'), { code: 'CONNECTOR_NOT_CONNECTED' });
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  assert.equal(await connect(service, user), 'connected');

  const first = await service.accessFor(user, 'google_calendar');
  assert.equal(first.accessToken, FAKE.accessToken);
  assert.deepEqual(first.level.tools, ['calendar_busy']);
  assert.equal(oauth.calls.refresh.length, 0, '換權杖時拿到的存取權杖先用');
  time.now += 3600 * 1000;
  assert.equal((await service.accessFor(user, 'google_calendar')).accessToken, `${FAKE.accessToken}-1`);
  assert.equal(oauth.calls.refresh[0].refreshToken, FAKE.refreshToken, '用解密後的 refresh token 換新');

  time.now += 3600 * 1000;
  oauth.behavior.refreshError = 'OAUTH_INVALID_GRANT';
  await assert.rejects(service.accessFor(user, 'google_calendar'), { code: 'CONNECTOR_NEEDS_RECONNECT' });
  assert.equal(recordOf(store, user).status, 'NEEDS_RECONNECT');
  await assert.rejects(service.accessFor(user, 'google_calendar'), { code: 'CONNECTOR_NEEDS_RECONNECT' });

  assert.deepEqual(await service.disconnect(user, 'google_calendar'), { disconnected: true, revoked: true });
  assert.equal(oauth.calls.revoke.at(-1), FAKE.refreshToken);
  assert.equal(store.readConnectorRecord(connectionKey(user, 'google_calendar')), null);
  assert.deepEqual(await service.disconnect(user, 'google_calendar'), { disconnected: false, revoked: false });
});

test('meta 名稱：一律組出完整名稱逐筆讀；帳號 user_a 讀不到 userXa 的紀錄；只能讀寫連接器用的名稱', async () => {
  const { store, service } = harness();
  assert.equal(connectionKey('user_a', 'google_calendar'), 'connector_user:user_a:google_calendar');
  assert.equal(settingKey('google_calendar'), 'connector_setting:google_calendar');
  assert.throws(() => connectionKey('a:b', 'google_calendar'), { code: 'CONNECTOR_KEY_INVALID' }, '帳號含冒號會和分隔符號混淆');
  assert.throws(() => connectionKey('user_a', 'Bad:id'), { code: 'CONNECTOR_KEY_INVALID' });
  assert.throws(() => store.readConnectorRecord('local_auth_secret'), { code: 'CONNECTOR_KEY_INVALID' }, '不能讀到本機登入金鑰');
  assert.throws(() => store.writeConnectorRecord('legacy_import', '{}'), { code: 'CONNECTOR_KEY_INVALID' });

  for (const other of ['userXa', 'user_ab', 'ann.leex']) store.writeConnectorRecord(connectionKey(other, 'google_calendar'), validRecord(other));
  for (const [mine, other] of [['user_a', 'userXa'], ['user_a', 'user_ab'], ['ann.lee', 'ann.leex']]) {
    assert.equal(store.readConnectorRecord(connectionKey(mine, 'google_calendar')), null, `${mine} 的名稱讀不到 ${other}`);
    assert.equal(calendarOf(service.list(mine)).connection.status, 'NOT_CONNECTED', `${mine} 的清單看不到 ${other} 的連接`);
    await assert.rejects(service.accessFor(mine, 'google_calendar'), { code: 'CONNECTOR_NOT_CONNECTED' }, `${mine} 拿不到 ${other} 的權杖`);
    assert.equal(calendarOf(service.list(other)).connection.status, 'ACTIVE');
  }

  // 對照：若用 LIKE 前綴掃描，底線是萬用字元，user_a 會讀到 userXa；所以資料存取層不得出現這類查詢
  const scratchDb = new Database(':memory:');
  try {
    scratchDb.exec('CREATE TABLE meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
    scratchDb.prepare('INSERT INTO meta (name, value) VALUES (?, ?)').run(connectionKey('userXa', 'google_calendar'), '{}');
    assert.equal(scratchDb.prepare('SELECT COUNT(*) AS total FROM meta WHERE name LIKE ?').get('connector_user:user_a:%').total, 1, 'LIKE 前綴掃描會讀到別人');
  } finally { scratchDb.close(); }
  const source = readFileSync(new URL('../src/services/storage/dataStore.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /FROM meta WHERE[^'`]*(LIKE|GLOB|substr|>=|BETWEEN)/i, '讀 meta 只用 name = ?');
});

test('格式驗證：meta 讀出的值不對時當成沒有連接或尚未設定，寫一行日誌，服務不中斷', async () => {
  const { store, service, logs } = harness();
  const user = ACCOUNTS[0];
  const good = JSON.parse(validRecord(user));
  const broken = {
    '不是 JSON': '{oops',
    '是陣列': '[]',
    '缺 scopes 欄位': JSON.stringify({ ...good, scopes: undefined }),
    '權限等級不在設定檔': JSON.stringify({ ...good, level: 'premium' }),
    '狀態不在清單': JSON.stringify({ ...good, status: 'REVOKED' }),
    '授權不是密文格式': JSON.stringify({ ...good, refresh_token_enc: 'plain-token-value' }),
    '時間不是 ISO 格式': JSON.stringify({ ...good, connected_at: 'yesterday' }),
  };
  for (const [label, raw] of Object.entries(broken)) {
    store.writeConnectorRecord(connectionKey(user, 'google_calendar'), raw);
    logs.length = 0;
    assert.equal(calendarOf(service.list(user)).connection.status, 'NOT_CONNECTED', label);
    assert.deepEqual(logs.map(/** 取事件 @param {{event: string}} entry 日誌 @returns {string} 事件 */ (entry) => entry.event), ['connectors.record_invalid'], `${label}：只寫一行日誌`);
    await assert.rejects(service.accessFor(user, 'google_calendar'), { code: 'CONNECTOR_NOT_CONNECTED' }, label);
  }
  assert.ok(!JSON.stringify(logs).includes('plain-token-value'), '日誌不含紀錄內容');
  assert.deepEqual(await service.disconnect(user, 'google_calendar'), { disconnected: true, revoked: false }, '格式不對的紀錄照樣能清掉');
  assert.equal(store.readConnectorRecord(connectionKey(user, 'google_calendar')), null);

  store.writeConnectorRecord(settingKey('google_calendar'), JSON.stringify({ client_id: FAKE.clientId, client_secret_enc: 'plain', updated_by: 'alex.admin', updated_at: '2026-11-16T01:00:00.000Z' }));
  assert.equal(service.adminSettings('google_calendar').configured, false, '設定格式不對時當成尚未設定');
  assert.deepEqual(failureOf(() => service.startConnect(user, 'google_calendar', 'basic')), { status: 409, code: 'CONNECTOR_NOT_CONFIGURED' });
});

test('帳號停用：回呼不保存授權；已連接的帳號停用後取不到權杖（快取的也不給），恢復後照常', async () => {
  const { store, oauth, service, inactive } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  const [user, other] = ACCOUNTS;
  assert.equal(await connect(service, user), 'connected');
  assert.equal((await service.accessFor(user, 'google_calendar')).accessToken, FAKE.accessToken);

  inactive.add(user);
  await assert.rejects(service.accessFor(user, 'google_calendar'), { code: 'CONNECTOR_ACCOUNT_INACTIVE' });
  assert.equal(oauth.calls.refresh.length, 0, '停用時不向 Google 換權杖');
  assert.equal(recordOf(store, user).status, 'ACTIVE', '停用不刪除授權，帳號恢復後可以直接用');
  inactive.delete(user);
  assert.equal((await service.accessFor(user, 'google_calendar')).accessToken, FAKE.accessToken, '恢復後照常');

  const params = paramsOf(service.startConnect(other, 'google_calendar', 'basic').authorize_url);
  const exchanged = oauth.calls.exchange.length;
  inactive.add(other);
  assert.equal((await service.completeConnect(other, { state: params.get('state'), code: 'c' })).result, 'failed');
  assert.equal(oauth.calls.exchange.length, exchanged, '停用的帳號不換授權碼');
  assert.equal(store.readConnectorRecord(connectionKey(other, 'google_calendar')), null, '停用的帳號不保存授權');
});

test('備份與還原：連接紀錄與管理設定跟著資料庫一起備份、還原', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'helpdesk-connectors-'));
  const file = join(scratch, 'helpdesk.db');
  const backup = join(scratch, 'helpdesk-backup.db');
  try {
    const first = harness(file);
    first.service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
    first.oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
    assert.equal(await connect(first.service, ACCOUNTS[0]), 'connected');
    const reader = openTicketDatabase(file, { readonly: true });
    try { backupTicketDatabase(reader, backup); } finally { reader.close(); }
    await first.service.disconnect(ACCOUNTS[0], 'google_calendar');
    assert.equal(first.store.readConnectorRecord(connectionKey(ACCOUNTS[0], 'google_calendar')), null, '備份後刪掉，模擬資料遺失');
    first.store.close();

    restoreTicketDatabase(file, backup, '20261115-000000');
    const second = harness(file);
    try {
      assert.equal(calendarOf(second.service.list(ACCOUNTS[0])).connection.status, 'ACTIVE', '還原後連接回來');
      assert.equal(second.service.adminSettings('google_calendar').client_id, FAKE.clientId, '還原後管理設定回來');
      assert.equal((await second.service.accessFor(ACCOUNTS[0], 'google_calendar')).accessToken, `${FAKE.accessToken}-1`);
      assert.equal(second.oauth.calls.refresh[0].refreshToken, FAKE.refreshToken, '還原後的授權解得開');
    } finally { second.store.close(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('連接器設定檔壞掉或不見：只有連接功能回 503，寫一行錯誤日誌；修好後不用重啟就恢復', () => {
  const logs = [];
  const state = { broken: true };
  const registry = createLazyRegistry({
    load: /** 模擬設定檔不見 @returns {object} 連接器查詢 */ () => {
      if (state.broken) throw Object.assign(new Error('connectors.json 不存在'), { code: 'ENOENT' });
      return getConnectorRegistry();
    },
    log: /** 記錄日誌 @param {string} level 等級 @param {string} event 事件 @param {object} fields 欄位 @returns {void} */ (level, event, fields) => { logs.push({ level, event, fields }); },
  });
  assert.deepEqual(logs.map(/** 摘要 @param {object} entry 日誌 @returns {string} 摘要 */ (entry) => `${entry.level}:${entry.event}:${entry.fields.reason}`), ['error:connectors.config_failed:ENOENT'], '建立時不拋出，只寫一行錯誤日誌');
  const { service } = harness(':memory:', { registry });
  assert.deepEqual(failureOf(() => service.list(ACCOUNTS[0])), { status: 503, code: 'CONNECTORS_UNAVAILABLE' });
  assert.deepEqual(failureOf(() => service.startConnect(ACCOUNTS[0], 'google_calendar', 'basic')), { status: 503, code: 'CONNECTORS_UNAVAILABLE' });
  state.broken = false;
  assert.equal(calendarOf(service.list(ACCOUNTS[0])).connection.status, 'NOT_CONNECTED', '設定檔修好後下一個請求就恢復');
});

test('部署：Dockerfile 不改；連接器設定檔放在 src 底下，由既有的 COPY src ./src 帶進映像', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^COPY src \.\/src$/m, '既有的 Dockerfile 整包複製 src');
  assert.doesNotMatch(dockerfile, /connectors/, 'Dockerfile 沒有為連接功能多加任何一行');
  assert.ok(existsSync(new URL('../src/services/connectors/connectors.json', import.meta.url)), '設定檔在 src 底下');
  assert.ok(!existsSync(new URL('../data/connectors.json', import.meta.url)), 'data 底下沒有另一份');
  const ignored = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
  assert.doesNotMatch(ignored, /connectors|\*\.json|^src/m, '.dockerignore 沒有排除這個檔');
});

test('Google 導回的網址：前端開發伺服器直接用來源；Docker 本機測試與正式環境加 /helpdesk', () => {
  const envFile = '/nonexistent/helpdesk/.env';
  const base = { DEMO_PASSWORD: 'test-only-password', ADMIN_PASSWORD: 'test-admin-only-password' };
  /** 依環境參數算出 publicAppUrl @param {object} environment 參數 @returns {string} 網址 */
  const urlOf = (environment) => loadEnv({ environment: { ...base, ...environment }, envFile }).publicAppUrl;
  assert.equal(urlOf({}), 'http://localhost:5173', '沒填 CORS_ORIGIN 時是前端開發伺服器');
  assert.equal(urlOf({ CORS_ORIGIN: 'http://localhost:5173' }), 'http://localhost:5173');
  assert.equal(urlOf({ CORS_ORIGIN: 'http://localhost:8080' }), 'http://localhost:8080/helpdesk', 'Docker 本機測試（根目錄 .env.example 的預設）');
  assert.equal(urlOf({ NODE_ENV: 'production', AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake-cloud-key', AUTH_SECRET: 'a'.repeat(32), CORS_ORIGIN: 'https://helpdesk.example.com' }), 'https://helpdesk.example.com/helpdesk');
  assert.equal(urlOf({ CORS_ORIGIN: 'http://localhost:8080', PUBLIC_APP_URL: 'http://127.0.0.1:8080/helpdesk/' }), 'http://127.0.0.1:8080/helpdesk', '明確設定時照用，去掉結尾斜線');
  assert.throws(() => urlOf({ PUBLIC_APP_URL: 'http://example.test/helpdesk?a=1' }), /PUBLIC_APP_URL/);
});

test('從基本改成進階卻沒勾齊：不撤銷（Google 撤銷會連原本的連接一起失效），原本的基本連接照舊', async () => {
  const { store, oauth, service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  const user = ACCOUNTS[0];
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  assert.equal(await connect(service, user), 'connected');
  const params = paramsOf(service.startConnect(user, 'google_calendar', 'advanced').authorize_url);
  oauth.behavior.refreshToken = 'second-refresh-token';
  assert.equal((await service.completeConnect(user, { state: params.get('state'), code: 'c' })).result, 'partial');
  assert.deepEqual(oauth.calls.revoke, [], '已有同一個 Google 帳號的連接時不撤銷');
  const row = recordOf(store, user);
  assert.equal(row.level, 'basic');
  assert.equal(row.status, 'ACTIVE');
  assert.equal(openToken(row, user), FAKE.refreshToken, '保留原本的授權');
});

test('換權杖失敗時本人剛好重新連接：不把新的連接標成需要重新連接，改用新的授權', async () => {
  const { store, oauth, time, service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  const user = ACCOUNTS[0];
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  await connect(service, user);
  time.now += 3600 * 1000;
  Object.assign(oauth.behavior, { refreshError: 'OAUTH_INVALID_GRANT', validToken: 'second-refresh-token', refreshToken: 'second-refresh-token' });
  oauth.behavior.beforeRefresh = /** 舊授權換權杖途中，本人完成重新連接 @param {{refreshToken: string}} options 參數 @returns {Promise<void>} 完成 */ async (options) => {
    if (options.refreshToken !== FAKE.refreshToken) return;
    oauth.behavior.beforeRefresh = null;
    await connect(service, user);
  };
  const result = await service.accessFor(user, 'google_calendar');
  assert.equal(recordOf(store, user).status, 'ACTIVE', '新的連接沒有被誤標');
  assert.equal(openToken(recordOf(store, user), user), 'second-refresh-token');
  assert.equal(result.accessToken, FAKE.accessToken, '改用重新連接時拿到的存取權杖');
});

test('更換 AUTH_SECRET：舊密文解不開，管理頁顯示尚未設定；重新儲存後，舊的連接第一次使用就變成需要重新連接', async () => {
  const first = harness();
  first.service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  first.oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  await connect(first.service, ACCOUNTS[0]);
  const second = harness(':memory:', { secret: `${SECRET}-rotated`, store: first.store });
  const viewed = second.service.adminSettings('google_calendar');
  assert.equal(viewed.configured, false, '設定還在但解不開，提示管理員重新儲存');
  assert.equal(viewed.client_id, FAKE.clientId, 'client id 照樣顯示');
  assert.equal(calendarOf(second.service.list(ACCOUNTS[0])).configured, false);
  assert.deepEqual(failureOf(() => second.service.startConnect(ACCOUNTS[0], 'google_calendar', 'basic')), { status: 409, code: 'CONNECTOR_NOT_CONFIGURED' });
  second.service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  assert.equal(second.service.adminSettings('google_calendar').configured, true);
  await assert.rejects(second.service.accessFor(ACCOUNTS[0], 'google_calendar'), { code: 'CONNECTOR_NEEDS_RECONNECT' });
  assert.equal(recordOf(first.store, ACCOUNTS[0]).status, 'NEEDS_RECONNECT');
});

test('完成連接必須是發起的本人：別人用自己的 Google 按允許，授權不會存進發起人的帳號', async () => {
  const { store, oauth, service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  const [owner, stranger] = ACCOUNTS;
  const params = paramsOf(service.startConnect(owner, 'google_calendar', 'basic').authorize_url);
  oauth.behavior.email = 'stranger@example.com';
  assert.deepEqual(await service.completeConnect(stranger, { state: params.get('state'), code: 'strangers-code' }), { result: 'mismatch', connector: 'google_calendar' });
  assert.equal(oauth.calls.exchange.length, 0, '不換授權碼');
  assert.equal(store.readConnectorRecord(connectionKey(owner, 'google_calendar')), null, '發起人的帳號沒有存進任何授權');
  assert.equal(store.readConnectorRecord(connectionKey(stranger, 'google_calendar')), null);
  assert.equal((await service.completeConnect(owner, { state: params.get('state'), code: 'strangers-code' })).result, 'expired', 'state 已作廢，發起人拿到別人的授權碼也不能完成');
  assert.equal(oauth.calls.exchange.length, 0);
});

test('state：同一帳號同一連接器只留最新一筆，一個人連按很多次也不會佔滿全站', async () => {
  const { service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  const first = paramsOf(service.startConnect(ACCOUNTS[0], 'google_calendar', 'basic').authorize_url).get('state');
  for (let round = 0; round < 600; round += 1) service.startConnect(ACCOUNTS[0], 'google_calendar', 'basic');
  assert.match(service.startConnect(ACCOUNTS[1], 'google_calendar', 'basic').authorize_url, /^https:\/\/accounts\.google\.com\//, '別人照樣能發起，不會 429');
  assert.equal((await service.completeConnect(ACCOUNTS[0], { state: first, code: 'c' })).result, 'expired', '舊的 state 已作廢');
});

test('重新連接：換成另一個 Google 帳號時撤銷舊的授權；同一個 Google 帳號時不撤銷', async () => {
  const { store, oauth, service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  const user = ACCOUNTS[0];
  assert.equal(await connect(service, user), 'connected');
  oauth.behavior.refreshToken = 'same-account-token';
  assert.equal(await connect(service, user), 'connected');
  assert.deepEqual(oauth.calls.revoke, [], '同一個 Google 帳號不撤銷（Google 會連新的一起撤銷）');
  Object.assign(oauth.behavior, { email: 'another@example.com', refreshToken: 'another-account-token' });
  assert.equal(await connect(service, user), 'connected');
  assert.deepEqual(oauth.calls.revoke, ['same-account-token'], '換成另一個 Google 帳號時撤銷舊的');
  assert.equal(openToken(recordOf(store, user), user), 'another-account-token');
});

test('換到授權後寫入失敗：撤銷這次的授權並回 failed；本人原本已連接同一個 Google 帳號時不撤銷；資料庫讀不到也只回 failed', async () => {
  const base = createSqliteDataStore({ file: ':memory:' });
  const flags = { failWrites: false, failReads: false };
  const store = {
    ...base,
    /** 可以模擬寫入失敗 @param {string} name 名稱 @param {string} value 值 @returns {void} */
    writeConnectorRecord(name, value) {
      if (flags.failWrites && name.startsWith('connector_user:')) throw Object.assign(new Error('寫入失敗'), { code: 'SQLITE_FULL' });
      return base.writeConnectorRecord(name, value);
    },
    /** 可以模擬讀取失敗 @param {string} name 名稱 @returns {string|null} 值 */
    readConnectorRecord(name) {
      if (flags.failReads) throw Object.assign(new Error('暫時無法讀取'), { status: 503, code: 'TICKET_STORE_UNAVAILABLE' });
      return base.readConnectorRecord(name);
    },
  };
  const { oauth, service } = harness(':memory:', { store });
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  const user = ACCOUNTS[0];
  Object.assign(flags, { failWrites: true });
  oauth.behavior.refreshToken = 'unsaved-token';
  assert.equal(await connect(service, user), 'failed');
  assert.deepEqual(oauth.calls.revoke, ['unsaved-token'], '沒存起來的授權要撤銷');

  Object.assign(flags, { failWrites: false });
  oauth.behavior.refreshToken = FAKE.refreshToken;
  assert.equal(await connect(service, user), 'connected');
  Object.assign(flags, { failWrites: true });
  oauth.behavior.refreshToken = 'second-unsaved-token';
  assert.equal(await connect(service, user), 'failed');
  assert.deepEqual(oauth.calls.revoke, ['unsaved-token'], '已連接同一個 Google 帳號時不撤銷');
  Object.assign(flags, { failWrites: false });
  assert.equal(openToken(recordOf(store, user), user), FAKE.refreshToken, '原本的連接照舊');

  const params = paramsOf(service.startConnect(user, 'google_calendar', 'basic').authorize_url);
  Object.assign(flags, { failReads: true });
  assert.deepEqual(await service.completeConnect(user, { state: params.get('state'), code: 'c' }), { result: 'failed', connector: 'google_calendar' }, '不拋出例外，頁面照樣顯示失敗');
});

test('換權杖途中本人中斷連接：不寫快取、不給權杖', async () => {
  const { oauth, time, service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  const user = ACCOUNTS[0];
  assert.equal(await connect(service, user), 'connected');
  time.now += 3600 * 1000;
  oauth.behavior.beforeRefresh = /** 換權杖途中本人按了中斷連接 @returns {Promise<void>} 完成 */ async () => {
    oauth.behavior.beforeRefresh = null;
    await service.disconnect(user, 'google_calendar');
  };
  await assert.rejects(service.accessFor(user, 'google_calendar'), { code: 'CONNECTOR_NOT_CONNECTED' });
  await assert.rejects(service.accessFor(user, 'google_calendar'), { code: 'CONNECTOR_NOT_CONNECTED' }, '快取裡也沒有');
});

test('管理員換了 OAuth 用戶端：舊用戶端時期的連接顯示需要重新連接，工具拿不到權杖；Google 回 unauthorized_client 同樣處理', async () => {
  const { store, oauth, time, service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  const user = ACCOUNTS[0];
  assert.equal(await connect(service, user), 'connected');
  service.saveAdminSettings('google_calendar', { client_id: 'replaced-client.apps.googleusercontent.com', client_secret: 'replaced-client-secret' }, 'alex.admin');
  assert.equal(calendarOf(service.list(user)).connection.status, 'NEEDS_RECONNECT', '畫面顯示需要重新連接');
  await assert.rejects(service.accessFor(user, 'google_calendar'), { code: 'CONNECTOR_NEEDS_RECONNECT' }, '快取的權杖也不給');
  assert.equal(recordOf(store, user).status, 'NEEDS_RECONNECT');
  assert.equal(oauth.calls.refresh.length, 0, '不拿舊授權去試新的用戶端');

  assert.equal(await connect(service, user), 'connected', '用新的用戶端重新連接');
  assert.equal(recordOf(store, user).clientId, 'replaced-client.apps.googleusercontent.com');
  time.now += 3600 * 1000;
  oauth.behavior.refreshError = 'OAUTH_UNAUTHORIZED_CLIENT';
  await assert.rejects(service.accessFor(user, 'google_calendar'), { code: 'CONNECTOR_NEEDS_RECONNECT' });
  assert.equal(recordOf(store, user).status, 'NEEDS_RECONNECT');

  const google = createGoogleOAuth({ fetchImpl: /** 假的 Google 權杖端點 @returns {Promise<Response>} 回應 */ async () => new Response(JSON.stringify({ error: 'unauthorized_client' }), { status: 400, headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(google.refresh({ clientId: 'a', clientSecret: 'b', refreshToken: 'c' }), { code: 'OAUTH_UNAUTHORIZED_CLIENT' }, 'Google 的 unauthorized_client 轉成固定代碼');
});

test('把別人的授權密文複製到自己的名稱底下：解不開，變成需要重新連接，拿不到別人的權杖', async () => {
  const { store, oauth, service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  const [victim, copier] = ACCOUNTS;
  assert.equal(await connect(service, victim), 'connected');
  store.writeConnectorRecord(connectionKey(copier, 'google_calendar'), store.readConnectorRecord(connectionKey(victim, 'google_calendar')));
  await assert.rejects(service.accessFor(copier, 'google_calendar'), { code: 'CONNECTOR_NEEDS_RECONNECT' });
  assert.equal(oauth.calls.refresh.length, 0, '沒有拿別人的授權向 Google 換權杖');
  assert.equal(recordOf(store, copier).status, 'NEEDS_RECONNECT');
  assert.equal((await service.accessFor(victim, 'google_calendar')).accessToken, FAKE.accessToken, '本人的連接不受影響');
});

test('舊紀錄（沒有 client_id 或授權是 v1 密文）：當成需要重新連接，不寫格式不對的日誌；中斷連接照樣刪除，解得開的照樣撤銷；v1 的管理設定當成尚未設定', async () => {
  const { store, oauth, service, logs } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  const [first, second] = ACCOUNTS;
  const withoutClient = JSON.parse(validRecord(first));
  delete withoutClient.client_id;
  store.writeConnectorRecord(connectionKey(first, 'google_calendar'), JSON.stringify(withoutClient));
  store.writeConnectorRecord(connectionKey(second, 'google_calendar'), JSON.stringify({ ...JSON.parse(validRecord(second)), client_id: undefined, refresh_token_enc: sealV1(FAKE.refreshToken) }));
  logs.length = 0;
  for (const user of [first, second]) {
    assert.equal(calendarOf(service.list(user)).connection.status, 'NEEDS_RECONNECT', `${user}：清單顯示需要重新連接`);
    await assert.rejects(service.accessFor(user, 'google_calendar'), { code: 'CONNECTOR_NEEDS_RECONNECT' });
  }
  assert.equal(logs.filter(/** 格式不對的日誌 @param {{event: string}} entry 日誌 @returns {boolean} 是時 true */ (entry) => entry.event === 'connectors.record_invalid').length, 0, '舊紀錄不算格式不對');
  assert.equal(oauth.calls.refresh.length, 0);
  assert.deepEqual(await service.disconnect(first, 'google_calendar'), { disconnected: true, revoked: true }, '沒有 client_id 但密文解得開：照樣向 Google 撤銷');
  assert.deepEqual(oauth.calls.revoke, [FAKE.refreshToken]);
  assert.deepEqual(await service.disconnect(second, 'google_calendar'), { disconnected: true, revoked: false }, 'v1 密文解不開：本地照樣刪除');
  assert.equal(store.readConnectorRecord(connectionKey(second, 'google_calendar')), null);

  const setting = JSON.parse(store.readConnectorRecord(settingKey('google_calendar')));
  store.writeConnectorRecord(settingKey('google_calendar'), JSON.stringify({ ...setting, client_secret_enc: sealV1(FAKE.clientSecret) }));
  assert.equal(service.adminSettings('google_calendar').configured, false, 'v1 的管理設定當成尚未設定，請管理員重新儲存');
  assert.deepEqual(failureOf(() => service.startConnect(first, 'google_calendar', 'basic')), { status: 409, code: 'CONNECTOR_NOT_CONFIGURED' });
});

test('撤銷新拿到的授權：原本那筆要是使用中、同一個用戶端、同一個 Google 帳號才不撤銷；撤銷舊授權只看是不是另一個 Google 帳號', async () => {
  const { store, oauth, time, service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  const user = ACCOUNTS[0];
  assert.equal(await connect(service, user), 'connected');
  time.now += 3600 * 1000;
  oauth.behavior.refreshError = 'OAUTH_INVALID_GRANT';
  await assert.rejects(service.accessFor(user, 'google_calendar'), { code: 'CONNECTOR_NEEDS_RECONNECT' });
  Object.assign(oauth.behavior, { refreshError: null, refreshToken: 'partial-token' });
  assert.equal(await connect(service, user, 'advanced'), 'partial');
  assert.deepEqual(oauth.calls.revoke, ['partial-token'], '原本那筆已經需要重新連接：撤銷沒勾齊的新授權');

  oauth.behavior.refreshToken = 'fresh-token';
  assert.equal(await connect(service, user), 'connected');
  assert.deepEqual(oauth.calls.revoke, ['partial-token'], '同一個 Google 帳號重新連接：不撤銷舊的那筆（會連新的一起撤銷）');
  assert.equal(recordOf(store, user).status, 'ACTIVE');

  service.saveAdminSettings('google_calendar', { client_id: 'replaced-client.apps.googleusercontent.com', client_secret: 'replaced-client-secret' }, 'alex.admin');
  oauth.behavior.refreshToken = 'second-partial-token';
  assert.equal(await connect(service, user, 'advanced'), 'partial');
  assert.deepEqual(oauth.calls.revoke, ['partial-token', 'second-partial-token'], '原本那筆屬於已換掉的舊用戶端：撤銷沒勾齊的新授權');
});

test('放棄連接：連接帳號頁沒登入時作廢 state，網址上的授權碼被傳給發起人也完成不了', async () => {
  const { store, oauth, service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  const owner = ACCOUNTS[0];
  const params = paramsOf(service.startConnect(owner, 'google_calendar', 'basic').authorize_url);
  assert.deepEqual(service.abandonConnect(params.get('state')), { abandoned: true });
  assert.deepEqual(service.abandonConnect(params.get('state')), { abandoned: false }, '已作廢的不能再作廢');
  assert.deepEqual(service.abandonConnect(undefined), { abandoned: false });
  assert.equal((await service.completeConnect(owner, { state: params.get('state'), code: 'leaked-code' })).result, 'expired', '發起人拿到網址上的授權碼也完成不了');
  assert.equal(oauth.calls.exchange.length, 0);
  assert.equal(store.readConnectorRecord(connectionKey(owner, 'google_calendar')), null);
});

/**
 * 在本機臨時埠啟動測試 app，完成後關閉所有連線；不連 Google
 * @param {Function} run 測試操作，參數為根網址
 * @returns {Promise<void>}
 */
async function withServer(run) {
  const server = app.listen(0, '127.0.0.1');
  /** 等待監聽成功 @param {Function} resolve 成功 @param {Function} reject 失敗 @returns {void} */
  function listening(resolve, reject) { server.once('listening', resolve); server.once('error', reject); }
  await new Promise(listening);
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections(); server.close(); }
}

/**
 * 建立呼叫測試 app 的小工具
 * @param {string} base 根網址
 * @returns {{call: Function, login: Function}} 呼叫 API 與登入
 */
function client(base) {
  /** 呼叫 API @param {string} path 路徑 @param {string} [token] 憑證 @param {object} [body] 本文 @returns {Promise<Response>} 回應 */
  async function call(path, token, body) {
    return fetch(`${base}/api${path}`, { method: body ? 'POST' : 'GET', redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  /** 登入取得憑證 @param {string} username 帳號 @param {string} password 密碼 @returns {Promise<string>} 憑證 */
  async function login(username, password) { return (await (await call('/auth/login', undefined, { username, password })).json()).token; }
  return { call, login };
}

test('API：要登入；一般帳號看不到管理設定；管理設定不回 client secret；回呼的錯誤 state 轉回連接頁', async () => {
  await withServer(async (base) => {
    const { call, login } = client(base);
    assert.equal((await call('/connectors')).status, 401);
    const user = await login(ACCOUNTS[0], 'test-only-password');
    const admin = await login('alex.admin', 'test-admin-only-password');
    const listed = await call('/connectors', user);
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).connectors.map(/** 取 id @param {{id: string}} item 連接器 @returns {string} id */ (item) => item.id), ['google_calendar', 'gmail', 'microsoft_365']);
    assert.equal((await call('/connectors', admin)).status, 403, '管理員帳號不能用一般功能');
    assert.equal((await call('/admin/connectors/google', user)).status, 403);
    assert.equal((await call('/connectors/google_calendar/connect', user, { level: 'basic' })).status, 409, '管理員還沒設定');
    const saved = await call('/admin/connectors/google', admin, { client_id: FAKE.clientId, client_secret: FAKE.clientSecret });
    assert.equal(saved.status, 200);
    const savedText = await saved.text();
    assert.ok(!savedText.includes(FAKE.clientSecret) && !savedText.includes('client_secret'));
    const viewed = await (await call('/admin/connectors/google', admin)).json();
    assert.equal(viewed.client_id, FAKE.clientId);
    assert.equal(viewed.redirect_uri, 'http://localhost:5173/pages/connections/connections.html', '開發時回到前端開發伺服器的連接帳號頁');
    const started = await call('/connectors/google_calendar/connect', user, { level: 'basic' });
    assert.equal(started.status, 200);
    assert.match((await started.json()).authorize_url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.equal((await call('/connectors/google/callback?state=wrong&code=x')).status, 404, '後端沒有不需登入的回呼');
    assert.equal((await call('/connectors/google/complete', undefined, { state: 'wrong', code: 'x' })).status, 401, '完成連接要登入');
    const abandoned = await call('/connectors/google/abandon', undefined, { state: 'wrong' });
    assert.equal(abandoned.status, 200, '作廢 state 不需要登入');
    assert.deepEqual(await abandoned.json(), { abandoned: false });
    const completed = await call('/connectors/google/complete', user, { state: 'wrong', code: 'x' });
    assert.equal(completed.status, 200);
    assert.deepEqual(await completed.json(), { result: 'expired', connector: null });
    const gone = await call('/connectors/google_calendar/disconnect', user, {});
    assert.deepEqual(await gone.json(), { disconnected: false, revoked: false });
  });
});

test('重置教室資料：外部服務連接與管理設定都保留', async () => {
  await withServer(async (base) => {
    const { call, login } = client(base);
    const user = await login(ACCOUNTS[0], 'test-only-password');
    const admin = await login('alex.admin', 'test-admin-only-password');
    assert.equal((await call('/admin/connectors/google', admin, { client_id: FAKE.clientId, client_secret: FAKE.clientSecret })).status, 200);
    dataStore.writeConnectorRecord(connectionKey(ACCOUNTS[0], 'google_calendar'), validRecord(ACCOUNTS[0]));
    const reset = await call('/admin/reset', admin, { confirmation: 'RESET_HELPDESK' });
    assert.equal(reset.status, 200);
    const calendar = calendarOf((await (await call('/connectors', user)).json()).connectors);
    assert.equal(calendar.connection.status, 'ACTIVE', '重置後連接還在');
    assert.equal(calendar.configured, true);
    assert.equal((await (await call('/admin/connectors/google', admin)).json()).client_id, FAKE.clientId, '重置後管理設定還在');
  });
});

test('連接器設定檔的提供者文字：connect_hint 與 account_page 由清單帶給前端；型別不對時指出鍵路徑', () => {
  const calendar = getConnectorRegistry().find('google_calendar');
  assert.ok(calendar.connectHint.includes('Google'), '提供者文字放在設定檔');
  assert.ok(calendar.accountPage.length > 0);
  const { service } = harness();
  const listed = calendarOf(service.list(ACCOUNTS[0]));
  assert.equal(listed.connect_hint, calendar.connectHint);
  assert.equal(listed.account_page, calendar.accountPage);
  assert.throws(() => createConnectorRegistry({ raw: { connectors: [{ id: 'x_y', status: 'planned', name: 'X', description: '', connect_hint: 3 }] } }), /connectors\[0\]\.connect_hint/);
  assert.equal(STATE_TTL_MS, 5 * 60 * 1000, 'state 5 分鐘內有效');
});

test('丟掉快取的存取權杖：下次取權杖時重新向 Google 換，授權已撤銷就標成需要重新連接', async () => {
  const { store, oauth, service } = harness();
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  const user = ACCOUNTS[0];
  assert.equal(await connect(service, user), 'connected');
  assert.equal((await service.accessFor(user, 'google_calendar')).accessToken, FAKE.accessToken);
  assert.equal(oauth.calls.refresh.length, 0, '先用快取');
  service.forgetToken(user, 'google_calendar');
  assert.equal((await service.accessFor(user, 'google_calendar')).accessToken, `${FAKE.accessToken}-1`, '丟掉快取後重新換');
  service.forgetToken(user, 'google_calendar');
  oauth.behavior.refreshError = 'OAUTH_INVALID_GRANT';
  await assert.rejects(service.accessFor(user, 'google_calendar'), { code: 'CONNECTOR_NEEDS_RECONNECT' });
  assert.equal(recordOf(store, user).status, 'NEEDS_RECONNECT');
});

test('自動生成用的連接狀態：只讀 meta 表、不連 Google；分得出沒連接、已連接、需要重新連接與不能連接，工具照權限等級；帶連接器名稱', async () => {
  const { oauth, service, inactive } = harness();
  const user = ACCOUNTS[0];
  assert.deepEqual(service.statusOf(user, 'google_calendar'), { name: 'Google 行事曆', status: 'UNAVAILABLE', tools: [] }, '管理員尚未設定');
  service.saveAdminSettings('google_calendar', { client_id: FAKE.clientId, client_secret: FAKE.clientSecret }, 'alex.admin');
  assert.deepEqual(service.statusOf(user, 'google_calendar'), { name: 'Google 行事曆', status: 'NOT_CONNECTED', tools: [] });
  oauth.behavior.scope = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
  assert.equal(await connect(service, user), 'connected');
  const refreshed = oauth.calls.refresh.length;
  assert.deepEqual(service.statusOf(user, 'google_calendar'), { name: 'Google 行事曆', status: 'ACTIVE', tools: ['calendar_busy'] }, '基本權限只有忙碌時段');
  assert.equal(oauth.calls.refresh.length, refreshed, '不向 Google 換權杖');
  inactive.add(user);
  assert.deepEqual(service.statusOf(user, 'google_calendar'), { name: 'Google 行事曆', status: 'UNAVAILABLE', tools: [] }, '帳號停用');
  inactive.delete(user);
  service.saveAdminSettings('google_calendar', { client_id: 'replaced-client.apps.googleusercontent.com', client_secret: 'replaced-client-secret' }, 'alex.admin');
  assert.deepEqual(service.statusOf(user, 'google_calendar'), { name: 'Google 行事曆', status: 'NEEDS_RECONNECT', tools: [] }, '管理員換了用戶端');
  assert.deepEqual(service.statusOf(user, 'gmail'), { name: 'Gmail', status: 'UNAVAILABLE', tools: [] }, '規劃中');
  assert.deepEqual(service.statusOf(user, 'nope'), { name: 'nope', status: 'UNAVAILABLE', tools: [] }, '找不到');
  const broken = harness(':memory:', { registry: createLazyRegistry({ load: /** 設定檔壞掉 @returns {never} @throws {Error} 一律拋出 */ () => { throw new Error('壞掉'); }, log: /** 不記錄 @returns {void} */ () => {} }) });
  assert.throws(() => broken.service.statusOf(user, 'google_calendar'), { code: 'CONNECTORS_UNAVAILABLE' }, '設定檔壞掉時由呼叫端處理');
});
