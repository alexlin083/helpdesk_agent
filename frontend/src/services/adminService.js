import { API_BASE_URL } from '../config.js';
import { authService } from './authService.js';

/** 管理 API 的可辨識錯誤，保留 HTTP 狀態供畫面處理登入失效與拒絕授權。 */
export class AdminServiceError extends Error {
  /** 建立不含敏感資料的錯誤。@param {string} message 中文提示。@param {number} status HTTP 狀態，連線失敗為 0。 */
  constructor(message, status = 0) { super(message); this.name = 'AdminServiceError'; this.status = status; }
}

/**
 * 透過獨立管理 API 清空全部工作單及保護計數，使用 Bearer 憑證，不把角色放入本文。
 * 不自動重送；連線中斷可能代表伺服器仍在處理，畫面必須說明結果尚未確認。
 * @param {string} confirmation 使用者輸入的確認文字。
 * @param {object} [auth=authService] 提供 getAccessToken 的登入服務。
 * @returns {Promise<{deletedTickets: number, resetAt: string}>} 重置摘要。
 * @throws {AdminServiceError} 未登入、權限不足、格式異常、限流或連線失敗。
 */
export async function resetClassroom(confirmation, auth = authService) {
  const token = auth.getAccessToken();
  if (!token) throw new AdminServiceError('請先登入管理員帳號', 401);
  let response;
  let data;
  try {
    response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/api/admin/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ confirmation }), signal: AbortSignal.timeout(90000),
    });
    data = await response.json();
  } catch { throw new AdminServiceError('連線中斷，尚未確認重置結果；伺服器可能仍在處理，請稍後確認再操作'); }
  if (!response.ok) throw new AdminServiceError(data?.error?.message || '重置失敗，請稍後再試', response.status);
  if (!Number.isInteger(data?.deletedTickets) || data.deletedTickets < 0 || typeof data.resetAt !== 'string' || !Number.isFinite(Date.parse(data.resetAt))) {
    throw new AdminServiceError('管理服務回應格式異常，請確認重置結果');
  }
  return data;
}

/**
 * 檢查監測回應的必要欄位與數值，避免破損資料被誤顯示為零或仍在即時更新。
 * @param {unknown} data 後端快照。
 * @returns {boolean} 是否符合管理監測契約。
 */
export function isValidMetrics(data) {
  /** 驗證非負整數計數或秒數。@param {unknown} value 欄位值。@returns {boolean} 是否有效。 */
  function count(value) { return Number.isSafeInteger(value) && value >= 0; }
  /** 驗證可顯示的日期。@param {unknown} value ISO 時間字串。@returns {boolean} 是否有效。 */
  function date(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
  if (!data || !date(data.observedAt) || !Number.isSafeInteger(data.pollSeconds) || data.pollSeconds < 5 || data.pollSeconds > 60) return false;
  const { runtime, ai, login, monitoring } = data;
  if (!runtime || !date(runtime.startedAt) || !count(runtime.uptimeSeconds) || !count(runtime.pending)
    || !['local', 'production'].includes(runtime.environment) || runtime.storage !== 'memory'
    || typeof runtime.maintaining !== 'boolean' || typeof runtime.stopping !== 'boolean') return false;
  if (!ai || !date(ai.resetAt) || typeof ai.day !== 'string') return false;
  for (const key of ['used', 'remaining', 'dailyLimit', 'userDailyLimit', 'active', 'concurrencyLimit', 'userConcurrencyLimit', 'cooldownSeconds']) if (!count(ai[key])) return false;
  if (!login || !count(login.capacity) || !monitoring) return false;
  for (const key of ['windowSeconds', 'ipLimit', 'userLimit']) if (!count(monitoring[key])) return false;
  for (const key of ['ip', 'account']) {
    if (!login[key]) return false;
    for (const field of ['limit', 'windowSeconds', 'activeKeys', 'atLimitKeys', 'failures']) if (!count(login[key][field])) return false;
  }
  if (!Array.isArray(data.users) || !Array.isArray(data.http)) return false;
  for (const user of data.users) {
    if (!user || typeof user.username !== 'string' || typeof user.userID !== 'string' || typeof user.department?.name !== 'string' || typeof user.inProgress !== 'boolean') return false;
    for (const field of ['used', 'remaining', 'dailyLimit', 'cooldownSeconds']) if (!count(user[field])) return false;
  }
  for (const row of data.http) {
    if (!row || typeof row.scope !== 'string' || !['ip', 'user'].includes(row.by)) return false;
    for (const field of ['limit', 'windowSeconds', 'maxKeys', 'activeKeys', 'totalHits', 'atLimitKeys', 'overLimitRequests']) if (!count(row[field])) return false;
  }
  return true;
}

/**
 * 取得唯讀管理監測快照，最多等待十秒；可由頁面中止過時請求，不自動重試。
 * 監測使用獨立端點，不送出重置確認文字或呼叫 Gemini。
 * @param {object} [auth=authService] 提供 getAccessToken 的登入服務。
 * @param {object} [options={}] 請求生命週期選項。
 * @param {AbortSignal} [options.signal] 分頁暫停、離開或開始重置時的中止訊號。
 * @returns {Promise<object>} 已驗證的監測快照。
 * @throws {AdminServiceError} 未登入、權限不足、限流、連線或格式錯誤；429 保留 retryAfter 秒數。
 */
export async function loadAdminMetrics(auth = authService, { signal } = {}) {
  const token = auth.getAccessToken();
  if (!token) throw new AdminServiceError('請先登入管理員帳號', 401);
  let response;
  let data;
  try {
    const timeout = AbortSignal.timeout(10000);
    response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/api/admin/metrics`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    data = await response.json();
  } catch { throw new AdminServiceError('無法更新監測資料，已保留上次數據'); }
  if (!response.ok) {
    const seconds = Number(response.headers.get('Retry-After') || data?.error?.retry_after);
    const error = new AdminServiceError(data?.error?.message || '監測資料更新失敗', response.status);
    if (Number.isSafeInteger(seconds) && seconds > 0) error.retryAfter = seconds;
    throw error;
  }
  if (!isValidMetrics(data)) throw new AdminServiceError('監測服務回應格式異常，已保留上次數據');
  return data;
}
