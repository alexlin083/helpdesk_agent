import { isCalendarDate, isClockTime, isTimezoneOffset, minutesOfDay, parseLocalDateTime, formatHoursMinutes, localToday, DEFAULT_TIMEZONE_OFFSET } from '../../utils/dates.js';
import { definitionError, isPlainObject, nonempty, yearOf } from './fieldTypes.js';

const MINUTES_PER_DAY = 1440;
// 工具的資料存取規則；registry 依工具能力要求的規則驗證目錄，執行時再依規則限制輸入與輸出。
export const ACCESS_RULES = Object.freeze(['all', 'self_only', 'same_department', 'names_only']);
export const CHECK_PHASES = Object.freeze(['draft', 'submit', 'approve']);

/**
 * 套用訊息範本中的 {名稱}。
 * @param {string} template 訊息範本。
 * @param {Record<string, string|number>} values 代入值。
 * @returns {string} 結果。
 */
function fill(template, values) {
  return template.replace(/\{([a-z_]+)\}/gu, /** 代入單一名稱。@param {string} match 原文。@param {string} name 名稱。@returns {string} 代入值或原文。 */ (match, name) => (name in values ? String(values[name]) : match));
}

/**
 * 驗證工作日曆物件並整理成計算用形狀。規則：timezone_offset 為 ±HH:mm；work_windows 為依時間排序、不重疊的 [起, 迄] HH:mm 時段；
 * workdays 為 0～6（0＝週日）不重複整數；holidays 以四位數年度為鍵，值為該年度內實際存在的 YYYY-MM-DD 陣列（只有列出的年度可以計算）；
 * unit_minutes、min_minutes、max_days 為正整數；same_year 省略為 true（起訖必須在同一年度）。
 * @param {unknown} raw 定義中的日曆物件。
 * @param {string} where 錯誤訊息位置。
 * @returns {Readonly<object>} timezoneOffset、windows（[起, 迄] 分鐘）、workdays（Set）、holidays（Map 年度 → Set 日期）、unitMinutes、minMinutes、maxDays、sameYear。
 * @throws {Error} REQUEST_TYPES_INVALID：任一欄位缺漏或格式不符。
 */
export function normalizeCalendar(raw, where) {
  if (!isPlainObject(raw)) throw definitionError(where, '必須是物件');
  if (!isTimezoneOffset(raw.timezone_offset)) throw definitionError(`${where}.timezone_offset`, '必須是 ±HH:mm 格式');
  if (!Array.isArray(raw.work_windows) || !raw.work_windows.length) throw definitionError(`${where}.work_windows`, '必須是非空陣列');
  const windows = [];
  for (const [index, window] of raw.work_windows.entries()) {
    const at = `${where}.work_windows[${index}]`;
    if (!Array.isArray(window) || window.length !== 2 || !window.every(isClockTime)) throw definitionError(at, '必須是 ["HH:mm", "HH:mm"]');
    const [start, end] = window.map(minutesOfDay);
    if (start >= end) throw definitionError(at, '的起始時間必須早於結束時間');
    if (windows.length && start < windows.at(-1)[1]) throw definitionError(at, '必須依時間排序且不可與前一個時段重疊');
    windows.push([start, end]);
  }
  if (!Array.isArray(raw.workdays) || !raw.workdays.length) throw definitionError(`${where}.workdays`, '必須是非空陣列');
  const workdays = new Set();
  for (const day of raw.workdays) {
    if (!Number.isInteger(day) || day < 0 || day > 6 || workdays.has(day)) throw definitionError(`${where}.workdays`, '只接受 0～6 且不可重複（0 為週日）');
    workdays.add(day);
  }
  if (!isPlainObject(raw.holidays)) throw definitionError(`${where}.holidays`, '必須是以年度為鍵的物件');
  const holidays = new Map();
  for (const [year, dates] of Object.entries(raw.holidays)) {
    if (!/^\d{4}$/u.test(year)) throw definitionError(`${where}.holidays`, '的鍵必須是四位數年度');
    if (!Array.isArray(dates)) throw definitionError(`${where}.holidays.${year}`, '必須是日期陣列');
    for (const date of dates) if (!isCalendarDate(date) || !date.startsWith(`${year}-`)) throw definitionError(`${where}.holidays.${year}`, '只能包含該年度實際存在的 YYYY-MM-DD 日期');
    holidays.set(Number(year), new Set(dates));
  }
  for (const name of ['unit_minutes', 'min_minutes', 'max_days']) {
    if (!Number.isSafeInteger(raw[name]) || raw[name] < 1) throw definitionError(`${where}.${name}`, '必須是正整數');
  }
  if (raw.same_year !== undefined && typeof raw.same_year !== 'boolean') throw definitionError(`${where}.same_year`, '必須是布林值');
  return Object.freeze({ timezoneOffset: raw.timezone_offset, windows, workdays, holidays,
    unitMinutes: raw.unit_minutes, minMinutes: raw.min_minutes, maxDays: raw.max_days, sameYear: raw.same_year ?? true });
}

