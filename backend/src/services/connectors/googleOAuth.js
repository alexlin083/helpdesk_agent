// Google OAuth 2.0 的端點；只用授權碼流程加 PKCE（S256），不使用隱含流程，也不把權杖交給前端
export const GOOGLE_ENDPOINTS = Object.freeze({
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
});
// 對 Google 的每次請求最多等待的毫秒數；逾時一律當成暫時失敗，不重試
const REQUEST_TIMEOUT_MS = 10000;

/**
 * 組出 Google 授權網址：要求離線存取（取得 refresh token）、每次都顯示同意畫面（換權限等級時一定拿到新的授權），不沿用其他已授權的範圍
 * @param {{clientId: string, redirectUri: string, scopes: string[], state: string, codeChallenge: string}} options 參數
 * @returns {string} 讓瀏覽器前往的授權網址
 */
export function buildAuthorizeUrl({ clientId, redirectUri, scopes, state, codeChallenge }) {
  const url = new URL(GOOGLE_ENDPOINTS.authorize);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '), state,
    code_challenge: codeChallenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false',
  }).toString();
  return url.href;
}

/**
 * 從 Google 回傳的 id_token 取出 email；id_token 是透過 TLS 直接向 Google 權杖端點取得的，這裡只解開內容、不另外驗簽
 * @param {unknown} idToken id_token
 * @returns {string} email，取不到時為空字串
 */
export function emailFromIdToken(idToken) {
  if (typeof idToken !== 'string') return '';
  const payload = idToken.split('.')[1];
  if (!payload) return '';
  try {
    const email = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).email;
    return typeof email === 'string' && email.length <= 254 ? email : '';
  } catch { return ''; }
}

/**
 * 建立呼叫 Google OAuth 端點的用戶端；fetch 可注入，測試不連外
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options={}] 選項
 * @returns {{exchangeCode: Function, refresh: Function, revoke: Function}} 換權杖、更新存取權杖、撤銷授權
 */
export function createGoogleOAuth({ fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  /**
   * 以表單格式 POST 到 Google，回傳 JSON；網路錯誤、逾時與非 2xx 都轉成帶代碼的錯誤，訊息不含任何權杖
   * @param {string} url 端點
   * @param {Record<string, string>} form 表單欄位
   * @returns {Promise<object>} 回應 JSON
   * @throws {Error} code OAUTH_INVALID_GRANT（授權已撤銷或過期）、OAUTH_UNAUTHORIZED_CLIENT（授權不屬於這個用戶端，例如管理員換了用戶端）、OAUTH_REJECTED（其他 4xx）、OAUTH_UNAVAILABLE（網路、逾時、5xx）
   */
  async function post(url, form) {
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw Object.assign(new Error('無法連線到 Google'), { code: 'OAUTH_UNAVAILABLE' });
    }
    let body = {};
    try { body = await response.json(); } catch { body = {}; }
    if (response.ok) return body;
    if (body?.error === 'invalid_grant') throw Object.assign(new Error('Google 授權已失效'), { code: 'OAUTH_INVALID_GRANT' });
    if (body?.error === 'unauthorized_client') throw Object.assign(new Error('這個授權不屬於目前的用戶端'), { code: 'OAUTH_UNAUTHORIZED_CLIENT' });
    if (response.status >= 500) throw Object.assign(new Error('Google 暫時無法回應'), { code: 'OAUTH_UNAVAILABLE' });
    throw Object.assign(new Error('Google 拒絕這次請求'), { code: 'OAUTH_REJECTED', googleError: typeof body?.error === 'string' ? body.error.slice(0, 60) : undefined });
  }
  return {
    /**
     * 以授權碼與 PKCE 驗證碼換取權杖
     * @param {{clientId: string, clientSecret: string, code: string, codeVerifier: string, redirectUri: string}} options 參數
     * @returns {Promise<{refreshToken: string, accessToken: string, expiresIn: number, email: string, scope: string}>} 權杖與帳號
     * @throws {Error} post 的錯誤；Google 沒有給 refresh token 時 code OAUTH_NO_REFRESH_TOKEN
     */
    async exchangeCode({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
      const body = await post(GOOGLE_ENDPOINTS.token, { client_id: clientId, client_secret: clientSecret, code, code_verifier: codeVerifier, grant_type: 'authorization_code', redirect_uri: redirectUri });
      if (typeof body.refresh_token !== 'string' || !body.refresh_token) throw Object.assign(new Error('Google 沒有回傳長期授權'), { code: 'OAUTH_NO_REFRESH_TOKEN' });
      return { refreshToken: body.refresh_token, accessToken: String(body.access_token ?? ''), expiresIn: Number(body.expires_in) || 0, email: emailFromIdToken(body.id_token), scope: String(body.scope ?? '') };
    },
    /**
     * 以 refresh token 換新的存取權杖
     * @param {{clientId: string, clientSecret: string, refreshToken: string}} options 參數
     * @returns {Promise<{accessToken: string, expiresIn: number}>} 存取權杖與有效秒數
     * @throws {Error} post 的錯誤（授權被撤銷時 OAUTH_INVALID_GRANT）
     */
    async refresh({ clientId, clientSecret, refreshToken }) {
      const body = await post(GOOGLE_ENDPOINTS.token, { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
      if (typeof body.access_token !== 'string' || !body.access_token) throw Object.assign(new Error('Google 沒有回傳存取權杖'), { code: 'OAUTH_REJECTED' });
      return { accessToken: body.access_token, expiresIn: Number(body.expires_in) || 0 };
    },
    /**
     * 撤銷授權；失敗只回傳 false，中斷連接時不因 Google 失敗而保留本地授權
     * @param {string} token refresh token 或存取權杖
     * @returns {Promise<boolean>} 撤銷成功時 true
     */
    async revoke(token) {
      try { await post(GOOGLE_ENDPOINTS.revoke, { token }); return true; } catch { return false; }
    },
  };
}
