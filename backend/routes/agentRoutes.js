import { Router } from 'express';
import { chat } from '../controllers/agentController.js';
import { authenticate } from '../middleware/authenticate.js';
import { usageService } from '../services/usageService.js';

const router = Router();
router.use(authenticate);
router.post('/chat', chat);
router.get('/usage', usage);

/**
 * 查詢當前憑證身分的剩餘配額，不呼叫 Gemini、不消耗配額。
 * @param {import('express').Request} req 已驗證請求。
 * @param {import('express').Response} res 用量 JSON。
 * @returns {Promise<void>}
 */
async function usage(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json(await usageService.usage(req.user.userID));
}

export default router;
