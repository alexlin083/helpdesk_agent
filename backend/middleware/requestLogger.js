import { randomUUID } from 'node:crypto';
import { logger, requestContext } from '../utils/logger.js';

/**
 * 為每個 HTTP 請求建立獨立識別碼，串起檢索與推理日誌；不記錄本文、標頭或查詢參數。
 * @param {import('express').Request} req HTTP 請求。
 * @param {import('express').Response} res HTTP 回應。
 * @param {import('express').NextFunction} next 後續 middleware。
 * @returns {void}
 */
export function requestLogger(req, res, next) {
  const started = Date.now();
  const requestId = randomUUID();
  const endpoint = ['/api/health', '/api/agent/chat', '/api/agent/usage', '/api/auth/login'].includes(req.path) ? req.path : '[other]';
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
