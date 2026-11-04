import { requireUser } from '../middleware/authorize.js';
import { trackRequest } from '../services/taskTracker.js';
import { Router } from 'express';
import { myLeaveBalance } from '../controllers/leaveController.js';
import { authenticate } from '../middleware/authenticate.js';
import { queryRateLimiter } from '../middleware/rateLimiter.js';

// 目前登入者本人的資料：只回傳憑證身分自己的假別時數，與需求單查詢共用 HTTP_QUERY_LIMIT 計數。
const router = Router();
router.get('/leave-balance', authenticate, requireUser, queryRateLimiter, trackRequest(myLeaveBalance));

export default router;
