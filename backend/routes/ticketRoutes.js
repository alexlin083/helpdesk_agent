import { Router } from 'express';
import { submitTicket, listMyTickets, listDepartmentTickets, listCompletedTickets, decideTicket, transferTicket, cancelTicket } from '../controllers/ticketController.js';
import { authenticate } from '../middleware/authenticate.js';
import { ticketRateLimiter, queryRateLimiter } from '../middleware/rateLimiter.js';

// 憑證驗證掛在各路由本身，讓方法不符（例如 PUT /api/tickets）一律回 404，而不是 401。
const router = Router();
router.post('/', authenticate, ticketRateLimiter, submitTicket);
router.get('/mine', authenticate, queryRateLimiter, listMyTickets);
router.get('/department', authenticate, queryRateLimiter, listDepartmentTickets);
router.get('/completed', authenticate, queryRateLimiter, listCompletedTickets);
router.post('/:id/decision', authenticate, ticketRateLimiter, decideTicket);
router.post('/:id/transfer', authenticate, ticketRateLimiter, transferTicket);
router.post('/:id/cancel', authenticate, ticketRateLimiter, cancelTicket);

export default router;
