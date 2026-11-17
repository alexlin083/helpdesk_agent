import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { buildAuthorizeUrl } from './googleOAuth.js';
import { connectionKey, parseConnection, parseSetting, serializeConnection, serializeSetting, settingKey } from './metaRecords.js';

// 授權流程的 state：5 分鐘內有效、只能用一次（縮短效期，降低導回網址留在瀏覽紀錄、被轉傳後還能用的時間）；只存在單程序記憶體（與限流相同，服務只跑一個程序）；
// 同一帳號同一連接器只保留最新的一筆，全站另有筆數上限
export const STATE_TTL_MS = 5 * 60 * 1000;
const STATE_MAX = 500;
// 存取權杖在到期前多少毫秒就視為過期，避免剛好在呼叫 Google 途中失效
const TOKEN_MARGIN_MS = 60 * 1000;
// Google 授權完成後直接導回前端的「連接帳號」頁（這就是要貼到 Google 的回呼網址），由頁面帶登入憑證呼叫完成連接的 API
const CONNECTIONS_PAGE = '/pages/connections/connections.html';
// 換權杖時出現這些錯誤，代表這筆授權已不能再用，要請本人重新連接
const RECONNECT_ERRORS = new Set(['OAUTH_INVALID_GRANT', 'OAUTH_UNAUTHORIZED_CLIENT', 'SEAL_INVALID']);

/**
 * 建立帶代碼的錯誤（給工具使用的 accessFor，不是 HTTP 錯誤）
 * @param {string} message 說明
 * @param {string} code 代碼
 * @returns {Error} 錯誤
 */
function codedError(message, code) { return Object.assign(new Error(message), { code }); }

/**
 * 建立外部服務連接服務：列出連接器與本人的連接狀態、發起與完成 Google 授權、中斷連接、提供工具使用的存取權杖，以及管理員的用戶端設定
 * 授權與 client secret 一律經 sealer 加密（綁在所屬的 meta 名稱上）後才交給 store 保存；回應、日誌與錯誤訊息都不含權杖或 client secret
 * 資料存在 meta 表，一個帳號只用完整名稱逐一讀 connectors.json 列出的連接器，不做前綴掃描；讀出的值格式不對時當成沒有連接或尚未設定，記一行日誌
 * 完成授權必須是發起的本人：Google 導回前端頁後，由頁面帶本人的登入憑證送出授權碼，帳號和發起時不同就拒絕，避免把別人的 Google 授權存進自己的帳號
 * 帳號停用（或部門已不存在）時，不保存授權、工具取不到權杖；保存的授權留著，帳號恢復後照常可用
 * 連接器設定檔無法載入時，用到連接器查詢的方法都拋出 503 CONNECTORS_UNAVAILABLE（見 registry.js 的 createLazyRegistry）
 * @param {object} deps 相依
 * @param {object} deps.store 資料存取（dataStore 的 readConnectorRecord、writeConnectorRecord、updateConnectorRecord、deleteConnectorRecord）
 * @param {{find: (username: string) => object|null}} deps.accounts 帳號查詢（accountService），不可使用的帳號回 null
 * @param {object} deps.registry 連接器查詢（createConnectorRegistry 或 createLazyRegistry）
 * @param {{seal: Function, open: Function}} deps.sealer 加解密工具
 * @param {object} deps.oauth Google OAuth 用戶端（createGoogleOAuth）
 * @param {string} deps.publicAppUrl 使用者看到的前端根網址（不含結尾斜線）
 * @param {() => number} [deps.clock=Date.now] 取得現在時間（毫秒）
 * @param {Function} [deps.log=logger] 日誌寫入（測試可注入，記錄是否寫了日誌）
 * @returns {object} 連接服務
 */
