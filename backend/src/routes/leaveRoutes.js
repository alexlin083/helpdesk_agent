import { requireUser } from '../middleware/authorize.js';
import { trackRequest } from '../services/taskTracker.js';
import { Router } from 'express';
import { listLeaveBalances, addLeaveAdjustment } from '../controllers/leaveController.js';
import { authenticate } from '../middleware/authenticate.js';
import { queryRateLimiter, ticketRateLimiter } from '../middleware/rateLimiter.js';

// 人資專用的假別時數查詢與調整；是否為人資部門成員由處理器判斷（不是時 403）。查詢計入 HTTP_QUERY_LIMIT，調整計入 HTTP_TICKET_LIMIT。
const router = Router();
router.get('/balances', authenticate, requireUser, queryRateLimiter, trackRequest(listLeaveBalances));
router.post('/adjustments', authenticate, requireUser, ticketRateLimiter, trackRequest(addLeaveAdjustment));

export default router;
