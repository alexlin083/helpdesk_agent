import { requestJson, TicketServiceError, MESSAGES, countCodePoints, TICKET_LIMITS, DRAFT_REQUEST_TIMEOUT_MS } from './ticketService.js';

// 「自動生成」對話框的上限，與後端 POST /api/tickets/draft 相同：
// message 與使用者的 history 文字最多 300 字、助理的 history 文字最多 400 字（與 AI 回覆上限相同；Unicode code points，去除首尾空白後計算），
// history 最多最近 6 則，整份本文最多 16 KB。
export const DRAFT_LIMITS = { message: 300, historyTurns: 6, historyText: 300, assistantText: 400, bodyBytes: 16 * 1024, reply: 400, intent: 80 };
const SOURCES = ['user', 'ai', 'system'];
const HISTORY_ROLES = ['user', 'assistant'];
// 不屬於需求類型欄位、但後端可能放在 missing／invalid／sources 的鍵：處理部門與指定處理人。
export const DRAFT_META_KEYS = ['department_id', 'handler_id'];
// 後端沒有回傳需求類型（type 為 null，理論上不會發生，因為後端一律有預設類型）時，面板保留一個可自由填寫的「需求說明」欄位，避免使用者無處輸入。
export const DESCRIPTION_MAX = 1000;
export const DESCRIPTION_FIELD = Object.freeze({
  key: 'description', label: '需求說明', type: 'text', required: true, options: [], max_length: DESCRIPTION_MAX, min: null, max: null, integer: false,
  rules: Object.freeze({ after: null, not_before_today: false }),
});

/**
 * 檢查值是否為非空白字串。
 * @param {unknown} value 待檢查值。
 * @returns {boolean} 是否含可顯示文字。
 */
function isText(value) { return typeof value === 'string' && value.trim().length > 0; }

/**
 * 檢查值是否為一般物件（不是陣列或 null）。
 * @param {unknown} value 待檢查值。
 * @returns {boolean} 是否為物件。
 */
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

/**
 * 依 Unicode code points 截斷文字（先去除首尾空白），避免把表情符號等字元切成一半。
 * @param {string} text 原始文字。
 * @param {number} limit 最多字數。
 * @returns {string} 截斷後的文字。
 */
function truncate(text, limit) { return Array.from(text.trim()).slice(0, limit).join(''); }

/**
 * 只接受有限數字，其他值轉成 null；用於欄位的 min／max。
 * @param {unknown} value 待檢查值。
 * @returns {number|null} 有限數字或 null。
 */
function finiteOrNull(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }

/**
 * 建立「整理結果無法辨識」的錯誤。
 * @returns {TicketServiceError} INVALID_RESPONSE 錯誤。
 */
function unreadable() { return new TicketServiceError(MESSAGES.draftUnreadable, { status: 200, code: 'INVALID_RESPONSE' }); }

/**
 * 整理需求類型的一個欄位定義（來自後端的定義檔，前端不認得任何特定欄位代號）：key、label、type 必須是非空白文字，否則整份類型視為無法辨識。
 * options 只保留文字項目（enum 的選項）；max_length 只接受正整數；min、max 只接受有限數字；required、integer 轉成布林值。
 * 不認得的欄位型別照樣保留，畫面以一般文字輸入框顯示，讓後端新增的型別不會讓整個面板失效。
 * rules（只有「自動生成」回應的日期類欄位會帶）整理成 { after, not_before_today }：after 為必須晚於的欄位代號（沒有時 null），
 * not_before_today 只接受 true；兩者只供日期時間選擇器合併起訖欄位與停用日期，格式不符時視為沒有規則。
 * @param {unknown} field 後端回傳的欄位定義。
 * @returns {{key: string, label: string, type: string, required: boolean, options: string[], max_length: number|null, min: number|null, max: number|null, integer: boolean,
 *   rules: {after: string|null, not_before_today: boolean}}} 正規化的欄位。
 * @throws {TicketServiceError} 欄位缺少 key、label 或 type。
 */
export function normalizeTypeField(field) {
  if (!isPlainObject(field) || !isText(field.key) || !isText(field.label) || !isText(field.type)) throw unreadable();
  const rules = isPlainObject(field.rules) ? field.rules : {};
  return {
    key: field.key, label: field.label.trim(), type: field.type.trim(), required: field.required === true,
    options: Array.isArray(field.options) ? field.options.filter(isText) : [],
    max_length: Number.isInteger(field.max_length) && field.max_length > 0 ? field.max_length : null,
    min: finiteOrNull(field.min), max: finiteOrNull(field.max), integer: field.integer === true,
    rules: { after: isText(rules.after) ? rules.after : null, not_before_today: rules.not_before_today === true },
  };
}

