import { API_BASE_URL } from '../config.js';
const SESSION_KEY = 'helpdesk.session.v2';

/**
 * 檢查十組帳號的固定識別碼，實際身分仍必須由後端簽章驗證。
 * @param {unknown} userID 待檢查識別碼。
 * @returns {boolean} 是否為 user-admin1～user-admin10。
 */
export function isKnownUserID(userID) { return typeof userID === 'string' && /^user-admin(?:[1-9]|10)$/.test(userID); }

/**
 * 建立後端登入服務，以目前分頁的 sessionStorage 保存憑證、期限與身分，不保存密碼。
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
      if (!session || !isKnownUserID(session.user?.userID) || session.user.userID !== `user-${session.user.username}`
        || typeof session.token !== 'string' || !session.token || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) return null;
      return session;
    } catch { return null; }
  }
  /**
   * 將帳密送至後端登入端點；成功後僅保存後端核發的身分與憑證。
   * @param {string} username 帳號，去除首尾空白。
   * @param {string} password 密碼，不保存在前端。
   * @returns {Promise<object>} 登入後的 username 與 userID。
   * @throws {Error} 後端拒絕登入、限流、連線或儲存失敗。
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
    } catch { throw new Error('無法連線登入服務，請確認後端已啟動並稍後再試。'); }
    if (!response.ok) throw new Error(session?.error?.message || '登入失敗，請稍後再試。');
    if (!isKnownUserID(session?.user?.userID) || session.user.userID !== `user-${session.user.username}`
      || typeof session.token !== 'string' || !session.token || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
      throw new Error('登入服務回應格式異常，請稍後再試。');
    }
    try { sessionStorage().setItem(SESSION_KEY, JSON.stringify(session)); } catch {
      throw new Error('無法保存登入狀態，請允許網站儲存資料後再試。');
    }
    return session.user;
  }
  /** 查詢尚未到期的前端身分。@returns {object|null} username 與 userID。 */
  function getCurrentUser() { return getSession()?.user ?? null; }
  /** 取得 API 使用的憑證。@returns {string|null} 有效期內的 token。 */
  function getAccessToken() { return getSession()?.token ?? null; }
  /**
   * 清除本分頁登入狀態；已核發 JWT 在期限前仍有效，並非伺服器撤銷。
   * @returns {void}
   * @throws {Error} 瀏覽器禁止操作儲存體。
   */
  function logout() { sessionStorage().removeItem(SESSION_KEY); }
  return { login, getCurrentUser, getAccessToken, logout };
}
export const authService = createAuthService();
