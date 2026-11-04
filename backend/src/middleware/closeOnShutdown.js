import { taskTracker } from '../services/taskTracker.js';

/**
 * 建立關機期間關閉持久連線的 middleware：工作追蹤器進入 stopping 後，每個回應都加上 Connection: close，
 * 讓 Node 在回應送完後關閉該連線，避免反向代理（例如 Caddy 的上游連線池）的 keep-alive 連線一直被回覆而讓 server.close() 無法完成。
 * 不拒絕請求、不改變狀態碼；尚未關機時不做任何事。
 * @param {object} [tasks=taskTracker] 提供 status() 的工作追蹤器。
 * @returns {Function} Express middleware。
 */
export function createCloseOnShutdown(tasks = taskTracker) {
  /**
   * 關機中時要求本次回應結束後關閉連線，再交給後續處理。
   * @param {import('express').Request} req 請求，不讀取內容。
   * @param {import('express').Response} res 回應；關機中會設定 Connection: close 標頭。
   * @param {import('express').NextFunction} next 繼續路由。
   * @returns {void}
   */
  return function closeOnShutdown(req, res, next) {
    if (tasks.status().stopping) res.set('Connection', 'close');
    next();
  };
}

export const closeOnShutdown = createCloseOnShutdown();
