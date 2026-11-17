import { API_BASE_URL } from '../config.js';
import { authService } from './authService.js';

// 外部服務連接 API 的等待上限；放棄連接只是作廢 state，給較短的時間，不讓頁面卡住
const TIMEOUT_MS = 20000;
const ABANDON_TIMEOUT_MS = 5000;
const RESULTS = new Set(['connected', 'denied', 'expired', 'mismatch', 'partial', 'failed']);
// 允許把瀏覽器導過去的授權端點；目前只有 Google，其他提供者上線時加在這裡（不從後端回應讀，避免回應被竄改時把使用者導到別處）
const AUTHORIZE_ENDPOINTS = Object.freeze([{ protocol: 'https:', host: 'accounts.google.com', pathname: '/o/oauth2/v2/auth' }]);

/**
 * 授權網址是否為允許的端點：用 URL 解析後比對通訊協定、主機（含埠）與路徑三項，不用前綴比對
 * @param {unknown} href 網址
 * @returns {boolean} 三項都符合時 true
 */
export function isAllowedAuthorizeUrl(href) {
  let url;
  try { url = new URL(href); } catch { return false; }
  return AUTHORIZE_ENDPOINTS.some(/** 比對一個端點 @param {{protocol: string, host: string, pathname: string}} item 端點 @returns {boolean} 符合時 true */ (item) => url.protocol === item.protocol && url.host === item.host && url.pathname === item.pathname && !url.username && !url.password);
}

/** 外部服務連接 API 的可辨識錯誤，保留 HTTP 狀態供畫面處理登入失效 */
export class ConnectorServiceError extends Error {
  /** 建立不含敏感資料的錯誤 @param {string} message 中文提示 @param {number} [status=0] HTTP 狀態，連線失敗為 0 */
  constructor(message, status = 0) { super(message); this.name = 'ConnectorServiceError'; this.status = status; }
}

/**
 * 呼叫外部服務連接 API：預設帶登入憑證，回應一律解析 JSON；錯誤訊息只取後端的固定文字，不含權杖或 client secret
 * @param {string} path /api 底下的路徑
 * @param {object} [options={}] 選項
 * @param {string} [options.method='GET'] HTTP 方法（CORS 只開 GET、POST）
 * @param {object} [options.body] JSON 本文
 * @param {object} [options.auth=authService] 提供 getAccessToken 的登入服務
 * @param {boolean} [options.login=true] 是否需要登入憑證
 * @param {number} [options.timeoutMs=TIMEOUT_MS] 等待上限
 * @returns {Promise<object>} 回應 JSON
 * @throws {ConnectorServiceError} 沒登入（401）、連線失敗（0）或後端回非 2xx
 */
async function request(path, { method = 'GET', body, auth = authService, login = true, timeoutMs = TIMEOUT_MS } = {}) {
  const token = login ? auth.getAccessToken() : null;
  if (login && !token) throw new ConnectorServiceError('請先登入', 401);
  let response;
  let data;
  try {
    response = await globalThis.fetch(`${API_BASE_URL.replace(/\/$/, '')}/api${path}`, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
    });
    data = await response.json();
  } catch { throw new ConnectorServiceError('連線失敗，請稍後再試'); }
  if (!response.ok) throw new ConnectorServiceError(data?.error?.message || '操作失敗，請稍後再試', response.status);
  return data;
}

/**
 * 列出支援與規劃中的外部服務，以及本人的連接狀態
 * @param {object} [auth=authService] 登入服務
 * @returns {Promise<object[]>} 連接器清單
 * @throws {ConnectorServiceError} 見 request；回應格式不對時 status 0
 */
export async function listConnectors(auth = authService) {
  const data = await request('/connectors', { auth });
  if (!Array.isArray(data?.connectors)) throw new ConnectorServiceError('連接清單格式異常，請稍後再試');
  return data.connectors;
}

