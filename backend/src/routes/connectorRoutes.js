import { Router } from 'express';
import { abandonGoogle, completeGoogle, disconnect, listConnectors, startConnect } from '../controllers/connectorController.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireUser } from '../middleware/authorize.js';
import { queryRateLimiter, ticketRateLimiter } from '../middleware/rateLimiter.js';
import { trackRequest } from '../services/taskTracker.js';

// 外部服務連接：一般帳號列出與管理自己的連接；CORS 只開 GET、POST，所以中斷連接用 POST
// Google 授權後直接導回前端「連接帳號」頁，再由頁面帶登入憑證呼叫 /google/complete，後端確認是發起連接的本人才換權杖；後端沒有不需登入的回呼
// 頁面沒登入時呼叫 /google/abandon 作廢 state：不需登入（持有 state 就是憑據），只作廢、不換授權碼，經過一般 API 的 IP 限流
const router = Router();
router.get('/', authenticate, requireUser, queryRateLimiter, trackRequest(listConnectors));
router.post('/google/complete', authenticate, requireUser, ticketRateLimiter, trackRequest(completeGoogle));
router.post('/google/abandon', trackRequest(abandonGoogle));
router.post('/:id/connect', authenticate, requireUser, ticketRateLimiter, trackRequest(startConnect));
router.post('/:id/disconnect', authenticate, requireUser, ticketRateLimiter, trackRequest(disconnect));

export default router;
