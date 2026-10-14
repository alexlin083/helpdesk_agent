import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import routes from './routes.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

// 只建立 Express app；由 index.js 負責監聽，測試可直接匯入 app。
export const app = express();
app.disable('x-powered-by');
app.use(cors({
  origin: env.corsOrigin,
  methods: ['GET', 'POST', 'OPTIONS'], // GET 供健康檢查使用。
  allowedHeaders: ['Content-Type', 'Accept'],
}));
app.use(express.json({ limit: '16kb' }));
app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);