// work_minutes 的預設訊息（定義的 computation.messages 可覆寫），可含 {year}、{max_days}。
const WORK_MINUTES_MESSAGES = Object.freeze({
  cross_year: '期間不可跨年度，請分開申請',
  year_closed: '{year} 年度尚未開放',
  max_days: '期間最多 {max_days} 天',
  no_work_time: '期間沒有落在上班時段',
});

/**
 * 計算期間落在工作日曆上班時段的分鐘數（純函式）。處理流程：
 * 1. 兩個時間都必須是有效的「YYYY-MM-DDTHH:mm」，且截止晚於起始（欄位規則已先檢查，這裡再保護一次）；
 * 2. same_year 時起訖必須在同一年度，且該年度必須已列在 holidays（尚未開放的年度拒絕）；
 * 3. 期間長度不可超過 max_days 天；
 * 4. 逐日累加與 work_windows 重疊的分鐘，只計 workdays 且不在 holidays 的日期，再依 unit_minutes 向上取整；
 * 5. 結果小於 min_minutes 時視為沒有落在上班時段。
 * @param {string} startText 起始時間。
 * @param {string} endText 截止時間。
 * @param {object} calendar normalizeCalendar 的結果。
 * @param {Record<string, string>} [messages={}] 覆寫的錯誤訊息。
 * @returns {{ok: true, minutes: number, year: number}|{ok: false, arg: 'start'|'end', message: string}} 計算結果或第一個錯誤（arg 指出掛在哪個參數欄位）。
 */
export function computeWorkMinutes(startText, endText, calendar, messages = {}) {
  /** 取得訊息。@param {string} name 訊息名稱。@param {object} [values={}] 代入值。@returns {string} 訊息。 */
  const text = (name, values = {}) => fill(messages[name] ?? WORK_MINUTES_MESSAGES[name], values);
  const start = parseLocalDateTime(startText);
  if (!start) return { ok: false, arg: 'start', message: '起始時間格式需為 YYYY-MM-DDTHH:mm' };
  const end = parseLocalDateTime(endText);
  if (!end) return { ok: false, arg: 'end', message: '截止時間格式需為 YYYY-MM-DDTHH:mm' };
  if (end.minutes <= start.minutes) return { ok: false, arg: 'end', message: '截止時間必須晚於起始時間' };
  if (calendar.sameYear && start.year !== end.year) return { ok: false, arg: 'end', message: text('cross_year') };
  for (const year of new Set([start.year, end.year])) {
    if (!calendar.holidays.has(year)) return { ok: false, arg: year === start.year ? 'start' : 'end', message: text('year_closed', { year }) };
  }
  if (end.minutes - start.minutes > calendar.maxDays * MINUTES_PER_DAY) return { ok: false, arg: 'end', message: text('max_days', { max_days: calendar.maxDays }) };
  let total = 0;
  const lastDay = Math.floor(end.minutes / MINUTES_PER_DAY);
  for (let day = Math.floor(start.minutes / MINUTES_PER_DAY); day <= lastDay; day += 1) {
    const date = new Date(day * MINUTES_PER_DAY * 60000);
    const iso = date.toISOString().slice(0, 10);
    if (!calendar.workdays.has(date.getUTCDay()) || calendar.holidays.get(date.getUTCFullYear())?.has(iso)) continue;
    const dayStart = day * MINUTES_PER_DAY;
    for (const [windowStart, windowEnd] of calendar.windows) {
      const overlap = Math.min(end.minutes, dayStart + windowEnd) - Math.max(start.minutes, dayStart + windowStart);
      if (overlap > 0) total += overlap;
    }
  }
  const minutes = Math.ceil(total / calendar.unitMinutes) * calendar.unitMinutes;
  if (minutes < calendar.minMinutes) return { ok: false, arg: 'end', message: text('no_work_time') };
  return { ok: true, minutes, year: start.year };
}

