import { adminMetrics, MONITOR_POLICY } from '../services/adminMetrics.js';
import { env } from '../config/env.js';
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { requireAdmin } from '../middleware/authorize.js';
import { createRateLimiters } from '../middleware/rateLimiter.js';
import { resetClassroom } from '../services/adminService.js';
import { HttpError } from '../middleware/errorHandler.js';

const router = Router();
// 獨立計數，不被自己的重置清除；避免一般 IP 限流耗盡後管理員無法維護。
const adminLimits = createRateLimiters();
const monitorLimits = createRateLimiters({ ...env, httpRateWindowSeconds: MONITOR_POLICY.windowSeconds, httpApiLimit: MONITOR_POLICY.ipLimit, httpQueryLimit: MONITOR_POLICY.userLimit });
router.get('/metrics', monitorLimits.apiRateLimiter, authenticate, requireAdmin, monitorLimits.queryRateLimiter, metrics);
router.post('/reset', adminLimits.apiRateLimiter, authenticate, requireAdmin, adminLimits.ticketRateLimiter, reset);

/**
 * 驗證不可逆清除的確認文字，再清空工作單與全部一般保護計數。
 * @param {object} req 含管理員身分及 confirmation 的請求。
 * @param {object} res 回傳不含工作單原文的摘要。
 * @returns {Promise<void>} 完成重置回應。
 * @throws {HttpError} 缺少確認文字回 400；儲存失敗回 503。
 */
async function reset(req, res) {
  if (req.body?.confirmation !== 'RESET_HELPDESK') throw new HttpError(400, 'INVALID_PAYLOAD', '請輸入 RESET_HELPDESK 確認清除所有工作單與重置用量');
  res.json(await resetClassroom(req.user));
}
export default router;

/**
 * 回傳目前程序的唯讀監測資料；與重置使用不同計數，不扣 AI、業務查詢或管理清除額度。
 * 不加入業務工作追蹤，維護等待期間仍可查看狀態；no-store 由 server 統一設定。
 * @param {object} req 已驗證的 ADMIN 請求。
 * @param {object} res Express 回應。
 * @returns {Promise<void>} 監測快照。
 */
async function metrics(req, res) { res.json(await adminMetrics()); }
