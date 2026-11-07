import { API_BASE_URL } from '../config.js';
const SESSION_KEY = 'helpdesk.session.v3';
// 狀態追蹤頁「重新提出」把主題、內容與提單人 userID 暫存在本分頁 sessionStorage 的鍵名；提出需求單頁讀取後即清除，登出時也一併清除。
export const DRAFT_KEY = 'helpdesk.draft.v1';
// 帳號全小寫、格式為「名.姓」；一般帳號、管理員角色與所屬部門由後端資料庫（accounts 資料表）決定，前端只檢查格式。
const USERNAME_PATTERN = /^[a-z]+(?:\.[a-z]+)+$/;

/**
 * 檢查使用者代號的格式（user- 加「名.姓」帳號），實際身分仍必須由後端簽章驗證。
 * @param {unknown} userID 待檢查識別碼。
 * @returns {boolean} 是否符合 user-<帳號> 格式。
 */
export function isKnownUserID(userID) { return typeof userID === 'string' && userID.startsWith('user-') && USERNAME_PATTERN.test(userID.slice(5)); }

/**
 * 檢查後端回傳的身分是否完整：username 格式、userID 對應、可選的 USER／ADMIN 角色、department 含 id 與 name；角色僅用於畫面導頁，授權仍由後端判定。
 * @param {unknown} user 身分物件。
 * @returns {boolean} 是否可接受。
 */
function isValidUser(user) {
  return Boolean(user) && typeof user === 'object' && typeof user.username === 'string' && USERNAME_PATTERN.test(user.username)
    && (user.role === undefined || ['USER', 'ADMIN'].includes(user.role))
    && user.userID === `user-${user.username}` && Boolean(user.department) && typeof user.department === 'object'
    && typeof user.department.id === 'string' && user.department.id.length > 0 && typeof user.department.name === 'string' && user.department.name.length > 0;
}

