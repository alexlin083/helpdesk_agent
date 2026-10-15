import { runHelpdeskAgent } from '../services/geminiAgent.js';
import { HttpError } from '../middleware/errorHandler.js';
import { usageService } from '../services/usageService.js';
import { logger } from '../utils/logger.js';

/**
 * 建立對話處理器，驗證輸入與憑證身分後才預扣配額；所有結果均釋放並行租約。
 * @param {Function} [reply=runHelpdeskAgent] Agent 推理函式。
 * @param {object} [usage=usageService] 配額服務，可注入測試替身。
 * @returns {Function} Express 非同步處理器。
 */
export function createChatHandler(reply = runHelpdeskAgent, usage = usageService) {
  /**
   * 接收一次對話並回傳原決策 JSON，剩餘用量以公開回應標頭提供。
   * @param {import('express').Request} req 已由 authenticate 加入 req.user。
   * @param {import('express').Response} res 回應。
   * @returns {Promise<void>}
   * @throws {HttpError} 未登入、格式錯誤、身分不符、限流或上游失敗。
   */
  return async function chatHandler(req, res) {
    if (!req.user) throw new HttpError(401, 'UNAUTHORIZED', '請先登入');
    const message = req.body?.message;
    if (typeof message !== 'string' || !message.trim() || Array.from(message.trim()).length > 500) {
      throw new HttpError(400, 'INVALID_PAYLOAD', 'message 必須是 1 到 500 字元的非空白字串');
    }

    if (req.body.userID !== req.user.userID) throw new HttpError(403, 'USER_ID_MISMATCH', '使用者識別碼與登入身分不符');
    const reservation = await usage.reserve(req.user.userID);
    res.set('X-User-Remaining', String(reservation.usage.userRemaining));
    res.set('X-Global-Remaining', String(reservation.usage.globalRemaining));
    logger('info', 'limits.reserved', { userID: req.user.userID, ...reservation.usage });
    try {
      const result = await reply(message.trim());
      res.json(result);
    } finally { await usage.release(req.user.userID, reservation.id); }
  };
}

export const chat = createChatHandler();
