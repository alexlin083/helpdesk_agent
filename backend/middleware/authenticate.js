import { authService } from '../services/authService.js';
import { HttpError } from './errorHandler.js';
import { requestContext } from '../utils/logger.js';

/**
 * 驗證 Bearer 憑證並將可信任身分放入 req.user，先於配額檢查執行。
 * @param {import('express').Request} req 請求。
 * @param {import('express').Response} res 回應。
 * @param {import('express').NextFunction} next 後續處理。
 * @returns {Promise<void>}
 * @throws {HttpError} 未登入或憑證無效。
 */
export async function authenticate(req, res, next) {
  const header = req.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) throw new HttpError(401, 'UNAUTHORIZED', '請先登入');
  req.user = await authService.verify(header.slice(7));
  const context = requestContext.getStore();
  if (context) context.userID = req.user.userID;
  next();
}