/**
 * 把工作日曆整理成交給 AI 閱讀的摘要（上班時段、工作日、單位與上限），不含內部形狀。
 * @param {object} calendar normalizeCalendar 的結果。
 * @returns {object} datetime_format、timezone_offset、work_windows、workdays、unit_minutes、max_days、same_year、open_years。
 */
export function describeCalendar(calendar) {
  /** 分鐘轉 HH:mm。@param {number} minutes 當天分鐘數。@returns {string} 時間文字。 */
  const clock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return {
    datetime_format: 'YYYY-MM-DDTHH:mm（24 小時制）',
    timezone_offset: calendar.timezoneOffset,
    work_windows: calendar.windows.map(/** 時段轉文字。@param {[number, number]} window 時段。@returns {string} 文字。 */ ([start, end]) => `${clock(start)}-${clock(end)}`),
    workdays: [...calendar.workdays].sort().map(/** 星期轉文字。@param {number} day 星期。@returns {string} 文字。 */ (day) => `週${weekdays[day]}`),
    unit_minutes: calendar.unitMinutes,
    max_days: calendar.maxDays,
    same_year: calendar.sameYear,
    open_years: [...calendar.holidays.keys()],
  };
}

/**
 * 計算能力（computations[].capability）：validate 在載入時檢查參數並準備計算資料，run 依欄位值計算。
 * work_minutes：args { start, end（datetime 欄位 key）, calendar（定義中工作日曆物件的鍵）}，結果為分鐘數（整數）。
 */
export const COMPUTATION_CAPABILITIES = Object.freeze({
  work_minutes: Object.freeze({
    /**
     * 驗證 work_minutes 的參數並整理日曆。
     * @param {object} args 計算參數。
     * @param {object} context 定義資料。
     * @param {object} context.definition 原始定義（取日曆物件）。
     * @param {Map<string, object>} context.fieldsByKey 欄位定義索引。
     * @param {string} context.where 錯誤訊息位置（「檔名 computations[索引]」）；日曆錯誤改用其中的檔名加上日曆鍵，維持「檔名 鍵路徑 原因」格式。
     * @returns {{calendar: object, referenced: string[]}} 整理後的日曆與引用的定義鍵。
     * @throws {Error} REQUEST_TYPES_INVALID：參數不符。
     */
    validate(args, { definition, fieldsByKey, where }) {
      for (const name of ['start', 'end']) {
        if (fieldsByKey.get(args[name])?.type !== 'datetime') throw definitionError(`${where}.args.${name}`, '必須是 datetime 欄位的 key');
      }
      if (typeof args.calendar !== 'string' || !isPlainObject(definition[args.calendar])) throw definitionError(`${where}.args.calendar`, '必須是這份定義中工作日曆物件的鍵');
      const file = where.slice(0, where.lastIndexOf(' '));
      return { calendar: normalizeCalendar(definition[args.calendar], `${file} ${args.calendar}`), referenced: [args.calendar] };
    },
    /**
     * 依起訖欄位計算分鐘數；兩個值都有才計算。
     * @param {object} computation 計算定義（含 args、resolved.calendar、messages）。
     * @param {Record<string, string>} values 欄位值。
     * @returns {{status: 'skipped'}|{status: 'ok', value: number}|{status: 'error', key: string, message: string}} 結果；錯誤掛在對應的欄位 key。
     */
    run(computation, values) {
      const start = values[computation.args.start];
      const end = values[computation.args.end];
      if (!start || !end) return { status: 'skipped' };
      const result = computeWorkMinutes(start, end, computation.resolved.calendar, computation.messages);
      if (!result.ok) return { status: 'error', key: computation.args[result.arg], message: result.message };
      return { status: 'ok', value: result.minutes };
    },
  }),
});

