import { requireUser } from '../middleware/authorize.js';
import { trackRequest } from '../services/taskTracker.js';
import { Router } from 'express';
import { submitTicket, listMyTickets, listDepartmentTickets, listCompletedTickets, decideTicket, transferTicket, cancelTicket } from '../controllers/ticketController.js';
import { submitDraft } from '../controllers/requestTypeController.js';
import { authenticate } from '../middleware/authenticate.js';
import { ticketRateLimiter, queryRateLimiter, draftRateLimiter } from '../middleware/rateLimiter.js';

// 憑證驗證掛在各路由本身，讓方法不符（例如 PUT /api/tickets）一律回 404，而不是 401。
// 自動生成對話（/draft）使用獨立的 HTTP_DRAFT_LIMIT 計數，處理器自行納入工作追蹤。
const router = Router();
router.post('/', authenticate, requireUser, ticketRateLimiter, submitTicket);
router.post('/draft', authenticate, requireUser, draftRateLimiter, submitDraft);
router.get('/mine', authenticate, requireUser, queryRateLimiter, trackRequest(listMyTickets));
router.get('/department', authenticate, requireUser, queryRateLimiter, trackRequest(listDepartmentTickets));
router.get('/completed', authenticate, requireUser, queryRateLimiter, trackRequest(listCompletedTickets));
router.post('/:id/decision', authenticate, requireUser, ticketRateLimiter, trackRequest(decideTicket));
router.post('/:id/transfer', authenticate, requireUser, ticketRateLimiter, trackRequest(transferTicket));
router.post('/:id/cancel', authenticate, requireUser, ticketRateLimiter, trackRequest(cancelTicket));

export default router;
