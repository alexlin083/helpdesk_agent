// 外部服務連接的資料存在既有的 meta 表（名稱對 JSON），不新增資料表、不升資料庫結構版本，舊版程式照樣能開同一個資料庫；
// 這是使用者的要求（2026-11-15），日後組員要正式升版時，再把這兩種資料搬到獨立的資料表
// meta 名稱的組法與 JSON 格式只在這個模組定義，其他程式不得自己拼名稱
export const CONNECTION_PREFIX = 'connector_user:';
export const SETTING_PREFIX = 'connector_setting:';
export const CONNECTION_STATUSES = Object.freeze(['ACTIVE', 'NEEDS_RECONNECT']);
const ID_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;
// 目前的密文格式（v2，綁 meta 名稱）；v1 是功能上線前的舊格式，已不再解密，連接紀錄遇到時當成舊紀錄、要求重新連接
const SEALED_PATTERN = /^v2:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$/;
const LEGACY_SEALED_PATTERN = /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$/;

/**
 * 檢查名稱片段：不得含冒號（冒號是名稱的分隔符號），也不得是空字串
 * @param {unknown} part 片段
 * @param {string} label 錯誤訊息用的名稱
 * @returns {string} 原片段
 * @throws {Error} code CONNECTOR_KEY_INVALID
 */
function segment(part, label) {
  if (typeof part !== 'string' || !part || part.includes(':') || part.length > 120) throw Object.assign(new Error(`${label} 不能當作 meta 名稱`), { code: 'CONNECTOR_KEY_INVALID' });
  return part;
}

/**
 * 一位使用者一個連接器的 meta 名稱：connector_user:{帳號}:{連接器 id}；一律組出完整名稱逐筆讀，不用前綴掃描，避免讀到別人的紀錄
 * @param {string} username 帳號
 * @param {string} connectorId 連接器 id
 * @returns {string} meta 名稱
 * @throws {Error} code CONNECTOR_KEY_INVALID
 */
export function connectionKey(username, connectorId) {
  if (typeof connectorId !== 'string' || !ID_PATTERN.test(connectorId)) throw Object.assign(new Error('連接器 id 不能當作 meta 名稱'), { code: 'CONNECTOR_KEY_INVALID' });
  return `${CONNECTION_PREFIX}${segment(username, '帳號')}:${connectorId}`;
}

/**
 * 連接器 OAuth 用戶端設定的 meta 名稱：connector_setting:{連接器 id}
 * @param {string} connectorId 連接器 id
 * @returns {string} meta 名稱
 * @throws {Error} code CONNECTOR_KEY_INVALID
 */
export function settingKey(connectorId) {
  if (typeof connectorId !== 'string' || !ID_PATTERN.test(connectorId)) throw Object.assign(new Error('連接器 id 不能當作 meta 名稱'), { code: 'CONNECTOR_KEY_INVALID' });
  return `${SETTING_PREFIX}${connectorId}`;
}

/**
 * 是否為連接器使用的 meta 名稱；資料存取層用它擋掉其他 meta 項目（例如本機登入金鑰）被這組方法讀寫
 * @param {unknown} name meta 名稱
 * @returns {boolean} 連接器的名稱時 true
 */
export function isConnectorKey(name) {
  return typeof name === 'string' && (name.startsWith(CONNECTION_PREFIX) || name.startsWith(SETTING_PREFIX));
}

/** 非空字串 @param {unknown} value 值 @param {number} [max=300] 長度上限 @returns {boolean} 符合時 true */
function text(value, max = 300) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
/** ISO 時間字串 @param {unknown} value 值 @returns {boolean} 符合時 true */
function isoTime(value) { return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value)); }

/**
 * 連接紀錄要存進 meta 的 JSON；clientId 是授權當時管理員設定的 OAuth 用戶端，之後管理員換用戶端時，這筆授權就不能再用
 * @param {{accountEmail: string, level: string, scopes: string, clientId: string, refreshTokenEnc: string, status: string, connectedAt: string, updatedAt: string}} entry 連接內容，授權必須是加密後的文字
 * @returns {string} JSON 字串
 */
export function serializeConnection({ accountEmail, level, scopes, clientId, refreshTokenEnc, status, connectedAt, updatedAt }) {
  return JSON.stringify({ account_email: accountEmail, level, scopes, client_id: clientId, refresh_token_enc: refreshTokenEnc, status, connected_at: connectedAt, updated_at: updatedAt });
}

/**
 * 解析並驗證 meta 讀出的連接紀錄；meta 沒有欄位約束，格式不對（JSON 壞掉、缺欄位、權限等級不是這個連接器提供的、狀態不在清單內）一律回 null，由呼叫端當成「沒有連接」
 * 舊紀錄（還沒有 client_id，或授權是 v1 舊格式密文）不算格式不對：照樣解析，但狀態一律當成 NEEDS_RECONNECT，legacy 為 true；
 * 這樣清單顯示需要重新連接、不會每次都寫格式不對的日誌，本人也能中斷連接（密文解得開時照樣向 Google 撤銷）
 * @param {string|null} raw meta 的值
 * @param {string[]} levelIds 這個連接器提供的權限等級 id
 * @returns {{accountEmail: string, level: string, scopes: string, clientId: string, refreshTokenEnc: string, status: string, connectedAt: string, updatedAt: string, legacy: boolean}|null} 連接，格式不對時 null
 */
export function parseConnection(raw, levelIds) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const missingClient = value.client_id === undefined || value.client_id === null || value.client_id === '';
  const sealed = typeof value.refresh_token_enc === 'string' ? value.refresh_token_enc : '';
  const legacySeal = LEGACY_SEALED_PATTERN.test(sealed);
  const ok = typeof value.account_email === 'string' && value.account_email.length <= 254
    && levelIds.includes(value.level) && text(value.scopes, 2000) && (missingClient || text(value.client_id)) && (SEALED_PATTERN.test(sealed) || legacySeal)
    && CONNECTION_STATUSES.includes(value.status) && isoTime(value.connected_at) && isoTime(value.updated_at);
  if (!ok) return null;
  const legacy = missingClient || legacySeal;
  return {
    accountEmail: value.account_email, level: value.level, scopes: value.scopes, clientId: missingClient ? '' : value.client_id, refreshTokenEnc: sealed,
    status: legacy ? 'NEEDS_RECONNECT' : value.status, connectedAt: value.connected_at, updatedAt: value.updated_at, legacy,
  };
}

/**
 * 用戶端設定要存進 meta 的 JSON
 * @param {{clientId: string, clientSecretEnc: string, updatedBy: string, updatedAt: string}} entry 設定，client secret 必須是加密後的文字
 * @returns {string} JSON 字串
 */
export function serializeSetting({ clientId, clientSecretEnc, updatedBy, updatedAt }) {
  return JSON.stringify({ client_id: clientId, client_secret_enc: clientSecretEnc, updated_by: updatedBy, updated_at: updatedAt });
}

/**
 * 解析並驗證 meta 讀出的用戶端設定；格式不對時回 null，由呼叫端當成「尚未設定」
 * @param {string|null} raw meta 的值
 * @returns {{clientId: string, clientSecretEnc: string, updatedBy: string, updatedAt: string}|null} 設定，格式不對時 null
 */
export function parseSetting(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ok = text(value.client_id) && typeof value.client_secret_enc === 'string' && SEALED_PATTERN.test(value.client_secret_enc) && text(value.updated_by, 120) && isoTime(value.updated_at);
  return ok ? { clientId: value.client_id, clientSecretEnc: value.client_secret_enc, updatedBy: value.updated_by, updatedAt: value.updated_at } : null;
}
