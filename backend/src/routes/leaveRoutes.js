import { requireUser } from '../middleware/authorize.js';
import { trackRequest } from '../services/taskTracker.js';
import { Router } from 'express';
import { listLeaveBalances } from '../controllers/leaveController.js';
import { authenticate } from '../middleware/authenticate.js';
import { queryRateLimiter } from '../middleware/rateLimiter.js';

// 人資專用的假別時數查詢（唯讀）；是否為人資部門成員由處理器判斷（不是時 403），計入 HTTP_QUERY_LIMIT。
// 額度的扣除與調整由人資在公司既有的系統處理，本系統不提供寫入額度的端點。
const router = Router();
router.get('/balances', authenticate, requireUser, queryRateLimiter, trackRequest(listLeaveBalances));

export default router;
