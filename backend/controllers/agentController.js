import { runHelpdeskAgent } from '../services/geminiAgent.js';
import { HttpError } from '../middleware/errorHandler.js';

export function createChatHandler(reply = runHelpdeskAgent) {
  return async (req, res) => {
    const message = req.body?.message;
    if (typeof message !== 'string' || !message.trim() || Array.from(message.trim()).length > 500) {
      throw new HttpError(400, 'INVALID_PAYLOAD', 'message 必須是 1 到 500 字元的非空白字串');
    }

    const result = await reply(message.trim());
    res.json(result);
  };
}

export const chat = createChatHandler();
