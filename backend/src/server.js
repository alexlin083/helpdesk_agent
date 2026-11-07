import { createOriginGuard } from './middleware/originGuard.js';
import adminRoutes from './routes/adminRoutes.js';
import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { closeOnShutdown } from './middleware/closeOnShutdown.js';
import { apiRateLimiter, loginRateLimiter } from './middleware/rateLimiter.js';

// 只建立 Express app；由 index.js 負責監聽，測試可直接匯入 app。
export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.trustProxy);
// 關機中的回應一律帶 Connection: close，讓代理的 keep-alive 連線在回應後關閉，優雅關機不必等到強制逾時。
app.use(closeOnShutdown);
app.use(requestLogger);
app.use('/api', noStore, createOriginGuard());
app.use(cors({
  origin: env.corsOrigin,
  methods: ['GET', 'POST', 'OPTIONS'], // GET 供健康檢查、部門名單、需求單查詢與管理監測使用。
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
  exposedHeaders: ['Retry-After', 'X-User-Remaining', 'X-Global-Remaining'],
}));
// 管理路徑不在此解析本文：adminRoutes 依「IP 限流 → JSON 解析 → 驗證 → 角色 → 帳號限流」順序掛載，
// 讓格式錯誤、過大或不支援格式的本文（400／413／415）也先計入管理 IP 限流，大量惡意本文會在超限後得到 429。
// 未對應任何管理路由的 /api/admin/* 請求會落到下方一般 IP 限流與 JSON 解析，同樣先計數再解析。
app.use('/api/admin', adminRoutes);
app.use('/api', apiRateLimiter);
app.post('/api/auth/login', loginRateLimiter);
app.use(express.json({ limit: '16kb' }));
app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

/**
 * 禁止瀏覽器及代理快取 API 成功與錯誤回應，避免跨帳號資料或舊限流訊息被重用。
 * 目前 Caddy 不快取 API；若另加 CDN，仍須明確停用 API 快取，不能只依賴此標頭。
 * @param {object} req Express 請求。
 * @param {object} res Express 回應。
 * @param {Function} next 繼續路由。
 * @returns {void}
 */
function noStore(req, res, next) { res.set('Cache-Control', 'no-store'); next(); }
