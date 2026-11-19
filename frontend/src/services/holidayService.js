import { API_BASE_URL } from '../config.js';
import { authService } from './authService.js';

// 檢查與套用會由後端向外部來源請求（後端等待上限 10 秒），這裡多留一點時間
const TIMEOUT_MS = 20000;

/** 假日資料管理 API 的可辨識錯誤，保留 HTTP 狀態與錯誤代碼供畫面處理登入失效與來源變動 */
export class HolidayServiceError extends Error {
  /**
   * 建立不含敏感資料的錯誤
   * @param {string} message 中文提示
   * @param {number} [status=0] HTTP 狀態，連線失敗為 0
   * @param {string|null} [code=null] 後端錯誤代碼
   */
  constructor(message, status = 0, code = null) { super(message); this.name = 'HolidayServiceError'; this.status = status; this.code = code; }
}

/**
 * 呼叫假日資料管理 API：帶管理員的登入憑證，回應一律解析 JSON；錯誤訊息只取後端的固定文字
 * @param {string} path /api/admin/holidays 底下的路徑（空字串為摘要）
 * @param {object} [options={}] 選項
 * @param {object} [options.body] JSON 本文；有本文時用 POST
 * @param {object} [options.auth=authService] 提供 getAccessToken 的登入服務
 * @returns {Promise<object>} 回應 JSON
 * @throws {HolidayServiceError} 沒登入（401）、連線失敗（0）或後端回非 2xx
 */
async function request(path, { body, auth = authService } = {}) {
  const token = auth.getAccessToken();
  if (!token) throw new HolidayServiceError('請先登入管理員帳號', 401);
  let response;
  let data;
  try {
    response = await globalThis.fetch(`${API_BASE_URL.replace(/\/$/, '')}/api/admin/holidays${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    data = await response.json();
  } catch { throw new HolidayServiceError('連線失敗，請稍後再試'); }
  if (!response.ok) throw new HolidayServiceError(data?.error?.message || '操作失敗，請稍後再試', response.status, data?.error?.code ?? null);
  return data;
}

/**
 * 檢查摘要的形狀：來源、最晚年度與年度清單
 * @param {unknown} data 回應
 * @returns {object} 原回應
 * @throws {HolidayServiceError} 格式不符
 */
function summaryOf(data) {
  if (!data?.source || typeof data.source.homepage !== 'string' || !Number.isInteger(data.latest_year) || !Array.isArray(data.years)) throw new HolidayServiceError('假日資料格式異常，請稍後再試');
  return data;
}

/**
 * 讀取假日資料摘要：來源、可同步的最晚年度，以及每個年度目前使用的假日與來源
 * @param {object} [auth=authService] 登入服務
 * @returns {Promise<object>} 摘要
 * @throws {HolidayServiceError} 見 request；格式不符時 status 0
 */
export async function loadHolidays(auth = authService) {
  return summaryOf(await request('', { auth }));
}

/**
 * 檢查某年度的來源資料並列出差異（後端不寫入）
 * @param {number} year 西元年度
 * @param {object} [auth=authService] 登入服務
 * @returns {Promise<object>} { year, origin, holidays, added, removed, unchanged, makeup_days, can_apply, blocked_reason, digest }
 * @throws {HolidayServiceError} 見 request；格式不符時 status 0
 */
export async function checkHolidays(year, auth = authService) {
  const data = await request('/check', { body: { year }, auth });
  if (!Array.isArray(data?.added) || !Array.isArray(data.removed) || typeof data.can_apply !== 'boolean' || typeof data.digest !== 'string') throw new HolidayServiceError('檢查結果格式異常，請稍後再試');
  return data;
}

/**
 * 套用某年度：後端重新抓取並比對摘要值，相同才寫入
 * @param {{year: number, digest: string}} choice 年度與檢查結果的摘要值
 * @param {object} [auth=authService] 登入服務
 * @returns {Promise<object>} 套用後的摘要（同 loadHolidays）
 * @throws {HolidayServiceError} 見 request；來源變了時 code 為 HOLIDAYS_CHANGED
 */
export async function applyHolidays({ year, digest }, auth = authService) {
  return summaryOf(await request('/apply', { body: { year, digest }, auth }));
}

/**
 * 還原某年度：刪掉同步資料、改回定義檔的假日
 * @param {number} year 西元年度
 * @param {object} [auth=authService] 登入服務
 * @returns {Promise<object>} 還原後的摘要（同 loadHolidays）
 * @throws {HolidayServiceError} 見 request
 */
export async function revertHolidays(year, auth = authService) {
  return summaryOf(await request('/revert', { body: { year }, auth }));
}
