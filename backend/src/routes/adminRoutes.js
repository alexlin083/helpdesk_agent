import { adminMetrics, MONITOR_POLICY } from '../services/admin/adminMetrics.js';
import { env } from '../config/env.js';
import express, { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { requireAdmin } from '../middleware/authorize.js';
import { createRateLimiters } from '../middleware/rateLimiter.js';
import { resetClassroom } from '../services/admin/adminService.js';
import { HttpError } from '../middleware/errorHandler.js';
import { googleSettings, saveGoogleSettings } from '../controllers/connectorController.js';
import { holidaySync } from '../services/holidays/index.js';

const router = Router();
// 獨立計數，不被自己的重置清除；避免一般 IP 限流耗盡後管理員無法維護。
const adminLimits = createRateLimiters();
const monitorLimits = createRateLimiters({ ...env, httpRateWindowSeconds: MONITOR_POLICY.windowSeconds, httpApiLimit: MONITOR_POLICY.ipLimit, httpQueryLimit: MONITOR_POLICY.userLimit });
// JSON 解析必須放在 IP 限流之後：解析失敗（400／413／415）會直接交給錯誤處理器，若先解析，惡意本文洪流永遠不會被計數。
const parseJson = express.json({ limit: '16kb' });
router.get('/metrics', monitorLimits.apiRateLimiter, parseJson, authenticate, requireAdmin, monitorLimits.queryRateLimiter, metrics);
router.post('/reset', adminLimits.apiRateLimiter, parseJson, authenticate, requireAdmin, adminLimits.ticketRateLimiter, reset);
// Google 連接設定：管理員貼上 OAuth 用戶端；查詢與監測共用計數，儲存與重置共用計數；回應永遠不含 client secret
router.get('/connectors/google', monitorLimits.apiRateLimiter, parseJson, authenticate, requireAdmin, monitorLimits.queryRateLimiter, googleSettings);
router.post('/connectors/google', adminLimits.apiRateLimiter, parseJson, authenticate, requireAdmin, adminLimits.ticketRateLimiter, saveGoogleSettings);
// 假日資料：查看與監測共用計數；檢查、套用與還原會向外部來源請求或寫入資料庫，與儲存、重置共用計數
router.get('/holidays', monitorLimits.apiRateLimiter, parseJson, authenticate, requireAdmin, monitorLimits.queryRateLimiter, holidayStatus);
router.post('/holidays/check', adminLimits.apiRateLimiter, parseJson, authenticate, requireAdmin, adminLimits.ticketRateLimiter, checkHolidays);
router.post('/holidays/apply', adminLimits.apiRateLimiter, parseJson, authenticate, requireAdmin, adminLimits.ticketRateLimiter, applyHolidays);
router.post('/holidays/revert', adminLimits.apiRateLimiter, parseJson, authenticate, requireAdmin, adminLimits.ticketRateLimiter, revertHolidays);

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

/**
 * 回傳假日資料摘要：來源、可同步的最晚年度，以及每個有資料的年度目前使用的假日與來源（定義檔或同步）。
 * @param {object} req 已驗證的 ADMIN 請求。
 * @param {object} res Express 回應。
 * @returns {void}
 * @throws {HttpError} 503 TICKET_STORE_UNAVAILABLE。
 */
function holidayStatus(req, res) { res.json(holidaySync.status()); }

/**
 * 檢查某年度的來源資料並列出和目前的差異；不寫入。本文 { year }。
 * @param {object} req 已驗證的 ADMIN 請求。
 * @param {object} res Express 回應。
 * @returns {Promise<void>} 完成回應。
 * @throws {HttpError} 見 holidaySync.check。
 */
async function checkHolidays(req, res) { res.json(await holidaySync.check(req.body?.year)); }

/**
 * 套用某年度的來源資料；本文 { year, digest }，digest 必須是檢查結果的摘要值。
 * @param {object} req 已驗證的 ADMIN 請求。
 * @param {object} res Express 回應。
 * @returns {Promise<void>} 完成回應。
 * @throws {HttpError} 見 holidaySync.apply。
 */
async function applyHolidays(req, res) { res.json(await holidaySync.apply(req.body, req.user.username)); }

/**
 * 還原某年度：刪掉同步資料、改回定義檔的假日；本文 { year }。
 * @param {object} req 已驗證的 ADMIN 請求。
 * @param {object} res Express 回應。
 * @returns {void}
 * @throws {HttpError} 見 holidaySync.revert。
 */
function revertHolidays(req, res) { res.json(holidaySync.revert(req.body, req.user.username)); }
