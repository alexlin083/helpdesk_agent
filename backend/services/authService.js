import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/errorHandler.js';

/**
 * 由固定帳號推導可信任身分，僅接受 admin1～admin10。
 * @param {unknown} username 帳號。
 * @returns {object|null} 帳號與穩定 userID，不含密碼。
 */
export function accountFor(username) {
  if (typeof username !== 'string' || !/^admin(?:[1-9]|10)$/.test(username)) return null;
  return { username, userID: `user-${username}` };
}

/**
 * 建立 HS256 登入憑證服務；正式環境需穩定的 AUTH_SECRET，本機未設定時用隨機金鑰。
 * @param {object} [config=env] 含 secret、展示密碼與有效秒數的設定。
 * @returns {object} credentials、issue、verify 操作。
 */
export function createAuthService(config = env) {
  const secret = new TextEncoder().encode(config.authSecret || randomBytes(32).toString('hex'));
  const expectedPassword = createHash('sha256').update(config.demoPassword).digest();
  return {
    /**
     * 比較固定帳密，使用固定長度摘要進行時間安全的密碼比對。
     * @param {string} username 去空白後帳號。
     * @param {string} password 輸入密碼。
     * @returns {object|null} 正確時回傳身分，錯誤時回傳 null。
     */
    credentials(username, password) {
      const supplied = createHash('sha256').update(typeof password === 'string' ? password : '').digest();
      const correct = timingSafeEqual(expectedPassword, supplied);
      return correct ? accountFor(username) : null;
    },
    /**
     * 簽發兩小時（可設定）的憑證，限制演算法、發行者與受眾。
     * @param {object} user 已驗證身分。
     * @returns {Promise<object>} token、expiresAt 與 user，不包含密碼。
     */
    async issue(user) {
      const issued = Math.floor(Date.now() / 1000);
      const exp = issued + config.authTtlSeconds;
      const token = await new SignJWT({ username: user.username }).setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.userID).setIssuedAt(issued).setExpirationTime(exp)
        .setIssuer('helpdesk').setAudience('helpdesk-chat').sign(secret);
      return { token, expiresAt: exp * 1000, user };
    },
    /**
     * 驗證簽章、有效期限、發行者、受眾與帳號對應，不接受本文偽造的 userID。
     * @param {string} token Bearer 憑證。
     * @returns {Promise<object>} 已驗證的帳號與 userID。
     * @throws {HttpError} 缺少、過長、過期或遭修改的憑證。
     */
    async verify(token) {
      try {
        if (typeof token !== 'string' || token.length > 2048) throw new Error('invalid');
        const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], issuer: 'helpdesk', audience: 'helpdesk-chat', requiredClaims: ['exp', 'iat', 'sub'] });
        const user = accountFor(payload.username);
        if (!user || user.userID !== payload.sub) throw new Error('invalid');
        return user;
      } catch { throw new HttpError(401, 'UNAUTHORIZED', '登入已失效，請重新登入'); }
    },
  };
}
export const authService = createAuthService();
