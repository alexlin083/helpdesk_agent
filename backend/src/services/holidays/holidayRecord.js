import { isCalendarDate } from '../../utils/dates.js';

// 管理員同步的假日存在既有的 meta 表（名稱對 JSON），不新增資料表、不升資料庫結構版本（與外部服務連接的做法相同，見規格書第 3.19 節）；
// 全部年度放在同一筆，整筆在一筆交易內讀出、修改、寫回；名稱與 JSON 格式只在這個模組定義
export const HOLIDAY_RECORD = 'holiday_calendar';
export const RECORD_VERSION = 1;
// 每個年度最多保留的假日筆數與說明長度（實際一年約十幾天；上限只防止異常資料塞爆紀錄）
export const MAX_HOLIDAYS_PER_YEAR = 60;
export const MAX_DESCRIPTION = 40;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const USERNAME = /^[a-z][a-z.]{0,99}$/;

/**
 * 驗證一個年度的同步資料；不符合時回傳 null，呼叫端把整筆紀錄當成無效。
 * 規則：dates 為 0～60 筆依日期遞增、不重複、屬於該年度的 { date: YYYY-MM-DD, description: 字串（最多 40 字） }；
 * applied_by 為管理員帳號；applied_at 為 UTC ISO 時間；source 為非空字串。
 * @param {string} year 四位數年度（JSON 的鍵）。
 * @param {unknown} entry 年度資料。
 * @returns {{dates: Array<{date: string, description: string}>, source: string, appliedBy: string, appliedAt: string}|null} 整理後的資料或 null。
 */
function parseYear(year, entry) {
  if (!/^\d{4}$/u.test(year) || !entry || typeof entry !== 'object' || !Array.isArray(entry.dates) || entry.dates.length > MAX_HOLIDAYS_PER_YEAR) return null;
  if (typeof entry.source !== 'string' || !entry.source || entry.source.length > 100) return null;
  if (typeof entry.applied_by !== 'string' || !USERNAME.test(entry.applied_by) || typeof entry.applied_at !== 'string' || !ISO_TIME.test(entry.applied_at)) return null;
  const dates = [];
  for (const item of entry.dates) {
    if (!item || typeof item !== 'object' || !isCalendarDate(item.date) || !item.date.startsWith(`${year}-`)) return null;
    if (typeof item.description !== 'string' || item.description.length > MAX_DESCRIPTION) return null;
    if (dates.length && dates.at(-1).date >= item.date) return null;
    dates.push({ date: item.date, description: item.description });
  }
  return { dates, source: entry.source, appliedBy: entry.applied_by, appliedAt: entry.applied_at };
}

/**
 * 解析 meta 表 holiday_calendar 的值。meta 沒有欄位約束，所以讀出後逐欄驗證；JSON 壞掉、版本不對或任一年度不符合規則時整筆視為無效，
 * 由呼叫端記錄警告並當成「沒有同步資料」（改用定義檔的假日），服務不中斷；管理員重新套用一次就會覆寫。
 * @param {string|null} raw 原始值；沒有紀錄時為 null。
 * @returns {{ok: true, years: Map<number, {dates: Array<{date: string, description: string}>, source: string, appliedBy: string, appliedAt: string}>}|{ok: false}}
 *   解析結果；沒有紀錄時 ok 為 true、years 為空。
 */
export function parseHolidayRecord(raw) {
  if (raw === null || raw === undefined) return { ok: true, years: new Map() };
  let data;
  try { data = JSON.parse(raw); } catch { return { ok: false }; }
  if (!data || typeof data !== 'object' || data.version !== RECORD_VERSION || !data.years || typeof data.years !== 'object' || Array.isArray(data.years)) return { ok: false };
  const years = new Map();
  for (const [year, entry] of Object.entries(data.years)) {
    const parsed = parseYear(year, entry);
    if (!parsed) return { ok: false };
    years.set(Number(year), parsed);
  }
  return { ok: true, years };
}

/**
 * 把年度資料寫成 meta 表要保存的 JSON 字串（年度依數字遞增）。
 * @param {Map<number, {dates: Array<{date: string, description: string}>, source: string, appliedBy: string, appliedAt: string}>} years 年度資料。
 * @returns {string} JSON 字串。
 */
export function serializeHolidayRecord(years) {
  const sorted = [...years.entries()].sort(/** 年度遞增。@param {[number]} a 前者。@param {[number]} b 後者。@returns {number} 差值。 */ ([a], [b]) => a - b);
  return JSON.stringify({
    version: RECORD_VERSION,
    years: Object.fromEntries(sorted.map(/** 轉成保存格式。@param {[number, object]} entry 年度與資料。@returns {[string, object]} 鍵與值。 */ ([year, entry]) => [String(year), {
      source: entry.source, applied_by: entry.appliedBy, applied_at: entry.appliedAt,
      dates: entry.dates.map(/** 單一假日。@param {{date: string, description: string}} item 假日。@returns {object} 保存格式。 */ (item) => ({ date: item.date, description: item.description })),
    }])),
  });
}
