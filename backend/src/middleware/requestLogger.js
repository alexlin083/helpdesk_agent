import { randomUUID } from 'node:crypto';
import { logger, requestContext } from '../utils/logger.js';

/**
 * 為每個 HTTP 請求建立獨立識別碼，串起需求單判斷日誌；只記錄方法與已知端點（簽核、轉單與取消路徑以 :id 取代單號，其餘記為 [other]），不記錄本文、標頭或查詢參數。
 * @param {import('express').Request} req HTTP 請求。
 * @param {import('express').Response} res HTTP 回應。
 * @param {import('express').NextFunction} next 後續 middleware。
 * @returns {void}
 */
export function requestLogger(req, res, next) {
  const started = Date.now();
  const requestId = randomUUID();
  const known = ['/api/health', '/api/auth/login', '/api/departments', '/api/tickets', '/api/tickets/mine', '/api/tickets/department', '/api/tickets/completed'];
  const action = /^\/api\/tickets\/[^/]+\/(decision|transfer|cancel)$/.exec(req.path);
  const endpoint = known.includes(req.path) ? req.path : action ? `/api/tickets/:id/${action[1]}` : '[other]';
  /**
   * 在 AsyncLocalStorage 範圍內處理請求，讓非同步服務自動取得相同 requestId。
   * @returns {void}
   */
  function handleRequest() {
    logger('info', 'http.request.started', { method: req.method, endpoint });
    /**
     * 於回應結束或連線中斷時寫入最終狀態，並移除監聽器避免重複記錄。
     * @returns {void}
     */
    function completed() {
      res.off('finish', completed);
      res.off('close', completed);
      logger('info', 'http.request.completed', { requestId, endpoint, status: res.statusCode, completed: res.writableFinished, durationMs: Date.now() - started });
    }
    res.once('finish', completed);
    res.once('close', completed);
    next();
  }
  requestContext.run({ requestId }, handleRequest);
}
