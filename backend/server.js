import { createOriginGuard } from './middleware/originGuard.js';
import adminRoutes from './routes/adminRoutes.js';
import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import routes from './routes.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { apiRateLimiter, loginRateLimiter } from './middleware/rateLimiter.js';

// 只建立 Express app；由 index.js 負責監聽，測試可直接匯入 app。
export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.trustProxy);
app.use(requestLogger);
app.use('/api', noStore, createOriginGuard());
app.use(cors({
  origin: env.corsOrigin,
  methods: ['GET', 'POST', 'OPTIONS'], // GET 供健康檢查、用量查詢與部門名單使用。
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
  exposedHeaders: ['Retry-After', 'X-User-Remaining', 'X-Global-Remaining'],
}));
app.use('/api/admin', express.json({ limit: '16kb' }), adminRoutes);
app.use('/api', apiRateLimiter);
app.post('/api/auth/login', loginRateLimiter);
app.use(express.json({ limit: '16kb' }));
app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

/**
 * 禁止瀏覽器及代理快取 API 成功與錯誤回應，避免跨帳號資料或舊限流訊息被重用。
 * CloudFront 仍須搭配 CachingDisabled，不能只依賴回應標頭。
 * @param {object} req Express 請求。
 * @param {object} res Express 回應。
 * @param {Function} next 繼續路由。
 * @returns {void}
 */
function noStore(req, res, next) { res.set('Cache-Control', 'no-store'); next(); }