/**
 * 整理需求類型的工作日曆摘要（「自動生成」回應的 type.calendars[]），供日期時間選擇器只列上班時段、停用非工作日：
 * start、end 為對應的起訖欄位代號；work_windows 為 [起, 訖]（HH:mm，起早於訖）陣列；workdays 為 0～6（0 為週日）；
 * holidays 為 YYYY-MM-DD；open_years 為四位數年度。整筆格式不符（缺欄位代號、沒有有效的上班時段或工作日）時回傳 null，由呼叫端略過。
 * @param {unknown} item 後端回傳的日曆摘要。
 * @returns {{start: string, end: string, workWindows: Array<[string, string]>, workdays: number[], holidays: string[], openYears: number[], timezoneOffset: string}|null} 正規化的日曆。
 */
export function normalizeCalendar(item) {
  if (!isPlainObject(item) || !isText(item.start) || !isText(item.end)) return null;
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  const windows = (Array.isArray(item.work_windows) ? item.work_windows : [])
    .filter(/** 是否為有效時段。@param {unknown} pair 時段。@returns {boolean} 有效時 true。 */ (pair) => Array.isArray(pair) && pair.length === 2 && clock.test(pair[0]) && clock.test(pair[1]) && pair[0] < pair[1])
    .map(/** 複製時段。@param {[string, string]} pair 時段。@returns {[string, string]} 時段。 */ (pair) => [pair[0], pair[1]]);
  const workdays = [...new Set((Array.isArray(item.workdays) ? item.workdays : []).filter(/** 是否為星期。@param {unknown} day 星期。@returns {boolean} 是時 true。 */ (day) => Number.isInteger(day) && day >= 0 && day <= 6))];
  if (!windows.length || !workdays.length) return null;
  return {
    start: item.start, end: item.end, workWindows: windows, workdays,
    holidays: (Array.isArray(item.holidays) ? item.holidays : []).filter(/** 是否為日期。@param {unknown} date 日期。@returns {boolean} 是時 true。 */ (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)),
    openYears: (Array.isArray(item.open_years) ? item.open_years : []).filter(/** 是否為年度。@param {unknown} year 年度。@returns {boolean} 是時 true。 */ (year) => Number.isInteger(year) && year >= 1000 && year <= 9999),
    timezoneOffset: typeof item.timezone_offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(item.timezone_offset) ? item.timezone_offset : '+08:00',
  };
}

/**
 * 取出欄位代號，供檢查重複與建立欄位集合。
 * @param {{key: string}} field 正規化的欄位。
 * @returns {string} 欄位代號。
 */
function fieldKey(field) { return field.key; }

/**
 * 整理 { id, name } 形狀的項目（部門、處理人）；格式不符時回傳 null。
 * @param {unknown} item 後端回傳的項目。
 * @returns {{id: string, name: string}|null} 正規化的項目。
 */
function toOption(item) { return isPlainObject(item) && isText(item.id) && isText(item.name) ? { id: item.id, name: item.name.trim() } : null; }

/**
 * 整理需求類型（POST /api/tickets/draft 回應的 type，或 GET /api/forms 的 types[]）：id、name 必須是文字，version 必須是正整數，
 * fields 必須是陣列且欄位代號不可重複。department（類型固定的處理部門）有值時整理成 { id, name }，沒有或格式不符時為 null（代表部門由對話決定）。
 * calendars（只有「自動生成」回應會帶）以 normalizeCalendar 整理，略過格式不符的項目；沒有時為空陣列。
 * @param {unknown} type 後端回傳的需求類型。
 * @returns {{id: string, version: number, name: string, department: {id: string, name: string}|null, fields: Array<object>, calendars: Array<object>}} 正規化的需求類型。
 * @throws {TicketServiceError} 類型格式不正確。
 */