/**
 * 檢查能力（checks[].capability），都需要定義的 ledger：
 * - ledger_balance：本次數量不可超過該類別該期間的剩餘額度（approve 時這張單已列在待簽核內，剩餘不可小於 0）；
 * - ledger_overlap：同一申請人在期間內不可已有待簽核或已核准的同類申請，args { start, end } 為 date／datetime 欄位 key。
 */
export const CHECK_CAPABILITIES = Object.freeze({
  ledger_balance: Object.freeze({ needsArgs: [] }),
  ledger_overlap: Object.freeze({ needsArgs: ['start', 'end'] }),
});

/**
 * 工具能力（目錄 tools[].capability）：access 為允許的存取規則，options 為可作為欄位選項來源的欄位型別，
 * params 為能力讀取的參數合約（目錄宣告的 params 必須恰好是這些名稱與型別；colleagues 的期間參數是工具 API 的名稱，與任何需求類型的欄位無關）。
 */
export const TOOL_CAPABILITIES = Object.freeze({
  department_directory: Object.freeze({ access: ['all'], options: 'department', params: Object.freeze({}) }),
  department_members: Object.freeze({ access: ['names_only'], options: 'account', params: Object.freeze({ department_id: 'string' }) }),
  colleagues: Object.freeze({ access: ['same_department'], options: 'account', params: Object.freeze({ start_at: 'string', end_at: 'string' }) }),
  my_ledger_balance: Object.freeze({ access: ['self_only'], options: null, params: Object.freeze({ period: 'integer' }) }),
  request_type_definition: Object.freeze({ access: ['all'], options: null, params: Object.freeze({ type_id: 'string' }) }),
});

/**
 * 計算某類別某期間的額度結果，並依階段判斷是否足夠。
 * @param {Array<{category: string, remaining: number}>} balances 該期間全部類別的額度。
 * @param {string} category 類別。
 * @param {number} amount 本次數量。
 * @param {string} phase draft、submit 或 approve。
 * @returns {{before: number, after: number, enough: boolean}} before 為本次之前的剩餘、after 為扣除後的剩餘；approve 時這張單已在待簽核內，before 為剩餘加回本次。
 */
export function balanceOutcome(balances, category, amount, phase) {
  const remaining = balances.find(/** 找類別。@param {{category: string}} entry 額度。@returns {boolean} 相符時 true。 */ (entry) => entry.category === category)?.remaining ?? 0;
  if (phase === 'approve') return { before: remaining + amount, after: remaining, enough: remaining >= 0 };
  return { before: remaining, after: remaining - amount, enough: remaining - amount >= 0 };
}

/**
 * 依 ledger 的期間欄位取年度。
 * @param {object} ledger 定義的 ledger。
 * @param {Record<string, string>} values 欄位值。
 * @returns {number|null} 年度。
 */
export function ledgerPeriod(ledger, values) {
  return values[ledger.period_from] ? yearOf(values[ledger.period_from]) : null;
}

/**
 * 依 ledger 與計算結果格式化額度數字：amount 指向的計算有 display 篩選器（例如 hours_minutes）時使用，否則為數字字串。
 * @param {object} type 需求類型（含 computations、ledger）。
 * @param {number} value 數字。
 * @returns {string} 顯示文字。
 */
