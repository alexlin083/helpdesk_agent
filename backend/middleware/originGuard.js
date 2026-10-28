import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { HttpError } from './errorHandler.js';

/**
 * 建立 CloudFront 來源驗證；設定秘密後，除健康檢查外所有 API（含預檢）必須由代理附上標頭。
 * CloudFront 應覆寫 X-Origin-Verify，秘密只存在 AWS 與後端，不得交給瀏覽器。
 * 此標頭不取代 HTTPS 或 security group；未設定時保持本機與初次 EB 驗證可用。
 * @param {string} [secret=env.originVerifySecret] 至少 32 bytes 的代理秘密；空字串代表停用。
 * @returns {Function} Express middleware。
 */
export function createOriginGuard(secret = env.originVerifySecret) {
  const expected = createHash('sha256').update(secret).digest();
  /**
   * 以固定長度摘要比對來源標頭，避免直接用字串逐字比較；健康檢查不回傳業務資料。
   * @param {object} req Express 請求，掛載於 /api。
   * @param {object} res Express 回應。
   * @param {Function} next 驗證通過後繼續。
   * @returns {void}
   * @throws {HttpError} 缺少或錯誤的來源秘密回 403。
   */
  return function originGuard(req, res, next) {
    if (!secret || (req.method === 'GET' && /^\/health\/?$/i.test(req.path))) { next(); return; }
    const supplied = createHash('sha256').update(req.get('X-Origin-Verify') || '').digest();
    if (!timingSafeEqual(expected, supplied)) throw new HttpError(403, 'FORBIDDEN', '請透過正式 API 網址存取服務');
    next();
  };
}
