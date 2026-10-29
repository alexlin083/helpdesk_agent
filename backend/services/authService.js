import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/errorHandler.js';
import { accountService } from './accountService.js';

// 課堂帳號與獨立管理員取自 data/accounts.json（含所屬部門）；使用者代號固定為 user- 加帳號。
export const ACCOUNTS = accountService.usernames;

/**
 * 由固定帳號推導可信任身分，僅接受帳號設定檔內的帳號（區分大小寫，不做大小寫正規化）。
 * @param {unknown} username 帳號。
 * @param {object} [accounts=accountService] 帳號查詢服務，可注入測試替身。
 * @returns {object|null} username、userID（user- 加帳號）、role 與所屬部門 department（id、name），不含密碼。
 */
export function accountFor(username, accounts = accountService) {
  return accounts.find(username);
}

/**
 * 建立 HS256 登入憑證服務；正式環境需穩定的 AUTH_SECRET，本機未設定時用隨機金鑰。
 * @param {object} [config=env] 含 secret、展示密碼與有效秒數的設定。
 * @param {object} [accounts=accountService] 帳號查詢服務。
 * @returns {object} credentials、issue、verify 操作。
 */
export function createAuthService(config = env, accounts = accountService) {
  const secret = new TextEncoder().encode(config.authSecret || randomBytes(32).toString('hex'));
  const userPassword = createHash('sha256').update(config.demoPassword).digest();
  const adminPassword = createHash('sha256').update(config.adminPassword).digest();
  return {
    /**
     * 依後端角色選擇一般或獨立管理密碼，再使用固定長度摘要進行時間安全比對；不接受前端指定角色。
     * @param {string} username 去空白後帳號。
     * @param {string} password 輸入密碼。
     * @returns {object|null} 正確時回傳身分（含部門），錯誤時回傳 null。
     */
    credentials(username, password) {
      const supplied = createHash('sha256').update(typeof password === 'string' ? password : '').digest();
      const account = accountFor(username, accounts);
      const expected = account?.role === 'ADMIN' ? adminPassword : userPassword;
      return timingSafeEqual(expected, supplied) ? account : null;
    },
    /**
     * 簽發兩小時（可設定）的憑證，限制演算法、發行者與受眾；部門與角色不寫入憑證，驗證時依目前設定檔查詢。
     * @param {object} user 已驗證身分。
     * @returns {Promise<object>} token、expiresAt 與 user（username、userID、role、department），不包含密碼。
     */
    async issue(user) {
      const issued = Math.floor(Date.now() / 1000);
      const exp = issued + config.authTtlSeconds;
      const token = await new SignJWT({ username: user.username }).setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.userID).setIssuedAt(issued).setExpirationTime(exp)
        .setIssuer('helpdesk').setAudience('helpdesk-chat').sign(secret);
      return { token, expiresAt: exp * 1000, user: accountFor(user.username, accounts) ?? user };
    },
    /**
     * 驗證簽章、有效期限、發行者、受眾與帳號對應，不接受本文偽造的 userID；帳號已從設定檔移除時視為無效。
     * @param {string} token Bearer 憑證。
     * @returns {Promise<object>} 已驗證的帳號、userID、role 與所屬部門。
     * @throws {HttpError} 缺少、過長、過期或遭修改的憑證。
     */
    async verify(token) {
      try {
        if (typeof token !== 'string' || token.length > 2048) throw new Error('invalid');
        const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], issuer: 'helpdesk', audience: 'helpdesk-chat', requiredClaims: ['exp', 'iat', 'sub'] });
        const user = accountFor(payload.username, accounts);
        if (!user || user.userID !== payload.sub) throw new Error('invalid');
        return user;
      } catch { throw new HttpError(401, 'UNAUTHORIZED', '登入已失效，請重新登入'); }
    },
  };
}
export const authService = createAuthService();
