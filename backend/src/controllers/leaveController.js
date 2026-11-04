import { HttpError } from '../middleware/errorHandler.js';
import { getRequestTypes } from '../services/requestTypes/registry.js';
import { dataStore } from '../services/storage/dataStore.js';
import { DEFAULT_TIMEZONE_OFFSET, localToday } from '../utils/dates.js';

const YEAR_MIN = 2000;
const YEAR_MAX = 2100;
const YEAR_MESSAGE = `year 必須是 ${YEAR_MIN}～${YEAR_MAX} 的四位數年度`;
// 假別時數 API 讀取的額度資料表；使用這張表的需求類型（ledger.entitlement_table）決定類別、送達部門（人資）與計算方式。
export const LEAVE_TABLE = 'leave_entitlements';

/**
 * 解析查詢參數中的年度：省略或空字串時使用預設年度；有提供時必須是四位數字串且在 2000～2100 之間（重複鍵產生的陣列一律拒絕）。
 * @param {unknown} raw 查詢參數 year。
 * @param {number} fallback 預設年度（台北今天的年度）。
 * @returns {number} 年度。
 * @throws {HttpError} 400 INVALID_PAYLOAD。
 */
export function parseQueryYear(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^\d{4}$/.test(raw)) throw new HttpError(400, 'INVALID_PAYLOAD', YEAR_MESSAGE);
  const year = Number(raw);
  if (year < YEAR_MIN || year > YEAR_MAX) throw new HttpError(400, 'INVALID_PAYLOAD', YEAR_MESSAGE);
  return year;
}

/**
 * 找出使用假別額度表的需求類型（請假），沒有時表示這個功能未設定。
 * @param {object} types 需求類型目錄。
 * @returns {object} 需求類型（含 ledgerSpec、departmentId、timezoneOffset）。
 * @throws {HttpError} 503 LEAVE_LEDGER_UNAVAILABLE：沒有任何需求類型使用 leave_entitlements。
 */
function leaveType(types) {
  const type = types.ledgerOwner(LEAVE_TABLE);
  if (!type) throw new HttpError(503, 'LEAVE_LEDGER_UNAVAILABLE', '目前沒有設定使用假別額度的需求類型');
  return type;
}

/**
 * 把通用 ledger 額度轉成假別時數 API 的形狀：remaining_minutes 等於年度額度；used_minutes（已核准）與 pending_minutes（待簽核）只是參考，不從剩餘扣除。
 * 額度的扣除與調整由人資在公司既有的系統處理，不在本系統。
 * @param {Array<{category: string, granted: number, used: number, pending: number, remaining: number}>} balances 通用額度。
 * @returns {Array<{leave_type: string, granted_minutes: number, used_minutes: number, pending_minutes: number, remaining_minutes: number}>} 假別時數。
 */
export function toLeaveBalances(balances) {
  return balances.map(/** 轉換一筆。@param {object} entry 額度。@returns {object} 假別時數。 */ (entry) => ({ leave_type: entry.category, granted_minutes: entry.granted,
    used_minutes: entry.used, pending_minutes: entry.pending, remaining_minutes: entry.remaining }));
}

/**
 * 取得台北（或請假類型日曆時區）今天的年度。
 * @param {object} type 需求類型。
 * @param {Function} clock 時間來源。
 * @returns {number} 年度。
 */
function currentYear(type, clock) {
  return localToday(clock(), type.timezoneOffset ?? DEFAULT_TIMEZONE_OFFSET).year;
}

/**
 * 判斷目前身分是否為人資部門成員（請假需求類型的送達部門），不是時拒絕。
 * @param {object} user 憑證身分。
 * @param {object} type 請假需求類型。
 * @returns {void}
 * @throws {HttpError} 403 FORBIDDEN。
 */
function requireHr(user, type) {
  if (!type.departmentId || user.department?.id !== type.departmentId) throw new HttpError(403, 'FORBIDDEN', '只有人資部門的成員可以查詢他人的假別時數');
}

/**
 * 建立「我的假別時數」處理器（GET /api/me/leave-balance?year=）：只回傳憑證身分本人的假別時數，不接受指定其他帳號；數字由通用 ledger 以唯讀查詢計算。
 * @param {object} [options={}] 可注入的依賴。
 * @param {object} [options.store=dataStore] 需求單儲存。
 * @param {object} [options.types] 需求類型目錄；省略時使用預設目錄。
 * @param {Function} [options.clock=Date.now] 時間來源（預設年度）。
 * @returns {Function} Express 非同步處理器。
 */
export function createMyLeaveBalanceHandler({ store = dataStore, types, clock = Date.now } = {}) {
  /**
   * 回應 { year, balances: [{ leave_type, granted_minutes, used_minutes, pending_minutes, remaining_minutes }] }。
   * @param {import('express').Request} req 已驗證請求。
   * @param {import('express').Response} res 回應。
   * @returns {Promise<void>}
   * @throws {HttpError} 400 年度格式錯誤、503 資料庫無法讀取或未設定。
   */
  return async function myLeaveBalanceHandler(req, res) {
    const type = leaveType(types ?? getRequestTypes());
    const year = parseQueryYear(req.query?.year, currentYear(type, clock));
    const { balances } = await store.ledgerBalances(type.ledgerSpec, req.user.username, year);
    res.json({ year, balances: toLeaveBalances(balances) });
  };
}

/**
 * 建立人資查詢員工假別時數的處理器（GET /api/leave/balances?username=&year=）：只有人資部門成員可以使用，只讀取資料庫。
 * @param {object} [options={}] 可注入的依賴。
 * @param {object} [options.store=dataStore] 需求單儲存。
 * @param {object} [options.types] 需求類型目錄（判斷人資部門與 ledger）；省略時使用預設目錄。
 * @param {Function} [options.clock=Date.now] 時間來源（預設年度）。
 * @returns {Function} Express 非同步處理器。
 */
export function createLeaveBalancesHandler({ store = dataStore, types, clock = Date.now } = {}) {
  /**
   * 回應 { username, year, balances }；檢查順序為人資身分 403 → username、year 400 → 員工不存在 404。
   * @param {import('express').Request} req 已驗證請求。
   * @param {import('express').Response} res 回應。
   * @returns {Promise<void>}
   * @throws {HttpError} 403 不是人資、400 參數錯誤、404 EMPLOYEE_NOT_FOUND、503 資料庫無法讀取。
   */
  return async function leaveBalancesHandler(req, res) {
    const type = leaveType(types ?? getRequestTypes());
    requireHr(req.user, type);
    const username = req.query?.username;
    if (typeof username !== 'string' || !username.trim() || username.length > 100) throw new HttpError(400, 'INVALID_PAYLOAD', 'username 必須是帳號字串');
    const year = parseQueryYear(req.query?.year, currentYear(type, clock));
    const { known, balances } = await store.ledgerBalances(type.ledgerSpec, username.trim(), year);
    if (!known) throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', '找不到這位員工');
    res.json({ username: username.trim(), year, balances: toLeaveBalances(balances) });
  };
}

export const myLeaveBalance = createMyLeaveBalanceHandler();
export const listLeaveBalances = createLeaveBalancesHandler();