export function normalizeRequestType(type) {
  if (!isPlainObject(type) || !isText(type.id) || !isText(type.name) || !Number.isInteger(type.version) || type.version < 1 || !Array.isArray(type.fields)) throw unreadable();
  const fields = type.fields.map(normalizeTypeField);
  if (new Set(fields.map(fieldKey)).size !== fields.length) throw unreadable();
  const calendars = (Array.isArray(type.calendars) ? type.calendars : []).map(normalizeCalendar).filter(Boolean);
  return { id: type.id, version: type.version, name: type.name.trim(), department: toOption(type.department), fields, calendars };
}

/**
 * 整理 { id, name } 陣列：略過格式不符與重複 id 的項目。
 * @param {unknown} list 後端回傳的陣列。
 * @returns {Array<{id: string, name: string}>} 正規化的選項。
 */
function toOptions(list) {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const option = toOption(item);
    if (!option || seen.has(option.id)) continue;
    seen.add(option.id);
    result.push(option);
  }
  return result;
}

/**
 * 整理單一欄位的候選清單（field_options[key]，來自定義檔 options_tool 的查詢結果，例如帳號或部門）：每筆需有 id、name；
 * available 明確為 false 時不可選並保留去除首尾空白的 reason（沒有時為空字串），其他情況視為可選。
 * @param {unknown} list 後端回傳的候選陣列。
 * @returns {Array<{id: string, name: string, available: boolean, reason: string}>} 正規化的候選。
 */
function toFieldOptions(list) {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const option = toOption(item);
    if (!option || seen.has(option.id)) continue;
    seen.add(option.id);
    const available = item.available !== false;
    result.push({ ...option, available, reason: !available && isText(item.reason) ? item.reason.trim() : '' });
  }
  return result;
}

/**
 * 整理後端的計算結果（computed，例如時數）：每筆需有 key 與 label；text 為畫面要顯示的文字（沒有時以 value 轉成文字），
 * value 只保留有限數字、文字或 null。數值一律由後端依定義檔計算，前端只負責顯示。
 * @param {unknown} list 後端回傳的 computed 陣列。
 * @returns {Array<{key: string, label: string, value: number|string|null, text: string}>} 正規化的計算結果。
 */
function toComputed(list) {
  const result = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!isPlainObject(item) || !isText(item.key) || !isText(item.label)) continue;
    const value = typeof item.value === 'string' || finiteOrNull(item.value) !== null ? item.value : null;
    const text = isText(item.text) ? item.text.trim() : value === null ? '' : String(value);
    result.push({ key: item.key, label: item.label.trim(), value, text });
  }
  return result;
}

/**
 * 整理 ai_error（AI 這次無法使用的原因）：後端回傳 { code, message, retry_after? }；code 必須是文字，message 去除首尾空白（沒有時為空字串），
 * retry_after 只接受正整數。為相容舊格式，純文字視為只有代碼。
 * @param {unknown} error 後端回傳的 ai_error。
 * @returns {{code: string, message: string, retryAfter: number|null}|null} 正規化的原因；沒有或格式不符時為 null。
 */
function normalizeAiError(error) {
  if (isText(error)) return { code: error.trim(), message: '', retryAfter: null };
  if (!isPlainObject(error) || !isText(error.code)) return null;
  return { code: error.code.trim(), message: isText(error.message) ? error.message.trim() : '',
    retryAfter: Number.isInteger(error.retry_after) && error.retry_after > 0 ? error.retry_after : null };
}

/**
 * 整理 POST /api/tickets/draft 的回應（設定檔驅動的需求類型）。前端不認得任何特定類型：欄位、候選、計算結果與摘要都依回應呈現。
 * - type：採用的需求類型 { id, version, name, fields }（也接受舊名稱 form）；沒有時面板只保留 DESCRIPTION_FIELD。
 * - departmentFixed：類型帶有固定部門（type.department）或後端標示處理部門來源為 system 時為 true，畫面改為唯讀。
 * - values、sources、missing、invalid、field_options 只保留面板上的欄位以及處理部門／指定處理人（department_id、handler_id）。
 * - computed、summaries 由後端依定義檔的 computations 與 checks 產生；tools_used 只保留文字。
 * - reply 最多 400 字、intent 最多 80 字；ai_available 缺漏視為 true。
 * complete 必須同時符合：後端回 true、有 rendered_content、沒有缺漏與格式錯誤、已知處理部門；否則視為未完成（不能套用）。
 * @param {unknown} data 解析後的 JSON。
 * @returns {object} { intent, type, fields, departmentFixed, department, departmentOptions, handler, handlerOptions, values, sources, missing, invalid,
 *   fieldOptions, computed, summaries, reply, prompt, aiAvailable, aiError, complete, rendered, preview, toolsUsed }。
 * @throws {TicketServiceError} 回應無法辨識。
 */
