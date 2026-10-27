import { Router } from 'express';
import { listDepartments } from '../controllers/ticketController.js';
import { authenticate } from '../middleware/authenticate.js';
import { departmentRateLimiter } from '../middleware/rateLimiter.js';

// 部門與處理人名單：需要憑證，不呼叫 Gemini、不扣額度；方法不符一律回 404。
const router = Router();
router.get('/', authenticate, departmentRateLimiter, listDepartments);

export default router;
