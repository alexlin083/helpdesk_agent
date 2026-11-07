import { requireUser } from '../middleware/authorize.js';
import { trackRequest } from '../services/taskTracker.js';
import { Router } from 'express';
import { listRequestTypes } from '../controllers/requestTypeController.js';
import { authenticate } from '../middleware/authenticate.js';
import { departmentRateLimiter } from '../middleware/rateLimiter.js';

// 需求類型清單（data/requestTypes 的目錄與定義）：需要憑證、只允許 USER，不呼叫 Gemini、不扣額度；與部門名單共用 HTTP_DEPARTMENTS_LIMIT 計數。
const router = Router();
router.get('/', authenticate, requireUser, departmentRateLimiter, trackRequest(listRequestTypes));

export default router;