export function normalizeDraftResponse(data) {
  if (!isPlainObject(data)) throw unreadable();
  const rawType = data.type ?? data.form ?? null;
  const type = rawType === null ? null : normalizeRequestType(rawType);
  const fields = type ? type.fields : [DESCRIPTION_FIELD];
  const keys = new Set(fields.map(fieldKey));
  const statusKeys = new Set([...keys, ...DRAFT_META_KEYS]);
  const values = {};
  const sources = {};
  for (const key of keys) {
    const value = isPlainObject(data.values) ? data.values[key] : undefined;
    values[key] = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  }
  for (const key of statusKeys) {
    const source = isPlainObject(data.sources) ? data.sources[key] : undefined;
    if (SOURCES.includes(source)) sources[key] = source;
  }
  const fieldOptions = {};
  for (const key of keys) {
    const list = isPlainObject(data.field_options) ? data.field_options[key] : undefined;
    if (Array.isArray(list)) fieldOptions[key] = toFieldOptions(list);
  }
  /**
   * 缺漏清單只保留面板上的欄位、處理部門與指定處理人。
   * @param {unknown} key 欄位代號。
   * @returns {boolean} 是否保留。
   */
  function isStatusKey(key) { return statusKeys.has(key); }
  /**
   * 格式錯誤只保留面板上的欄位（含處理部門、指定處理人）且有說明文字的項目。
   * @param {unknown} item 格式錯誤項目。
   * @returns {boolean} 是否保留。
   */
  function isInvalidItem(item) { return isPlainObject(item) && statusKeys.has(item.key) && isText(item.message); }
  /**
   * 只保留欄位代號與去除首尾空白的說明。
   * @param {{key: string, message: string}} item 格式錯誤項目。
   * @returns {{key: string, message: string}} 整理後的項目。
   */
  function toInvalid(item) { return { key: item.key, message: item.message.trim() }; }
  /**
   * 摘要與工具清單只保留非空白文字，並去除首尾空白。
   * @param {unknown} list 後端回傳的陣列。
   * @returns {string[]} 文字陣列。
   */
  function texts(list) {
    const result = [];
    for (const item of Array.isArray(list) ? list : []) if (isText(item)) result.push(item.trim());
    return result;
  }
  const missing = [...new Set((Array.isArray(data.missing) ? data.missing : []).filter(isStatusKey))];
  const invalid = (Array.isArray(data.invalid) ? data.invalid : []).filter(isInvalidItem).map(toInvalid);
  const department = toOption(data.department) ?? type?.department ?? null;
  const rendered = isText(data.rendered_content) ? data.rendered_content : null;
  const complete = data.complete === true && rendered !== null && missing.length === 0 && invalid.length === 0 && department !== null;
  return {
    intent: isText(data.intent) ? truncate(data.intent, DRAFT_LIMITS.intent) : '',
    type, fields, departmentFixed: Boolean(type?.department) || sources.department_id === 'system',
    department, departmentOptions: toOptions(data.department_options),
    handler: toOption(data.handler), handlerOptions: toOptions(data.handler_options),
    values, sources, missing, invalid, fieldOptions, computed: toComputed(data.computed), summaries: texts(data.summaries),
    reply: isText(data.reply) ? truncate(data.reply, DRAFT_LIMITS.reply) : '',
    prompt: typeof data.prompt === 'string' ? data.prompt.trim() : '',
    aiAvailable: data.ai_available !== false, aiError: normalizeAiError(data.ai_error),
    complete, rendered: complete ? rendered : null, preview: typeof data.preview_content === 'string' ? data.preview_content : '',
    toolsUsed: texts(data.tools_used),
  };
}

/**
 * 整理要送出的對話紀錄：只保留 user／assistant 且有文字的項目，取最近 6 則，每則去除首尾空白；使用者訊息截到 300 字、助理訊息截到 400 字（與後端上限相同）。
 * @param {unknown} history 對話紀錄。
 * @returns {Array<{role: 'user'|'assistant', text: string}>} 可送出的紀錄。
 */
