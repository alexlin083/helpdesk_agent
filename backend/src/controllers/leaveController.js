import { HttpError } from '../middleware/errorHandler.js';
import { accountService } from '../services/personnel/accountService.js';
import { getRequestTypes } from '../services/requestTypes/registry.js';
import { dataStore } from '../services/storage/dataStore.js';
import { DEFAULT_TIMEZONE_OFFSET, localToday } from '../utils/dates.js';
import { logger } from '../utils/logger.js';

const YEAR_MIN = 2000;
const YEAR_MAX = 2100;
const DELTA_MAX = 100000;
const REASON_MAX = 200;
const YEAR_MESSAGE = `year 必須是 ${YEAR_MIN}～${YEAR_MAX} 的四位數年度`;
// 人資假別時數 API 讀取的額度資料表；使用這張表的需求類型（ledger.entitlement_table）決定類別、送達部門（人資）與計算方式。
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
 * 把通用 ledger 額度轉成假別時數 API 的形狀。
 * @param {Array<{category: string, granted: number, adjusted: number, used: number, pending: number, remaining: number}>} balances 通用額度。
 * @returns {Array<{leave_type: string, granted_minutes: number, adjusted_minutes: number, used_minutes: number, pending_minutes: number, remaining_minutes: number}>} 假別時數。
 */
