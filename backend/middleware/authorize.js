import { HttpError } from './errorHandler.js';

/**
 * 只允許一般帳號進入工作單及部門 API；角色由 authenticate 依後端帳號設定重新取得。
 * @param {object} req 含可信任 user 的 Express 請求。
 * @param {object} res Express 回應。
 * @param {Function} next 通過後繼續執行。
 * @returns {void}
 * @throws {HttpError} 管理員或未知角色回 403。
 */
export function requireUser(req, res, next) {
  if (req.user?.role !== 'USER') throw new HttpError(403, 'FORBIDDEN', '此帳號不可使用工作單功能');
  next();
}

/**
 * 只允許後端設定為 ADMIN 的已驗證帳號操作管理功能，不信任請求本文的角色或部門。
 * @param {object} req 含可信任 user 的 Express 請求。
 * @param {object} res Express 回應。
 * @param {Function} next 通過後繼續執行。
 * @returns {void}
 * @throws {HttpError} 非管理員回 403。
 */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') throw new HttpError(403, 'FORBIDDEN', '只有管理員可以執行此操作');
  next();
}