export function prepareHistory(history) {
  /**
   * 是否為可送出的紀錄項目。
   * @param {unknown} item 紀錄項目。
   * @returns {boolean} 是否保留。
   */
  function isTurn(item) { return isPlainObject(item) && HISTORY_ROLES.includes(item.role) && isText(item.text); }
  /**
   * 只保留角色與截斷後的文字。
   * @param {{role: string, text: string}} item 紀錄項目。
   * @returns {{role: string, text: string}} 整理後的項目。
   */
  function toTurn(item) { return { role: item.role, text: truncate(item.text, item.role === 'assistant' ? DRAFT_LIMITS.assistantText : DRAFT_LIMITS.historyText) }; }
  return (Array.isArray(history) ? history : []).filter(isTurn).slice(-DRAFT_LIMITS.historyTurns).map(toTurn);
}

/**
 * 整理要送出的面板狀態：type_id（也接受舊名稱 form_id）、department_id、handler_id 為非空白文字或 null；fields 只保留文字值；
 * locked 為不重複的文字陣列（欄位代號，使用者手動選過處理部門或指定處理人時另含 department_id、handler_id，後端不讓 AI 改寫這些項目）。
 * intent（目前的判斷結果）有文字時截到 80 字一併送出，讓只做驗證的呼叫保留 AI 先前的判斷；沒有時不帶。
 * @param {unknown} state 對話框的面板狀態。
 * @returns {{type_id: string|null, department_id: string|null, handler_id: string|null, intent?: string, fields: Record<string, string>, locked: string[]}} 可送出的狀態。
 */
export function prepareState(state) {
  const source = isPlainObject(state) ? state : {};
  const fields = {};
  for (const [key, value] of Object.entries(isPlainObject(source.fields) ? source.fields : {})) if (typeof value === 'string') fields[key] = value;
  /**
   * 文字欄位轉成 id 或 null。
   * @param {unknown} value 原始值。
   * @returns {string|null} id 或 null。
   */
  function idOrNull(value) { return isText(value) ? value : null; }
  const prepared = { type_id: idOrNull(source.type_id) ?? idOrNull(source.form_id), department_id: idOrNull(source.department_id), handler_id: idOrNull(source.handler_id) };
  if (isText(source.intent)) prepared.intent = truncate(source.intent, DRAFT_LIMITS.intent);
  return { ...prepared, fields, locked: [...new Set((Array.isArray(source.locked) ? source.locked : []).filter(isText))] };
}

/**
 * 計算 JSON 本文的 UTF-8 位元組數。
 * @param {object} body 本文。
 * @returns {number} 位元組數。
 */
function byteLength(body) { return new TextEncoder().encode(JSON.stringify(body)).length; }

/**
 * 呼叫 POST /api/tickets/draft（無狀態）與服務台助理整理需求單。
 * 本文為 { subject, message?, history?, state? }：
 * - 開啟對話框的第一次呼叫只帶 { subject }，由後端依需求類型目錄判斷類型、處理部門並回覆問候語；
 * - 聊天送出時帶 message、最近 6 則 history 與目前的面板 state，由 AI 更新未鎖定的欄位並回答問題；
 * - 手動修改欄位後的驗證呼叫只帶 state（不帶 message），後端只驗證、不呼叫 AI、不扣額度。
 * history 與 message 一律視為不可信的資料，由後端處理。本文超過 16 KB 時從最舊的 history 開始捨棄。
 * 單次最多等待 30 秒（DRAFT_REQUEST_TIMEOUT_MS），比後端整個回合的 20 秒期限長，讓後端的備援結果能送達。
 * @param {object} input 草稿內容。
 * @param {string} input.subject 需求單主題（1～100 字）。
 * @param {string} [input.message=''] 使用者在對話框輸入的訊息（最多 300 字）；空白代表不送。
 * @param {Array<{role: string, text: string}>} [input.history=[]] 先前的對話紀錄（不含本次 message）。
 * @param {object|null} [input.state=null] 面板狀態（type_id、department_id、handler_id、intent、fields、locked）；null 代表第一次呼叫。
 * @returns {Promise<object>} normalizeDraftResponse 的結果。
 * @throws {TicketServiceError} 主題或訊息字數不符（INVALID_PAYLOAD）、本文過大、未登入、HTTP 錯誤（含 429 限流與額度、503）、連線失敗、逾時或回應無法辨識。
 */