export function toLeaveBalances(balances) {
  return balances.map(/** 轉換一筆。@param {object} entry 額度。@returns {object} 假別時數。 */ (entry) => ({ leave_type: entry.category, granted_minutes: entry.granted, adjusted_minutes: entry.adjusted,
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
  if (!type.departmentId || user.department?.id !== type.departmentId) throw new HttpError(403, 'FORBIDDEN', '只有人資部門的成員可以查詢或調整他人的假別時數');
}

/**
 * 建立「我的假別時數」處理器（GET /api/me/leave-balance?year=）：只回傳憑證身分本人的假別時數，不接受指定其他帳號；數字由通用 ledger 計算。
 * @param {object} [options={}] 可注入的依賴。
 * @param {object} [options.store=dataStore] 需求單儲存。
 * @param {object} [options.types] 需求類型目錄；省略時使用預設目錄。
 * @param {Function} [options.clock=Date.now] 時間來源（預設年度）。
 * @returns {Function} Express 非同步處理器。
 */
export function createMyLeaveBalanceHandler({ store = dataStore, types, clock = Date.now } = {}) {
  /**
   * 回應 { year, balances: [{ leave_type, granted_minutes, adjusted_minutes, used_minutes, pending_minutes, remaining_minutes }] }。
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
 * 建立人資查詢員工假別時數的處理器（GET /api/leave/balances?username=&year=）：只有人資部門成員可以使用。
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

/**
 * 驗證人資假別調整的本文。規則：username 為一般帳號；leave_type 為請假類型 ledger 的類別之一；year 為 2000～2100 的整數；
 * delta_minutes 為非零整數且絕對值不超過 100000；reason 去除首尾空白後 1～200 字。
 * @param {unknown} body 請求本文。
 * @param {object} accounts 帳號查詢服務。
 * @param {string[]} categories 允許的假別（ledgerSpec.categories）。
 * @returns {{username: string, leaveType: string, year: number, deltaMinutes: number, reason: string}} 已驗證的調整內容。
 * @throws {HttpError} 400 INVALID_PAYLOAD（依 username → leave_type → year → delta_minutes → reason 的順序）。
 */
export function parseAdjustment(body, accounts, categories) {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const account = typeof raw.username === 'string' ? accounts.find(raw.username) : null;
  if (!account || account.role !== 'USER') throw new HttpError(400, 'INVALID_PAYLOAD', 'username 必須是系統內的一般帳號');
  if (!categories.includes(raw.leave_type)) throw new HttpError(400, 'INVALID_PAYLOAD', `leave_type 必須是 ${categories.join('、')}`);
  if (!Number.isInteger(raw.year) || raw.year < YEAR_MIN || raw.year > YEAR_MAX) throw new HttpError(400, 'INVALID_PAYLOAD', YEAR_MESSAGE);
  if (!Number.isSafeInteger(raw.delta_minutes) || raw.delta_minutes === 0 || Math.abs(raw.delta_minutes) > DELTA_MAX) {
    throw new HttpError(400, 'INVALID_PAYLOAD', `delta_minutes 必須是非零整數，絕對值最多 ${DELTA_MAX}`);
  }
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (!reason || Array.from(reason).length > REASON_MAX) throw new HttpError(400, 'INVALID_PAYLOAD', `reason 必須是 1 到 ${REASON_MAX} 字元的非空白字串`);
  return { username: account.username, leaveType: raw.leave_type, year: raw.year, deltaMinutes: raw.delta_minutes, reason };
}

/**
 * 建立人資新增假別調整的處理器（POST /api/leave/adjustments）：只有人資部門成員可以使用，且不能調整自己的假別時數
 * （與「簽核人不能是提單人本人」同樣的職責分離，人資本人的調整需由其他人資成員處理）；調整紀錄保存在 SQLite（leave_adjustments），
 * 示範名冊只在全新資料庫寫入一次、維運腳本 scripts/personnel.js grant 只設定額度本身，都不會覆蓋或刪除調整紀錄。
 * @param {object} [options={}] 可注入的依賴。
 * @param {object} [options.store=dataStore] 需求單儲存。
 * @param {object} [options.types] 需求類型目錄（判斷人資部門與 ledger）；省略時使用預設目錄。
 * @param {object} [options.accounts=accountService] 帳號查詢服務。
 * @param {Function} [options.clock=Date.now] 時間來源（調整時間）。
 * @returns {Function} Express 非同步處理器。
 */
export function createLeaveAdjustmentHandler({ store = dataStore, types, accounts = accountService, clock = Date.now } = {}) {
  /**
   * 回應 { adjustment: { id, username, leave_type, year, delta_minutes, reason, by_user_id, at }, balances }；日誌不記錄調整原因。
   * @param {import('express').Request} req 已驗證請求。
   * @param {import('express').Response} res 回應。
   * @returns {Promise<void>}
   * @throws {HttpError} 403 不是人資或調整自己的時數（檢查順序：人資身分 403 → 本文 400 → 本人 403）、400 本文錯誤、404 EMPLOYEE_NOT_FOUND、503 資料庫無法寫入。
   */
  return async function leaveAdjustmentHandler(req, res) {
    const type = leaveType(types ?? getRequestTypes());
    requireHr(req.user, type);
    const adjustment = parseAdjustment(req.body, accounts, type.ledgerSpec.categories);
    if (adjustment.username === req.user.username) throw new HttpError(403, 'FORBIDDEN', '不能調整自己的假別時數，請由其他人資成員處理');
    const result = await store.addLedgerAdjustment(type.ledgerSpec, { username: adjustment.username, category: adjustment.leaveType, period: adjustment.year,
      delta: adjustment.deltaMinutes, reason: adjustment.reason, byUserId: req.user.userID, byUsername: req.user.username, at: new Date(clock()).toISOString() });
    logger('info', 'leave.adjusted', { actorID: req.user.userID, leaveType: adjustment.leaveType, year: adjustment.year, deltaMinutes: adjustment.deltaMinutes });
    const saved = result.adjustment;
    res.json({ adjustment: { id: saved.id, username: saved.username, leave_type: saved.category, year: saved.period, delta_minutes: saved.delta, reason: saved.reason,
      by_user_id: saved.by_user_id, at: saved.at }, balances: toLeaveBalances(result.balances) });
  };
}

export const myLeaveBalance = createMyLeaveBalanceHandler();
export const listLeaveBalances = createLeaveBalancesHandler();
export const addLeaveAdjustment = createLeaveAdjustmentHandler();
