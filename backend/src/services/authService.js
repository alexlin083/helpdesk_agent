import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/errorHandler.js';
import { accountService } from './personnel/accountService.js';
import { DEMO_ACCOUNTS } from './personnel/demoPersonnel.js';
import { dataStore } from './storage/dataStore.js';

// 示範名冊（demoPersonnel.js，假資料）的帳號名稱（依名冊順序），供測試與工具取得全新資料庫的預設帳號；使用者代號固定為 user- 加帳號。
// 執行中可登入的帳號以 SQLite 的 accounts 資料表為準（accountService.usernames）；資料庫可能已由 scripts/personnel.js 調整，與名冊不同。
export const ACCOUNTS = Object.freeze(DEMO_ACCOUNTS.map(/** 取帳號名稱。@param {{username: string}} account 名冊帳號。@returns {string} 帳號。 */ (account) => account.username));

/**
 * 由帳號推導可信任身分，僅接受資料庫中啟用且部門存在的帳號（區分大小寫，不做大小寫正規化）。
 * @param {unknown} username 帳號。
 * @param {object} [accounts=accountService] 帳號查詢服務，可注入測試替身。
 * @returns {object|null} username、userID（user- 加帳號）、role 與所屬部門 department（id、name），不含密碼；查無或已停用時 null。
 * @throws {HttpError} 503 帳號資料庫無法讀取。
 */
export function accountFor(username, accounts = accountService) {
  return accounts.find(username);
}

/**
 * 預設的本機金鑰來源：向共用的需求單資料庫取得（必要時建立）meta 表中的 local_auth_secret。
 * @returns {string} 64 個十六進位字元的金鑰。
 * @throws {HttpError} 503 資料庫無法開啟或寫入。
 */
function storedLocalSecret() {
  return dataStore.localAuthSecret();
}

/**
 * 建立 HS256 登入憑證服務；正式環境需穩定的 AUTH_SECRET（env 在 production 缺少時拒絕啟動）。
 * 本機未設定 AUTH_SECRET 時，第一次簽發或驗證憑證才向 localSecret 取得保存在 SQLite meta 表的金鑰（不存在時自動產生），
 * 讓 npm run dev（node --watch）因程式變更重新啟動後，既有登入仍然有效；資料庫無法使用時退回只存在記憶體的隨機金鑰（重啟後需重新登入）。
 * @param {object} [config=env] 含 secret、展示密碼與有效秒數的設定。
 * @param {object} [accounts=accountService] 帳號查詢服務。
 * @param {object} [options={}] 選項。
 * @param {() => string} [options.localSecret] 取得本機金鑰的函式，預設 dataStore.localAuthSecret；測試可注入。
 * @returns {object} credentials、issue、verify 操作。
 */
export function createAuthService(config = env, accounts = accountService, { localSecret = storedLocalSecret } = {}) {
  let secret = config.authSecret ? new TextEncoder().encode(config.authSecret) : null;
  /**
   * 取得簽章金鑰；第一次呼叫時決定並快取，之後沿用同一把。
   * @returns {Uint8Array} HS256 金鑰位元組。
   */
  function signingKey() {
    if (secret) return secret;
    let value;
    try { value = localSecret(); } catch { value = randomBytes(32).toString('hex'); }
    secret = new TextEncoder().encode(value);
    return secret;
  }
  const userPassword = createHash('sha256').update(config.demoPassword).digest();
  const adminPassword = createHash('sha256').update(config.adminPassword).digest();
  return {
    /**
     * 依後端角色選擇一般或獨立管理密碼，再使用固定長度摘要進行時間安全比對；不接受前端指定角色。
     * @param {string} username 去空白後帳號。
     * @param {string} password 輸入密碼。
     * @returns {object|null} 正確時回傳身分（含部門），錯誤、查無或已停用的帳號回傳 null。
     * @throws {HttpError} 503 帳號資料庫無法讀取。
     */
    credentials(username, password) {
      const supplied = createHash('sha256').update(typeof password === 'string' ? password : '').digest();
      const account = accountFor(username, accounts);
      const expected = account?.role === 'ADMIN' ? adminPassword : userPassword;
      return timingSafeEqual(expected, supplied) ? account : null;
    },
    /**
     * 簽發兩小時（可設定）的憑證，限制演算法、發行者與受眾；部門與角色不寫入憑證，驗證時依資料庫目前的帳號查詢。
     * @param {object} user 已驗證身分。
     * @returns {Promise<object>} token、expiresAt 與 user（username、userID、role、department），不包含密碼。
     */
    async issue(user) {
      const issued = Math.floor(Date.now() / 1000);
      const exp = issued + config.authTtlSeconds;
      const token = await new SignJWT({ username: user.username }).setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.userID).setIssuedAt(issued).setExpirationTime(exp)
        .setIssuer('helpdesk').setAudience('helpdesk-chat').sign(signingKey());
      return { token, expiresAt: exp * 1000, user: accountFor(user.username, accounts) ?? user };
    },
    /**
     * 驗證簽章、有效期限、發行者、受眾與帳號對應，不接受本文偽造的 userID；帳號已停用或部門已不存在時視為無效。
     * 帳號資料庫無法讀取時原樣拋出 503，不誤報為憑證失效。
     * @param {string} token Bearer 憑證。
     * @returns {Promise<object>} 已驗證的帳號、userID、role 與所屬部門。
     * @throws {HttpError} 401 缺少、過長、過期、遭修改或帳號不可使用的憑證；503 帳號資料庫無法讀取。
     */
    async verify(token) {
      try {
        if (typeof token !== 'string' || token.length > 2048) throw new Error('invalid');
        const { payload } = await jwtVerify(token, signingKey(), { algorithms: ['HS256'], issuer: 'helpdesk', audience: 'helpdesk-chat', requiredClaims: ['exp', 'iat', 'sub'] });
        const user = accountFor(payload.username, accounts);
        if (!user || user.userID !== payload.sub) throw new Error('invalid');
        return user;
      } catch (error) {
        if (error instanceof HttpError && error.status === 503) throw error;
        throw new HttpError(401, 'UNAUTHORIZED', '登入已失效，請重新登入');
      }
    },
  };
}
export const authService = createAuthService();