export function formatLedgerAmount(type, value) {
  return amountComputation(type)?.display === 'hours_minutes' ? formatHoursMinutes(value) : String(value);
}

/**
 * 找出 ledger.amount 指向的計算定義。
 * @param {object} type 需求類型（含 computations、ledger）。
 * @returns {object|undefined} 計算定義；沒有 ledger 時 undefined。
 */
export function amountComputation(type) {
  return type.computations.find(/** 找 amount 對應的計算。@param {{key: string}} item 計算。@returns {boolean} 相符時 true。 */ (item) => item.key === type.ledger?.amount);
}

/**
 * 驗證並整理工具呼叫的參數：只接受目錄宣告的參數、型別相符、必填存在；多餘參數忽略。
 * @param {object} tool 目錄的工具定義。
 * @param {unknown} raw 模型提供的參數。
 * @returns {{ok: true, params: object}|{ok: false, error: string}} 結果。
 */
export function parseToolParams(tool, raw) {
  const input = isPlainObject(raw) ? raw : {};
  const params = {};
  for (const [name, spec] of Object.entries(tool.params)) {
    const value = input[name];
    if (value === undefined || value === null || value === '') {
      if (spec.required) return { ok: false, error: `缺少參數 ${name}` };
      continue;
    }
    const valid = spec.type === 'string' ? typeof value === 'string' && Array.from(value).length <= 100
      : spec.type === 'integer' ? Number.isSafeInteger(value)
        : spec.type === 'number' ? Number.isFinite(value) : typeof value === 'boolean';
    if (!valid) return { ok: false, error: `參數 ${name} 必須是 ${spec.type}` };
    params[name] = typeof value === 'string' ? value.trim() : value;
  }
  return { ok: true, params };
}

/**
 * 依存取規則整理工具輸出：names_only 只保留 { id, name }（以及可否選擇的 available、reason），其他規則原樣回傳。
 * self_only 與 same_department 的限制在執行時已固定為本人與本人部門，不接受模型指定其他人。
 * @param {string} access 存取規則。
 * @param {unknown} result 工具輸出。
 * @returns {unknown} 整理後的輸出。
 */
export function applyAccess(access, result) {
  if (access !== 'names_only' || !Array.isArray(result)) return result;
  return result.map(/** 只保留名稱欄位。@param {object} entry 項目。@returns {object} id 與 name。 */ (entry) => ({ id: entry.id, name: entry.name,
    ...(typeof entry.available === 'boolean' ? { available: entry.available } : {}), ...(entry.reason ? { reason: entry.reason } : {}) }));
}

/**
 * 列出同部門、啟用中的一般帳號同事（不含本人），提供期間時標示期間內已有待簽核或已核准申請者為不可選。
 * 只回傳帳號名稱與可否選擇，不含其他個人資料。必須在交易內（helpers）同步呼叫。
 * @param {object} options 參數。
 * @param {object} options.user 憑證身分。
 * @param {object} options.accounts 帳號查詢服務（handlersOf）。
 * @param {object} options.helpers 交易內的 ledger 查詢（ledgerBusy）。
 * @param {Array<object>} options.busySpecs 需要檢查期間的 ledger（registry.busySpecs）。
 * @param {{start: string, end: string}|null} options.period 期間；null 時全部可選。
 * @param {string} [options.reason='此期間已有其他申請'] 不可選的原因。
 * @returns {Array<{id: string, name: string, available: boolean, reason?: string}>} 同事。
 */
export function listColleagues({ user, accounts, helpers, busySpecs, period, reason = '此期間已有其他申請' }) {
  const colleagues = accounts.handlersOf(user.department.id).filter(/** 排除本人。@param {{id: string}} entry 帳號。@returns {boolean} 不是本人時 true。 */ (entry) => entry.id !== user.username);
  const busy = period && colleagues.length ? helpers.ledgerBusy(busySpecs, colleagues.map(/** 取帳號。@param {{id: string}} entry 帳號。@returns {string} 帳號。 */ (entry) => entry.id), period.start, period.end) : new Set();
  return colleagues.map(/** 標示可否選擇。@param {{id: string, name: string}} entry 帳號。@returns {object} 選項。 */ (entry) => ({ id: entry.id, name: entry.name, available: !busy.has(entry.id), ...(busy.has(entry.id) ? { reason } : {}) }));
}