export function createConnectionService({ store, accounts, registry, sealer, oauth, publicAppUrl, clock = Date.now, log = logger }) {
  const states = new Map();
  const latestStates = new Map();
  const tokens = new Map();

  /** 回呼網址（前端連接帳號頁）：必須和管理員貼到 Google 的完全一致 @returns {string} 網址 */
  function redirectUri() { return `${publicAppUrl}${CONNECTIONS_PAGE}`; }
  /** 現在時間的 ISO 字串 @returns {string} 時間 */
  function nowIso() { return new Date(clock()).toISOString(); }
  /** 帳號加連接器的記憶體鍵（權杖快取與 state 共用） @param {string} username 帳號 @param {string} connectorId 連接器 id @returns {string} 鍵 */
  function keyOf(username, connectorId) { return `${username}\u0000${connectorId}`; }
  /**
   * 移除一筆 state，同時清掉「最新 state」的對照
   * @param {string} state state
   * @param {{username: string, connectorId: string}} entry state 內容
   * @returns {void}
   */
  function dropState(state, entry) {
    states.delete(state);
    const key = keyOf(entry.username, entry.connectorId);
    if (latestStates.get(key) === state) latestStates.delete(key);
  }
  /** 清掉過期的 state @returns {void} */
  function sweepStates() {
    const now = clock();
    for (const [state, entry] of states) if (entry.expiresAt <= now) dropState(state, entry);
  }
  /**
   * 找可用的連接器，不存在或還在規劃中時拋出
   * @param {string} connectorId 連接器 id
   * @returns {object} 連接器
   * @throws {HttpError} 404 CONNECTOR_NOT_FOUND；409 CONNECTOR_PLANNED
   */
  function availableConnector(connectorId) {
    const connector = typeof connectorId === 'string' ? registry.find(connectorId) : null;
    if (!connector) throw new HttpError(404, 'CONNECTOR_NOT_FOUND', '找不到這個連接項目');
    if (connector.status !== 'available') throw new HttpError(409, 'CONNECTOR_PLANNED', `「${connector.name}」還在規劃中，目前不能連接`);
    return connector;
  }
  /** 連接器提供的權限等級 id @param {{levels: Array<{id: string}>}} connector 連接器 @returns {string[]} id */
  function levelIdsOf(connector) { return connector.levels.map(/** 等級 id @param {{id: string}} level 等級 @returns {string} id */ (level) => level.id); }
  /**
   * 讀取並驗證本人在某連接器的連接；格式不對時當成沒有連接，記一行日誌
   * @param {string} username 帳號
   * @param {object} connector 連接器
   * @returns {ReturnType<typeof parseConnection>} 連接，沒有或格式不對時 null
   */
  function connectionOf(username, connector) {
    const raw = store.readConnectorRecord(connectionKey(username, connector.id));
    if (raw === null) return null;
    const record = parseConnection(raw, levelIdsOf(connector));
    if (!record) log('warn', 'connectors.record_invalid', { kind: 'connection', username, connectorId: connector.id });
    return record;
  }
  /**
   * 讀取並驗證連接器的用戶端設定（client secret 仍是密文）；格式不對時當成尚未設定，記一行日誌
   * @param {string} connectorId 連接器 id
   * @returns {ReturnType<typeof parseSetting>} 設定，沒有或格式不對時 null
   */
  function settingOf(connectorId) {
    const raw = store.readConnectorRecord(settingKey(connectorId));
    if (raw === null) return null;
    const setting = parseSetting(raw);
    if (!setting) log('warn', 'connectors.record_invalid', { kind: 'setting', connectorId });
    return setting;
  }
  /**
   * 取得解密後的 OAuth 用戶端設定；沒有設定或解不開時回傳 null（更換 AUTH_SECRET 後舊的密文解不開，管理員重新儲存即可）
   * @param {string} connectorId 連接器 id
   * @param {ReturnType<typeof parseSetting>} [setting] 已讀出的設定，省略時重新讀取
   * @returns {{clientId: string, clientSecret: string}|null} 用戶端
   */
  function clientOf(connectorId, setting = settingOf(connectorId)) {
    if (!setting) return null;
    try { return { clientId: setting.clientId, clientSecret: sealer.open(setting.clientSecretEnc, settingKey(connectorId)) }; } catch (error) {
      log('warn', 'connectors.setting_unreadable', { connectorId, errorCode: error?.code });
      return null;
    }
  }
  /**
   * 兩個 email 是否可能是同一個 Google 帳號；任一邊不明時當成可能相同（保守：寧可留下沒人用的授權，也不撤掉使用中的那筆）
   * @param {string} left email
   * @param {string} right email
   * @returns {boolean} 可能相同時 true
   */
  function sameEmail(left, right) {
    if (!left || !right) return true;
    return left.toLowerCase() === right.toLowerCase();
  }
  /**
   * 撤銷「新拿到、但沒存起來」的授權之前用：原本那筆是否還在使用中，而且是同一個 Google 帳號、同一個用戶端
   * Google 撤銷任何一個授權，會撤銷這個 Google 帳號給整個專案的全部授權；只有原本那筆還能用時，撤銷新的才會連帶傷到它，所以三個條件都符合才不撤銷，
   * 原本那筆已經需要重新連接，或屬於已換掉的舊用戶端時，照樣撤銷新的，Google 端才不會留下沒人用的授權
   * @param {ReturnType<typeof parseConnection>} previous 原本的連接
   * @param {string} email 這次授權的 Google 帳號 email
   * @param {string} clientId 目前的 client id
   * @returns {boolean} 原本那筆是 ACTIVE、client id 相同、email 相同（或不明）時 true
   */
  function keepsActiveGrant(previous, email, clientId) {
    return Boolean(previous) && previous.status === 'ACTIVE' && previous.clientId === clientId && sameEmail(previous.accountEmail, email);
  }
  /**
   * 解開保存的授權並向 Google 撤銷；解不開或 Google 失敗都回 false，不拋出
   * @param {string} sealed 加密後的授權
   * @param {string} name 這筆授權所屬的 meta 名稱
   * @returns {Promise<boolean>} Google 確認撤銷時 true
   */
  async function revokeSealed(sealed, name) {
    try { return await oauth.revoke(sealer.open(sealed, name)); } catch { return false; }
  }
  /**
   * 畫面上顯示的連接狀態：保存的狀態是 ACTIVE，但授權當時的用戶端和目前管理員設定的不同時，顯示需要重新連接
   * @param {ReturnType<typeof parseConnection>} row 連接
   * @param {{clientId: string}|null} client 目前的用戶端
   * @returns {string} 狀態
   */
  function effectiveStatus(row, client) {
    if (row.status !== 'ACTIVE') return row.status;
    return client && row.clientId !== client.clientId ? 'NEEDS_RECONNECT' : 'ACTIVE';
  }
  /**
   * 把連接改成 NEEDS_RECONNECT；只改「出問題的那一筆」：同一時間本人已重新連接、紀錄換成新的授權時不改
   * @param {string} username 帳號
   * @param {object} connector 連接器
   * @param {ReturnType<typeof parseConnection>} row 出問題的那一筆
   * @param {string} reason 原因代碼（寫進日誌）
   * @returns {boolean} 有改時 true
   */
  function markNeedsReconnect(username, connector, row, reason) {
    const now = nowIso();
    const marked = store.updateConnectorRecord(connectionKey(username, connector.id), /** 紀錄還是出問題的那一筆時才改狀態 @param {string} raw 原始值 @returns {string|null} 新值，不改時 null */ (raw) => {
      const current = parseConnection(raw, levelIdsOf(connector));
      return current?.refreshTokenEnc === row.refreshTokenEnc ? serializeConnection({ ...current, status: 'NEEDS_RECONNECT', updatedAt: now }) : null;
    });
    if (marked) {
      tokens.delete(keyOf(username, connector.id));
      log('warn', 'connectors.needs_reconnect', { username, connectorId: connector.id, errorCode: reason });
    }
    return marked;
  }
  /**
   * 管理員查看連接器的用戶端設定：只回 client id、是否已設定、要貼到 Google 的回呼網址；不回 client secret
   * configured 只在設定存在而且解得開時為 true，更換 AUTH_SECRET 後會變回 false，提示管理員重新儲存
   * @param {string} connectorId 連接器 id
   * @returns {{connector_id: string, configured: boolean, client_id: string, redirect_uri: string, updated_by: string|null, updated_at: string|null}} 設定摘要
   * @throws {HttpError} 404、409 見 availableConnector
   */
  function adminSettings(connectorId) {
    const connector = availableConnector(connectorId);
    const setting = settingOf(connector.id);
    return { connector_id: connector.id, configured: Boolean(clientOf(connector.id, setting)), client_id: setting?.clientId ?? '', redirect_uri: redirectUri(), updated_by: setting?.updatedBy ?? null, updated_at: setting?.updatedAt ?? null };
  }
  /**
   * 給工具使用：取得本人在某連接器的存取權杖與權限等級；快取到到期前 1 分鐘，過期才用 refresh token 換新的
   * 授權被撤銷、過期、不屬於目前的用戶端或解不開時，把那一筆改成 NEEDS_RECONNECT；管理員換了用戶端時，授權當時的用戶端不同也一樣
   * 換權杖途中本人若中斷或重新連接，不把結果寫進快取，改照最新的紀錄再試一次；帳號停用時一律拒絕，連快取的權杖也不給
   * @param {string} username 帳號（呼叫端必須是憑證身分本人，不接受 AI 指定）
   * @param {string} connectorId 連接器 id
   * @param {boolean} [retried=false] 內部使用：已經因為紀錄被換掉而重試過一次
   * @returns {Promise<{accessToken: string, level: object}>} 存取權杖與權限等級（含開放的工具）
   * @throws {Error} code CONNECTOR_ACCOUNT_INACTIVE、CONNECTOR_NOT_CONNECTED、CONNECTOR_NEEDS_RECONNECT、CONNECTOR_NOT_CONFIGURED、OAUTH_UNAVAILABLE
   */
  async function accessFor(username, connectorId, retried = false) {
    if (!accounts.find(username)) throw codedError('帳號已停用', 'CONNECTOR_ACCOUNT_INACTIVE');
    const connector = registry.find(connectorId);
    const row = connector?.status === 'available' ? connectionOf(username, connector) : null;
    if (!row) throw codedError('尚未連接', 'CONNECTOR_NOT_CONNECTED');
    if (row.status !== 'ACTIVE' || !registry.level(connector, row.level)) throw codedError('需要重新連接', 'CONNECTOR_NEEDS_RECONNECT');
    const level = registry.level(connector, row.level);
    const client = clientOf(connector.id);
    if (!client) throw codedError('管理員尚未設定', 'CONNECTOR_NOT_CONFIGURED');
    if (row.clientId !== client.clientId) {
      markNeedsReconnect(username, connector, row, 'CLIENT_CHANGED');
      throw codedError('需要重新連接', 'CONNECTOR_NEEDS_RECONNECT');
    }
    const key = keyOf(username, connector.id);
    const cachedToken = tokens.get(key);
    if (cachedToken && cachedToken.expiresAt - TOKEN_MARGIN_MS > clock()) return { accessToken: cachedToken.accessToken, level };
    let fresh;
    try {
      fresh = await oauth.refresh({ clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: sealer.open(row.refreshTokenEnc, connectionKey(username, connector.id)) });
    } catch (error) {
      if (!RECONNECT_ERRORS.has(error?.code)) throw codedError('Google 暫時無法回應', 'OAUTH_UNAVAILABLE');
      if (!markNeedsReconnect(username, connector, row, error.code) && !retried) return accessFor(username, connectorId, true);
      throw codedError('需要重新連接', 'CONNECTOR_NEEDS_RECONNECT');
    }
    const latest = connectionOf(username, connector);
    if (latest?.refreshTokenEnc !== row.refreshTokenEnc || latest.status !== 'ACTIVE') {
      if (!retried) return accessFor(username, connectorId, true);
      throw codedError('連接剛被更新，請再試一次', 'OAUTH_UNAVAILABLE');
    }
    tokens.set(key, { accessToken: fresh.accessToken, expiresAt: clock() + fresh.expiresIn * 1000 });
    return { accessToken: fresh.accessToken, level };
  }

  return {
    redirectUri,
    /**
     * 列出全部連接器與目前帳號的連接狀態（未連接、已連接、需要重新連接），以及管理員是否已設定用戶端
     * @param {string} username 帳號
     * @returns {object[]} 連接器清單（不含 scopes 與任何權杖）
     */
    list(username) {
      return registry.list().map(/** 組出一個連接器的顯示資料 @param {object} item 連接器 @returns {object} 顯示資料 */ (item) => {
        const available = item.status === 'available';
        const client = available ? clientOf(item.id) : null;
        const row = available ? connectionOf(username, item) : null;
        return {
          id: item.id, name: item.name, status: item.status, description: item.description, never: [...item.never], connect_hint: item.connectHint, account_page: item.accountPage,
          levels: item.levels.map(/** 權限等級的顯示資料 @param {object} level 等級 @returns {object} 等級 */ (level) => ({ id: level.id, name: level.name, summary: level.summary, reads: [...level.reads] })),
          configured: Boolean(client),
          connection: row ? { status: effectiveStatus(row, client), account_email: row.accountEmail, level: row.level, connected_at: row.connectedAt } : { status: 'NOT_CONNECTED' },
        };
      });
    },
    /**
     * 本人在某連接器的狀態與權限等級開放的工具：只讀 meta 表，不連 Google（「自動生成」每次驗證都會呼叫，畫面據此提示連接或重新連接）
     * @param {string} username 帳號
     * @param {string} connectorId 連接器 id
     * @returns {{name: string, status: string, tools: string[]}} name 為連接器名稱（找不到時是 id）；status 為 ACTIVE、NEEDS_RECONNECT、NOT_CONNECTED，或 UNAVAILABLE（找不到、規劃中、管理員尚未設定、帳號停用）；tools 只在 ACTIVE 時列出
     * @throws {HttpError} 503 CONNECTORS_UNAVAILABLE 連接器設定檔無法使用
     */
    statusOf(username, connectorId) {
      const connector = registry.find(connectorId);
      const name = connector?.name ?? String(connectorId);
      const client = connector?.status === 'available' && accounts.find(username) ? clientOf(connector.id) : null;
      if (!client) return { name, status: 'UNAVAILABLE', tools: [] };
      const row = connectionOf(username, connector);
      if (!row) return { name, status: 'NOT_CONNECTED', tools: [] };
      const level = registry.level(connector, row.level);
      const status = level ? effectiveStatus(row, client) : 'NEEDS_RECONNECT';
      return { name, status, tools: status === 'ACTIVE' ? [...level.tools] : [] };
    },
    /**
     * 發起連接：產生 state 與 PKCE，回傳讓瀏覽器前往的 Google 授權網址；同一帳號同一連接器先前未完成的 state 作廢
     * @param {string} username 帳號
     * @param {string} connectorId 連接器 id
     * @param {unknown} levelId 權限等級 id
     * @returns {{authorize_url: string}} 授權網址
     * @throws {HttpError} 404、409 見 availableConnector；400 INVALID_PAYLOAD 等級不存在；409 CONNECTOR_NOT_CONFIGURED 管理員尚未設定；429 CONNECT_BUSY 全站進行中的授權太多
     */
    startConnect(username, connectorId, levelId) {
      const connector = availableConnector(connectorId);
      const level = typeof levelId === 'string' ? registry.level(connector, levelId) : null;
      if (!level) throw new HttpError(400, 'INVALID_PAYLOAD', 'level 必須是這個連接項目提供的權限等級');
      const client = clientOf(connector.id);
      if (!client) throw new HttpError(409, 'CONNECTOR_NOT_CONFIGURED', '管理員尚未設定 Google 連接，請先請管理員在管理頁完成設定');
      sweepStates();
      const userKey = keyOf(username, connector.id);
      const previousState = latestStates.get(userKey);
      if (previousState) dropState(previousState, states.get(previousState) ?? { username, connectorId: connector.id });
      if (states.size >= STATE_MAX) throw new HttpError(429, 'CONNECT_BUSY', '目前進行中的連接太多，請稍後再試');
      const state = randomBytes(24).toString('base64url');
      const codeVerifier = randomBytes(48).toString('base64url');
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
      states.set(state, { username, connectorId: connector.id, levelId: level.id, codeVerifier, expiresAt: clock() + STATE_TTL_MS });
      latestStates.set(userKey, state);
      log('info', 'connectors.connect.started', { username, connectorId: connector.id, level: level.id });
      return { authorize_url: buildAuthorizeUrl({ clientId: client.clientId, redirectUri: redirectUri(), scopes: [...level.scopes], state, codeChallenge }) };
    },
    /**
     * 完成連接：Google 導回前端連接帳號頁後，頁面帶本人的登入憑證送來 state 與 code（或 error）
     * state 只能用一次、5 分鐘內有效，而且必須是同一個帳號發起的；通過後才以授權碼換權杖、加密保存
     * 重新連接時：原本是另一個 Google 帳號就撤銷舊的授權；同一個（或 email 不明）時不撤銷，因為 Google 會連同剛拿到的新授權一起撤銷
     * 換到授權後才失敗（沒勾齊權限、寫入失敗）時撤銷這次的授權；只有原本那筆是使用中、同一個用戶端、同一個 Google 帳號時不撤銷，原本的連接照舊
     * 任何例外都不往外拋，一律回 result：connected、denied（本人拒絕）、expired（state 錯誤、過期或重放）、mismatch（不是發起的帳號）、partial（沒勾齊權限）、failed
     * @param {string} username 送出請求的帳號（憑證身分）
     * @param {{state?: unknown, code?: unknown, error?: unknown}} [body={}] 頁面送來的查詢參數
     * @returns {Promise<{result: string, connector: string|null}>} 結果代碼與連接器 id
     */
    async completeConnect(username, { state, code, error } = {}) {
      sweepStates();
      const entry = typeof state === 'string' ? states.get(state) : undefined;
      if (!entry) {
        log('warn', 'connectors.complete.bad_state', {});
        return { result: 'expired', connector: null };
      }
      dropState(state, entry);
      /** 組出結果 @param {string} result 結果代碼 @returns {{result: string, connector: string}} 結果 */
      const outcome = (result) => ({ result, connector: entry.connectorId });
      if (entry.username !== username) {
        log('warn', 'connectors.complete.user_mismatch', { initiator: entry.username, actor: username, connectorId: entry.connectorId });
        return outcome('mismatch');
      }
      if (typeof error === 'string' && error) {
        log('info', 'connectors.complete.denied', { username, connectorId: entry.connectorId });
        return outcome('denied');
      }
      let granted = null;
      let previous = null;
      let client = null;
      let saved = false;
      try {
        const connector = registry.find(entry.connectorId);
        const level = connector ? registry.level(connector, entry.levelId) : null;
        client = connector ? clientOf(connector.id) : null;
        if (!level || !client || typeof code !== 'string' || !code || code.length > 2048) return outcome('failed');
        if (!accounts.find(username)) {
          log('warn', 'connectors.complete.account_inactive', { username, connectorId: entry.connectorId });
          return outcome('failed');
        }
        const name = connectionKey(username, connector.id);
        previous = connectionOf(username, connector);
        granted = await oauth.exchangeCode({ clientId: client.clientId, clientSecret: client.clientSecret, code, codeVerifier: entry.codeVerifier, redirectUri: redirectUri() });
        const missing = level.scopes.filter(/** 找出沒被授權的範圍 @param {string} scope 範圍 @returns {boolean} 沒授權時 true */ (scope) => scope.startsWith('https://') && !granted.scope.split(' ').includes(scope));
        if (missing.length) {
          if (!keepsActiveGrant(previous, granted.email, client.clientId)) await oauth.revoke(granted.refreshToken);
          log('info', 'connectors.complete.partial_scope', { username, connectorId: connector.id, missing: missing.length });
          return outcome('partial');
        }
        const now = nowIso();
        store.writeConnectorRecord(name, serializeConnection({
          accountEmail: granted.email, level: level.id, scopes: level.scopes.join(' '), clientId: client.clientId,
          refreshTokenEnc: sealer.seal(granted.refreshToken, name), status: 'ACTIVE', connectedAt: now, updatedAt: now,
        }));
        saved = true;
        tokens.set(keyOf(username, connector.id), { accessToken: granted.accessToken, expiresAt: clock() + granted.expiresIn * 1000 });
        // 撤銷舊授權只看是不是另一個 Google 帳號：同一個帳號時撤銷舊的會連同剛存好的新授權一起失效，不論舊的那筆是什麼狀態
        const revokedPrevious = previous && !sameEmail(previous.accountEmail, granted.email) ? await revokeSealed(previous.refreshTokenEnc, name) : false;
        log('info', 'connectors.connected', { username, connectorId: connector.id, level: level.id, revokedPrevious });
        return outcome('connected');
      } catch (failure) {
        if (granted && !saved && !keepsActiveGrant(previous, granted.email, client?.clientId)) await oauth.revoke(granted.refreshToken);
        log('warn', 'connectors.complete.failed', { username, connectorId: entry.connectorId, errorCode: failure?.code });
        return outcome('failed');
      }
    },
    /**
     * 放棄一筆還沒完成的連接：連接帳號頁在沒登入（或不能自動送出）時呼叫，作廢這個 state，網址上的授權碼就算被傳給發起人也完成不了
     * 不需要登入：持有 state 本身就是憑據（隨機 24 bytes、5 分鐘內有效、只能用一次）
     * @param {unknown} state state
     * @returns {{abandoned: boolean}} 有作廢時 true；不存在、過期或已用過時 false
     */
    abandonConnect(state) {
      sweepStates();
      const entry = typeof state === 'string' ? states.get(state) : undefined;
      if (!entry) return { abandoned: false };
      dropState(state, entry);
      log('info', 'connectors.complete.abandoned', { username: entry.username, connectorId: entry.connectorId });
      return { abandoned: true };
    },
    /**
     * 中斷連接：先向 Google 撤銷授權（失敗也照樣刪除本地資料），再刪除本地的連接與記憶體中的存取權杖；格式不對的紀錄無法撤銷，照樣刪除
     * Google 的撤銷會移除這個 Google 帳號給整個專案的授權，同一個 Google 帳號若也被另一個帳號連接，那一筆之後換權杖會失敗、變成需要重新連接
     * @param {string} username 帳號
     * @param {string} connectorId 連接器 id
     * @returns {Promise<{disconnected: boolean, revoked: boolean}>} 是否有刪除、Google 是否確認撤銷
     * @throws {HttpError} 404 CONNECTOR_NOT_FOUND
     */
    async disconnect(username, connectorId) {
      const connector = typeof connectorId === 'string' ? registry.find(connectorId) : null;
      if (!connector) throw new HttpError(404, 'CONNECTOR_NOT_FOUND', '找不到這個連接項目');
      if (connector.status !== 'available') return { disconnected: false, revoked: false };
      const name = connectionKey(username, connector.id);
      if (store.readConnectorRecord(name) === null) return { disconnected: false, revoked: false };
      const row = connectionOf(username, connector);
      const revoked = row ? await revokeSealed(row.refreshTokenEnc, name) : false;
      store.deleteConnectorRecord(name);
      tokens.delete(keyOf(username, connector.id));
      log('info', 'connectors.disconnected', { username, connectorId: connector.id, revoked });
      return { disconnected: true, revoked };
    },
    accessFor,
    /**
     * 丟掉某帳號某連接器在記憶體快取的存取權杖：提供者拒絕這個權杖（例如使用者在對方網站移除授權）時呼叫，下次 accessFor 會重新換權杖
     * @param {string} username 帳號
     * @param {string} connectorId 連接器 id
     * @returns {void}
     */
    forgetToken(username, connectorId) { tokens.delete(keyOf(username, connectorId)); },
    adminSettings,
    /**
     * 管理員儲存用戶端設定；client secret 只寫不讀，加密後保存；換了 client id 後，舊用戶端時期的連接都會顯示需要重新連接
     * @param {string} connectorId 連接器 id
     * @param {unknown} body 請求本文 { client_id, client_secret }
     * @param {string} updatedBy 管理員帳號
     * @returns {object} 儲存後的設定摘要（同 adminSettings）
     * @throws {HttpError} 400 INVALID_PAYLOAD：client_id、client_secret 不是 1～300 字的字串；404、409 見 availableConnector
     */
    saveAdminSettings(connectorId, body, updatedBy) {
      const connector = availableConnector(connectorId);
      const clientId = typeof body?.client_id === 'string' ? body.client_id.trim() : '';
      const clientSecret = typeof body?.client_secret === 'string' ? body.client_secret.trim() : '';
      if (!clientId || clientId.length > 300 || /\s/.test(clientId)) throw new HttpError(400, 'INVALID_PAYLOAD', 'client_id 必須是 1～300 字、不含空白的字串');
      if (!clientSecret || clientSecret.length > 300 || /\s/.test(clientSecret)) throw new HttpError(400, 'INVALID_PAYLOAD', 'client_secret 必須是 1～300 字、不含空白的字串');
      const name = settingKey(connector.id);
      store.writeConnectorRecord(name, serializeSetting({ clientId, clientSecretEnc: sealer.seal(clientSecret, name), updatedBy, updatedAt: nowIso() }));
      log('info', 'connectors.settings.saved', { connectorId: connector.id, updatedBy });
      return adminSettings(connector.id);
    },
  };
}