/**
 * 發起連接：取得要讓瀏覽器前往的授權網址；只接受允許的授權端點（isAllowedAuthorizeUrl），避免把使用者導到別處
 * @param {string} connectorId 連接器 id
 * @param {string} level 權限等級 id
 * @param {object} [auth=authService] 登入服務
 * @returns {Promise<string>} Google 授權網址
 * @throws {ConnectorServiceError} 見 request；網址不是 Google 授權網址時 status 0
 */
export async function startConnect(connectorId, level, auth = authService) {
  const data = await request(`/connectors/${encodeURIComponent(connectorId)}/connect`, { method: 'POST', body: { level }, auth });
  if (typeof data?.authorize_url !== 'string' || !isAllowedAuthorizeUrl(data.authorize_url)) throw new ConnectorServiceError('授權網址格式異常，請稍後再試');
  return data.authorize_url;
}

/**
 * 完成連接：把 Google 導回時網址上的 state 與 code（或 error）連同本人的登入憑證送給後端，後端確認是發起的本人才換權杖
 * @param {{state: string, code?: string|null, error?: string|null}} returned Google 導回的參數
 * @param {object} [auth=authService] 登入服務
 * @returns {Promise<{result: string, connector: string|null}>} 結果；不認得的結果一律當成 failed
 * @throws {ConnectorServiceError} 見 request
 */
export async function completeGoogle({ state, code, error }, auth = authService) {
  const body = { state, ...(code ? { code } : {}), ...(error ? { error } : {}) };
  const data = await request('/connectors/google/complete', { method: 'POST', body, auth });
  return { result: RESULTS.has(data?.result) ? data.result : 'failed', connector: typeof data?.connector === 'string' ? data.connector : null };
}

/**
 * 放棄連接：沒登入時或完成連接失敗時作廢 state，網址上的授權碼就算被傳給別人也完成不了；不需要登入，失敗也不拋出（回 false，最多再過 5 分鐘 state 也會失效）
 * @param {string} state Google 導回的 state
 * @returns {Promise<boolean>} 後端確認作廢時 true
 */
export async function abandonGoogle(state) {
  try { return (await request('/connectors/google/abandon', { method: 'POST', body: { state }, login: false, timeoutMs: ABANDON_TIMEOUT_MS }))?.abandoned === true; } catch { return false; }
}

/**
 * 中斷連接：後端先向 Google 撤銷授權，再刪除本地資料
 * @param {string} connectorId 連接器 id
 * @param {object} [auth=authService] 登入服務
 * @returns {Promise<{disconnected: boolean, revoked: boolean}>} 是否刪除、Google 是否確認撤銷
 * @throws {ConnectorServiceError} 見 request
 */
export async function disconnectConnector(connectorId, auth = authService) {
  const data = await request(`/connectors/${encodeURIComponent(connectorId)}/disconnect`, { method: 'POST', body: {}, auth });
  return { disconnected: data?.disconnected === true, revoked: data?.revoked === true };
}

/**
 * 管理員讀取 Google 連接設定（不含 client secret）
 * @param {object} [auth=authService] 登入服務
 * @returns {Promise<{configured: boolean, client_id: string, redirect_uri: string, updated_by: string|null, updated_at: string|null}>} 設定摘要
 * @throws {ConnectorServiceError} 見 request；格式不對時 status 0
 */
export async function loadGoogleSettings(auth = authService) {
  const data = await request('/admin/connectors/google', { auth });
  if (typeof data?.configured !== 'boolean' || typeof data.redirect_uri !== 'string' || typeof data.client_id !== 'string') throw new ConnectorServiceError('設定格式異常，請稍後再試');
  return data;
}

/**
 * 管理員儲存 Google 連接設定；client secret 只送不讀，回應也不含它
 * @param {{clientId: string, clientSecret: string}} settings 用戶端 ID 與密鑰
 * @param {object} [auth=authService] 登入服務
 * @returns {Promise<object>} 儲存後的設定摘要（同 loadGoogleSettings）
 * @throws {ConnectorServiceError} 見 request
 */
export async function saveGoogleSettings({ clientId, clientSecret }, auth = authService) {
  return request('/admin/connectors/google', { method: 'POST', body: { client_id: clientId, client_secret: clientSecret }, auth });
}