/**
 * 執行一次工具（伺服器端，依目錄的存取規則限制）：
 * - department_directory：全部部門 { id, name, duty, business }；
 * - department_members：指定部門的一般帳號，只回傳 { id, name }；
 * - colleagues：固定為本人部門、排除本人，可帶 start_at、end_at 標示期間內已有申請者；
 * - my_ledger_balance：固定查本人在目前需求類型 ledger 的額度（後端計算），只能查本人；
 * - request_type_definition：指定需求類型給 AI 的定義。
 * 參數不符、需求類型沒有 ledger 或查無資料時回傳 { error }，交給模型改問使用者，不讓請求失敗。資料庫錯誤原樣拋出。
 * @param {object} tool 目錄的工具定義（id、capability、params、access）。
 * @param {unknown} rawParams 模型提供的參數。
 * @param {object} context 執行環境。
 * @param {object} context.user 憑證身分。
 * @param {object} context.type 目前的需求類型。
 * @param {object} context.registry 需求類型目錄。
 * @param {object} context.accounts 帳號查詢服務。
 * @param {object} context.departments 部門查詢服務。
 * @param {object} context.store 需求單儲存（withLedger）。
 * @param {Function} context.clock 時間來源。
 * @returns {Promise<object>} { result } 或 { error }。
 * @throws {HttpError} 503 資料庫無法讀取。
 */
export async function executeTool(tool, rawParams, { user, type, registry, accounts, departments, store, clock }) {
  const parsed = parseToolParams(tool, rawParams);
  if (!parsed.ok) return { error: parsed.error };
  const { params } = parsed;
  let result;
  if (tool.capability === 'department_directory') {
    result = departments.forJudge();
  } else if (tool.capability === 'department_members') {
    if (!departments.findDepartment(params.department_id)) return { error: '找不到這個部門' };
    result = accounts.handlersOf(params.department_id);
  } else if (tool.capability === 'colleagues') {
    const start = params.start_at;
    const end = params.end_at;
    const period = start && end && parseLocalDateTime(start) && parseLocalDateTime(end) && end > start ? { start, end } : null;
    if ((start || end) && !period) return { error: 'start_at 與 end_at 必須同時提供，格式為 YYYY-MM-DDTHH:mm，且終點晚於起點' };
    result = await store.withLedger(/** 在讀取交易內列出同事。@param {object} helpers 交易內查詢。@returns {Array<object>} 同事。 */ (helpers) => listColleagues({ user, accounts, helpers, busySpecs: registry.busySpecs(), period }));
  } else if (tool.capability === 'my_ledger_balance') {
    if (!type.ledger) return { error: '這個需求類型沒有額度資料' };
    const period = params.period ?? localToday(clock(), type.timezoneOffset ?? DEFAULT_TIMEZONE_OFFSET).year;
    const { balances } = await store.ledgerBalances(type.ledgerSpec, user.username, period);
    result = { period, unit: amountComputation(type)?.display === 'hours_minutes' ? 'minutes' : 'count', balances:balances.map(/** 加上顯示文字。@param {object} entry 額度。@returns {object} 額度。 */ (entry) => ({ ...entry, remaining_text: formatLedgerAmount(type, entry.remaining) })) };
  } else if (tool.capability === 'request_type_definition') {
    const target = nonempty(params.type_id) ? registry.find(params.type_id) : null;
    if (!target) return { error: '找不到這個需求類型' };
    result = registry.aiView(target);
  } else {
    return { error: '不支援的工具' };
  }
  return { result: applyAccess(tool.access, result) };
}