export async function requestDraft({ subject, message = '', history = [], state = null }) {
  const subjectCount = countCodePoints(subject);
  if (subjectCount === 0) throw new TicketServiceError('請先填寫主題', { status: 400, code: 'INVALID_PAYLOAD' });
  if (subjectCount > TICKET_LIMITS.subject) throw new TicketServiceError(`主題最多 ${TICKET_LIMITS.subject} 字，目前 ${subjectCount} 字`, { status: 400, code: 'INVALID_PAYLOAD' });
  const note = typeof message === 'string' ? message.trim() : '';
  const noteCount = countCodePoints(note);
  if (noteCount > DRAFT_LIMITS.message) throw new TicketServiceError(`訊息最多 ${DRAFT_LIMITS.message} 字，目前 ${noteCount} 字`, { status: 400, code: 'INVALID_PAYLOAD' });
  const body = { subject: subject.trim() };
  if (note) body.message = note;
  const turns = prepareHistory(history);
  if (turns.length) body.history = turns;
  if (state !== null && state !== undefined) body.state = prepareState(state);
  while (body.history && byteLength(body) > DRAFT_LIMITS.bodyBytes) {
    body.history.shift();
    if (!body.history.length) delete body.history;
  }
  if (byteLength(body) > DRAFT_LIMITS.bodyBytes) throw new TicketServiceError(MESSAGES.tooLarge, { status: 400, code: 'INVALID_PAYLOAD' });
  const data = await requestJson('/api/tickets/draft', { method: 'POST', body, timeoutMessage: MESSAGES.draftTimeout, unreadableMessage: MESSAGES.draftUnreadable, timeoutMs: DRAFT_REQUEST_TIMEOUT_MS });
  return normalizeDraftResponse(data);
}

/**
 * 整理 GET /api/forms 的回應：types 必須是陣列；格式不符的單一類型略過（不讓一個壞掉的定義影響其他類型的顯示），id 重複時保留第一筆。
 * 除了 normalizeRequestType 的欄位外，另保留選填的 summary（文字）、computed（[{ key, label, display }]，供狀態追蹤頁顯示舊單保存的計算值）
 * 與 workflow（{ transfer, not_requester }，只接受布林值，沒有時為 null）。
 * @param {unknown} data 解析後的 JSON。
 * @returns {Array<{id: string, version: number, name: string, summary: string, department: object|null, fields: Array<object>, computed: Array<object>, workflow: {transfer: boolean|null, not_requester: boolean|null}}>} 正規化的需求類型。
 * @throws {TicketServiceError} 回應不是 { types: [] }。
 */
export function normalizeRequestTypes(data) {
  if (!isPlainObject(data) || !Array.isArray(data.types)) throw new TicketServiceError(MESSAGES.listInvalid, { status: 200, code: 'INVALID_RESPONSE' });
  const result = [];
  const seen = new Set();
  for (const item of data.types) {
    let type;
    try { type = normalizeRequestType(item); } catch { continue; }
    if (seen.has(type.id)) continue;
    seen.add(type.id);
    const computed = [];
    for (const entry of Array.isArray(item.computed) ? item.computed : []) {
      if (isPlainObject(entry) && isText(entry.key) && isText(entry.label)) computed.push({ key: entry.key, label: entry.label.trim(), display: isText(entry.display) ? entry.display.trim() : '' });
    }
    const workflow = isPlainObject(item.workflow) ? item.workflow : {};
    result.push({ ...type, summary: isText(item.summary) ? item.summary.trim() : '', computed,
      workflow: { transfer: typeof workflow.transfer === 'boolean' ? workflow.transfer : null, not_requester: typeof workflow.not_requester === 'boolean' ? workflow.not_requester : null } });
  }
  return result;
}

/**
 * 載入需求類型目錄（GET /api/forms）：每種類型的名稱、版本、固定部門與欄位定義，不含只給 AI 看的文字；不呼叫 Gemini、不扣額度。
 * 狀態追蹤頁用它把需求單保存的欄位值顯示成「欄位名稱：值」。
 * @returns {Promise<Array<object>>} normalizeRequestTypes 的結果。
 * @throws {TicketServiceError} 未登入、HTTP 錯誤、連線失敗、逾時或格式不正確。
 */
export async function loadRequestTypes() {
  const data = await requestJson('/api/forms', { timeoutMessage: MESSAGES.listTimeout, unreadableMessage: MESSAGES.listInvalid });
  return normalizeRequestTypes(data);
}