/** 登入服務錯誤，保留 HTTP 狀態碼、錯誤代碼與等待秒數，讓登入頁判斷是否倒數。 */
export class AuthServiceError extends Error {
  /**
   * 建立可直接顯示的登入錯誤，不包含帳密或憑證。
   * @param {string} message 繁體中文提示。
   * @param {object} [options={}] 錯誤屬性。
   * @param {number} [options.status=0] HTTP 狀態碼；0 表示連線失敗、回應格式異常或儲存失敗。
   * @param {string} [options.code='CLIENT_ERROR'] 後端錯誤代碼（例如 LOGIN_RATE_LIMITED、INVALID_CREDENTIALS）或前端代碼。
   * @param {number} [options.retryAfter=0] 後端要求的等待秒數（向上取整）；沒有時為 0。是否倒數由畫面依狀態碼與代碼決定。
   */
  constructor(message, { status = 0, code = 'CLIENT_ERROR', retryAfter = 0 } = {}) {
    super(message);
    this.name = 'AuthServiceError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * 從登入失敗回應取出等待秒數：優先使用 error.retry_after，缺漏時改用 Retry-After 標頭；非正數或無法解析時為 0。
 * @param {unknown} payload 後端回應本文。
 * @param {unknown} header Retry-After 標頭值。
 * @returns {number} 向上取整的等待秒數，沒有時為 0。
 */
function readRetryAfter(payload, header) {
  const retry = Number(payload?.error?.retry_after ?? header);
  return Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 0;
}

/**
 * 建立後端登入服務，以目前分頁的 sessionStorage 保存憑證、期限與身分（含所屬部門），不保存密碼；
 * 登入單次最長等 15 秒。
 * @param {object} [options={}] 可注入設定。
 * @param {Storage} [options.storage] 測試儲存體，預設使用瀏覽器 sessionStorage。
 * @returns {object} 登入、身分查詢、憑證取得與登出操作。
 */
export function createAuthService({ storage } = {}) {
  /**
   * 延遲存取儲存體，讓瀏覽器拒絕儲存時仍能顯示登入畫面。
   * @returns {Storage} 注入或瀏覽器儲存體。
   * @throws {Error} 瀏覽器禁止儲存。
   */
  function sessionStorage() {
    const target = storage ?? globalThis.sessionStorage;
    if (!target) throw new Error('無法使用登入儲存空間');
    return target;
  }
  /**
   * 讀取且檢查登入資料與期限；不在前端宣稱已驗證 JWT 簽章。
   * @returns {object|null} 含 token、expiresAt 與 user 的工作階段，無效則 null。
   */
  function getSession() {
    try {
      const session = JSON.parse(sessionStorage().getItem(SESSION_KEY));
      if (!session || !isValidUser(session.user) || typeof session.token !== 'string' || !session.token
        || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) return null;
      return session;
    } catch { return null; }
  }
  /**
   * 將帳密送至後端登入端點；成功後僅保存後端核發的身分、角色與憑證。
   * 逾時、連線失敗與回應本文不是 JSON 都視為連線失敗，顯示同一句提示。
   * 後端拒絕時拋出的錯誤帶 status、code 與 retryAfter（取自 error.retry_after 或 Retry-After 標頭），供登入頁在 429 時倒數。
   * @param {string} username 帳號，去除首尾空白；長度與格式由後端驗證。
   * @param {string} password 密碼，原樣送出，不保存在前端。
   * @returns {Promise<object>} 登入後的 username、userID 與 department。
   * @throws {AuthServiceError} 後端拒絕登入（訊息取自後端）、限流、連線失敗、回應格式異常或儲存失敗。
   */
  async function login(username, password) {
    let response;
    let session;
    try {
      response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: typeof username === 'string' ? username.trim() : '', password }),
        signal: AbortSignal.timeout(15000),
      });
      session = await response.json();
    } catch { throw new AuthServiceError('無法連線登入服務，請確認後端已啟動並稍後再試', { code: 'NETWORK_ERROR' }); }
    if (!response.ok) {
      const code = typeof session?.error?.code === 'string' && session.error.code ? session.error.code : 'SERVER_ERROR';
      throw new AuthServiceError(session?.error?.message || '登入失敗，請稍後再試',
        { status: response.status, code, retryAfter: readRetryAfter(session, response.headers?.get?.('Retry-After')) });
    }
    if (!isValidUser(session?.user) || typeof session.token !== 'string' || !session.token || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
      throw new AuthServiceError('登入服務回應格式異常，請稍後再試', { status: response.status, code: 'INVALID_RESPONSE' });
    }
    const stored = { token: session.token, expiresAt: session.expiresAt,
      user: { username: session.user.username, userID: session.user.userID, ...(session.user.role ? { role: session.user.role } : {}), department: { id: session.user.department.id, name: session.user.department.name } } };
    try { sessionStorage().setItem(SESSION_KEY, JSON.stringify(stored)); } catch {
      throw new AuthServiceError('無法保存登入狀態，請允許網站儲存資料後再試', { code: 'STORAGE_UNAVAILABLE' });
    }
    return stored.user;
  }
  /** 查詢尚未到期的前端身分。@returns {object|null} username、userID 與 department。 */
  function getCurrentUser() { return getSession()?.user ?? null; }
  /** 取得 API 使用的憑證。@returns {string|null} 有效期內的 token。 */
  function getAccessToken() { return getSession()?.token ?? null; }
  /**
   * 清除本分頁登入狀態與「重新提出」草稿，避免下一個登入的帳號帶入上一位的內容；已核發 JWT 在期限前仍有效，並非伺服器撤銷。
   * @returns {void}
   * @throws {Error} 瀏覽器禁止操作儲存體。
   */
  function logout() {
    const target = sessionStorage();
    target.removeItem(SESSION_KEY);
    target.removeItem(DRAFT_KEY);
  }
  return { login, getCurrentUser, getAccessToken, logout };
}
export const authService = createAuthService();
