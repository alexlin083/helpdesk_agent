import { HttpError } from '../../middleware/errorHandler.js';
import { balanceOutcome, COMPUTATION_CAPABILITIES, formatLedgerAmount, ledgerPeriod, listColleagues } from './capabilities.js';
import { fieldError, isPlainObject, isValidDateLike, normalizeFieldValue, rawValueMax, yearOf } from './fieldTypes.js';
import { FILTERS, renderSegments } from './renderer.js';

const DEFAULT_SELF_LABEL = '申請人';

/**
 * 篩選器取值函式的空實作：計算結果的 display 篩選器不需要讀取其他欄位。
 * @returns {string} 空字串。
 */
function noValue() {
  return '';
}

/**
 * 依 key 取欄位定義。
 * @param {object} type 需求類型。
 * @param {string} key 欄位 key。
 * @returns {object|undefined} 欄位，查無時 undefined。
 */
export function fieldOf(type, key) {
  return type.fieldsByKey.get(key);
}

/**
 * 取得欄位 key 對應的顯示名稱。
 * @param {object} type 需求類型。
 * @param {string[]} keys 欄位 key。
 * @returns {string[]} 顯示名稱（查無時為 key）。
 */
export function labelsOf(type, keys) {
  return keys.map(/** 取名稱。@param {string} key 欄位 key。@returns {string} 名稱。 */ (key) => fieldOf(type, key)?.label ?? key);
}

/**
 * 取得可由使用者或 AI 填寫的欄位（排除 self）。
 * @param {object} type 需求類型。
 * @returns {object[]} 欄位定義。
 */
export function editableFields(type) {
  return type.fields.filter(/** 排除申請人欄位。@param {object} field 欄位。@returns {boolean} 可編輯時 true。 */ (field) => field.type !== 'self');
}

/**
 * 驗證需求單送出時的表單欄位值（POST /api/tickets 的 form.fields，嚴格模式）：可省略（視為全部空白）；
 * 提供時必須是物件，鍵只能是定義的欄位 key，值必須是字串且不超過欄位的原始值上限。self 欄位一律由後端決定，請求提供的值直接忽略。
 * @param {unknown} raw 請求本文的 fields。
 * @param {object} type 需求類型。
 * @param {string} [name='form.fields'] 錯誤訊息使用的參數名稱。
 * @returns {Record<string, string>} 依欄位 key 整理後的值（只包含請求提供的非 self 欄位）。
 * @throws {HttpError} 400 INVALID_PAYLOAD：型別、欄位名稱或長度不符。
 */
export function parseFormInput(raw, type, name = 'form.fields') {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw new HttpError(400, 'INVALID_PAYLOAD', `${name} 必須是物件`);
  const input = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = fieldOf(type, key);
    if (!field) throw new HttpError(400, 'INVALID_PAYLOAD', `${name} 只能包含這個需求類型的欄位`);
    if (typeof value !== 'string') throw new HttpError(400, 'INVALID_PAYLOAD', `${name} 的值必須是字串`);
    if (Array.from(value).length > rawValueMax(field)) throw new HttpError(400, 'INVALID_PAYLOAD', `${name}.${key} 最多 ${rawValueMax(field)} 字元`);
    if (field.type === 'self') continue;
    input[key] = normalizeFieldValue(field, value);
  }
  return input;
}

/**
 * 取得期間：兩個欄位都有值、格式有效、沒有其他錯誤且終點晚於起點時回傳 { start, end }。
 * @param {object} type 需求類型。
 * @param {[string, string]} keys 起點與終點欄位 key。
 * @param {Record<string, string>} values 欄位值。
 * @param {Set<string>} invalidKeys 已有錯誤的欄位 key。
 * @returns {{start: string, end: string}|null} 期間。
 */
function periodOf(type, [startKey, endKey], values, invalidKeys) {
  const start = values[startKey];
  const end = values[endKey];
  if (!start || !end || invalidKeys.has(startKey) || invalidKeys.has(endKey)) return null;
  if (!isValidDateLike(fieldOf(type, startKey), start) || !isValidDateLike(fieldOf(type, endKey), end) || end <= start) return null;
  return { start, end };
}

/**
 * 依定義規則驗證並整理欄位值，執行計算與檢查（同步，必須在 ledger 交易內呼叫；不呼叫 AI）。處理流程：
 * 1. self 欄位一律為目前帳號；其他欄位取 input，未提供時為空字串；
 * 2. 必填欄位空白列入 missing；有值的欄位依型別與規則檢查（fieldTypes.fieldError），帳號欄位的 not_busy_between 依期間查詢 ledger；
 * 3. 帳號與部門欄位依 options_tool 產生選項（不可選的帳號附原因）；
 * 4. 參數欄位都沒有錯誤時執行 computations，失敗的計算把訊息掛在對應欄位；
 * 5. 執行 phase 適用的 checks：ledger_balance 依類別與期間比較剩餘額度並產生摘要文字，ledger_overlap 檢查本人期間重疊；
 * 6. 有 ledger 且數量、類別、期間都有效時產生要保存的 ledger 快照。
 * @param {object} options 參數。
 * @param {object} options.type 需求類型。
 * @param {Record<string, string>} options.input 已整理的欄位值（可已套用 AI 更新）。
 * @param {object} options.user 憑證身分（username、department）。
 * @param {{id: string, name: string}|null} options.department 處理部門（department_members 選項來源）。
 * @param {object} options.registry 需求類型目錄（busySpecs）。
 * @param {object} options.accounts 帳號查詢服務。
 * @param {object} options.departments 部門查詢服務。
 * @param {object} options.helpers 交易內的 ledger 查詢。
 * @param {string} options.today 當地今天 YYYY-MM-DD。
 * @param {'draft'|'submit'} options.phase 階段，決定執行哪些 checks。
 * @returns {{values: Record<string, string>, missing: string[], invalid: Array<{key: string, message: string}>, fieldOptions: Record<string, Array<object>>,
 *   computed: Array<{key: string, label: string, value: number, text: string}>, computedMap: Record<string, number>,
 *   failures: Array<{key: string, code: string, message: string}>, summaries: string[], ledger: object|null}} 結果。
 */
export function evaluateForm({ type, input, user, department, registry, accounts, departments, helpers, today, phase }) {
  const selfLabel = type.fields.find(/** 找 self 欄位。@param {object} field 欄位。@returns {boolean} self 時 true。 */ (field) => field.type === 'self')?.label ?? DEFAULT_SELF_LABEL;
  const values = {};
  for (const field of type.fields) values[field.key] = field.type === 'self' ? user.username : input[field.key] ?? '';
  const missing = [];
  const errors = new Map();
  const formatInvalid = new Set(type.fields.filter(/** 日期類欄位格式錯誤。@param {object} field 欄位。@returns {boolean} 格式錯誤時 true。 */ (field) => ['date', 'datetime'].includes(field.type) && values[field.key] && !isValidDateLike(field, values[field.key]))
    .map(/** 取 key。@param {object} field 欄位。@returns {string} key。 */ (field) => field.key));
  const base = { user, accounts, departments, selfLabel, values, fieldsByKey: type.fieldsByKey, invalidKeys: formatInvalid, today };
  for (const field of type.fields) {
    if (field.type === 'self' || field.type === 'account') continue;
    if (!values[field.key]) continue;
    const message = fieldError(field, values[field.key], base);
    if (message) errors.set(field.key, message);
  }
  const invalidKeys = new Set(errors.keys());
  const fieldOptions = {};
  for (const field of type.fields) {
    if (field.type !== 'account' && field.type !== 'department') continue;
    let unavailable = new Set();
    if (field.type === 'account') {
      const period = field.filters.not_busy_between ? periodOf(type, field.filters.not_busy_between, values, invalidKeys) : null;
      const reason = field.unavailable_reason ?? '此期間已有其他申請';
      const tool = field.options_tool ? registry.tool(field.options_tool) : null;
      let options = [];
      if (tool?.capability === 'colleagues') options = listColleagues({ user, accounts, helpers, busySpecs: registry.busySpecs(), period, reason });
      else if (tool?.capability === 'department_members') options = (department ? accounts.handlersOf(department.id) : []).map(/** 轉成選項。@param {{id: string, name: string}} entry 帳號。@returns {object} 選項。 */ (entry) => ({ id: entry.id, name: entry.name, available: true }));
      if (tool) fieldOptions[field.key] = options;
      const value = values[field.key];
      if (period && value) unavailable = helpers.ledgerBusy(registry.busySpecs(), [value], period.start, period.end);
    } else if (field.options_tool) {
      fieldOptions[field.key] = departments.list().map(/** 轉成選項。@param {{id: string, name: string}} item 部門。@returns {object} 選項。 */ (item) => ({ id: item.id, name: item.name, available: true }));
    }
    if (!values[field.key]) continue;
    const message = fieldError(field, values[field.key], { ...base, unavailable });
    if (message) errors.set(field.key, message);
  }
  for (const field of type.fields) if (field.required && !values[field.key]) missing.push(field.key);
  const invalid = type.fields.filter(/** 有錯誤的欄位。@param {object} field 欄位。@returns {boolean} 有錯誤時 true。 */ (field) => errors.has(field.key))
    .map(/** 轉成錯誤項目。@param {object} field 欄位。@returns {{key: string, message: string}} 錯誤。 */ (field) => ({ key: field.key, message: errors.get(field.key) }));
  // 計算
  const computed = [];
  const computedMap = {};
  for (const computation of type.computations) {
    const argKeys = Object.values(computation.args).filter(/** 只取欄位參數。@param {unknown} value 參數值。@returns {boolean} 是欄位 key 時 true。 */ (value) => typeof value === 'string' && type.fieldsByKey.has(value));
    if (argKeys.some(/** 參數欄位是否有錯。@param {string} key 欄位 key。@returns {boolean} 有錯時 true。 */ (key) => errors.has(key))) continue;
    const result = COMPUTATION_CAPABILITIES[computation.capability].run(computation, values);
    if (result.status === 'ok') {
      computedMap[computation.key] = result.value;
      computed.push({ key: computation.key, label: computation.label, value: result.value,
        text: computation.display ? String(FILTERS[computation.display].apply(result.value, null, noValue)) : String(result.value) });
    } else if (result.status === 'error') {
      invalid.push({ key: result.key, message: result.message });
      errors.set(result.key, result.message);
    }
  }
  // 檢查
  const failures = [];
  const summaries = [];
  let ledger = null;
  if (type.ledger) {
    const categoryKey = type.ledger.category_field;
    const category = values[categoryKey] && !errors.has(categoryKey) ? values[categoryKey] : null;
    const amount = computedMap[type.ledger.amount];
    const period = !errors.has(type.ledger.period_from) ? ledgerPeriod(type.ledger, values) : null;
    const overlapCheck = type.checks.find(/** 找期間重疊檢查。@param {object} check 檢查。@returns {boolean} 是時 true。 */ (check) => check.capability === 'ledger_overlap');
    if (category && Number.isFinite(amount) && period) {
      ledger = { category, amount, period, ...(overlapCheck ? { start: values[overlapCheck.args.start], end: values[overlapCheck.args.end] } : {}) };
    }
    for (const check of type.checks) {
      if (!check.on.includes(phase)) continue;
      if (check.capability === 'ledger_balance' && Number.isFinite(amount) && period) {
        if (!category) continue;
        const outcome = balanceOutcome(helpers.ledgerBalances(type.ledgerSpec, user.username, period), category, amount);
        if (check.summary) {
          const label = renderSegments(check.summary, { raw: /** 取欄位值。@param {string} name 欄位。@returns {string} 值。 */ (name) => values[name] ?? '', display: /** 取欄位值。@param {string} name 欄位。@returns {string} 值。 */ (name) => values[name] ?? '' });
          summaries.push(`${label}：${formatLedgerAmount(type, outcome.before)} → ${formatLedgerAmount(type, outcome.after)}`);
        }
        if (!outcome.enough) failures.push({ key: categoryKey, code: check.error.code, message: check.error.message });
      }
      if (check.capability === 'ledger_overlap') {
        const range = periodOf(type, [check.args.start, check.args.end], values, new Set(errors.keys()));
        if (range && helpers.ledgerOverlaps({ typeId: type.id, startField: check.args.start, endField: check.args.end }, user.username, range.start, range.end)) {
          failures.push({ key: check.args.start, code: check.error.code, message: check.error.message });
        }
      }
    }
  }
  return { values, missing, invalid, fieldOptions, computed, computedMap, failures, summaries, ledger };
}

/**
 * 依定義的 render.lines 產生帶回「需求內容」的固定文字（後端渲染，送出時再比對）；尚未完成時同一函式也用於即時預覽，缺少的值留空。
 * 保留名稱 department、handler 為處理部門與指定處理人的名稱；部門欄位沒有篩選器時顯示部門名稱。
 * @param {object} type 需求類型。
 * @param {object} context 渲染資料。
 * @param {Record<string, string>} context.values 欄位值。
 * @param {Record<string, number>} context.computedMap 計算結果。
 * @param {{name: string}|null} context.department 處理部門。
 * @param {{name: string}|null} context.handler 指定處理人。
 * @param {object} context.departments 部門查詢服務（部門欄位顯示名稱）。
 * @returns {string} 以 \n 分行、不含結尾換行的文字。
 */
export function renderContent(type, { values, computedMap, department, handler, departments }) {
  /**
   * 取原始值：欄位為字串、計算為數字，保留名稱為名稱。
   * @param {string} name 名稱。
   * @returns {unknown} 值；缺少時為空字串或 null。
   */
  function raw(name) {
    if (name === 'department') return department?.name ?? '';
    if (name === 'handler') return handler?.name ?? '';
    if (Object.hasOwn(computedMap, name)) return computedMap[name];
    if (type.fieldsByKey.has(name)) return values[name] ?? '';
    return null;
  }
  /**
   * 取沒有篩選器時的顯示文字。
   * @param {string} name 名稱。
   * @returns {string} 文字。
   */
  function display(name) {
    const value = raw(name);
    if (value === null || value === undefined) return '';
    if (type.fieldsByKey.get(name)?.type === 'department' && value) return departments.findDepartment(value)?.name ?? String(value);
    return String(value);
  }
  return type.lines.map(/** 渲染一行。@param {Array<object>} segments 片段。@returns {string} 文字。 */ (segments) => renderSegments(segments, { raw, display })).join('\n');
}

/**
 * 產生自動生成視窗的系統檢核清單（後端產生，不含 AI 文字）：送達部門、還缺哪些欄位、需修正的訊息與其他提醒；
 * 依共用標點規範，各段以「；」串接、句尾不加句號（回應出口另以 removeFullStops 把關，見 draftEngine.js）
 * @param {object} options 參數。
 * @param {object} options.type 需求類型。
 * @param {{name: string}|null} options.department 送達部門。
 * @param {string[]} options.missing 缺少的欄位 key（可含 department_id）。
 * @param {Array<{key: string, message: string}>} options.invalid 需修正的欄位（含檢查失敗）。
 * @param {string[]} [options.notes=[]] 其他提醒。
 * @param {boolean} options.complete 是否已可套用。
 * @returns {string} 繁體中文檢核清單。
 */
export function buildPrompt({ type, department, missing, invalid, notes = [], complete }) {
  const parts = [department ? `這份需求單將送到「${department.name}」` : '請在右側選擇處理部門'];
  const fieldMissing = missing.filter(/** 排除部門（已在第一句提示）。@param {string} key 欄位 key。@returns {boolean} 保留時 true。 */ (key) => key !== 'department_id');
  if (fieldMissing.length) parts.push(`還需要提供：${labelsOf(type, fieldMissing).join('、')}`);
  if (invalid.length) parts.push(`需要修正：${[...new Set(invalid.map(/** 取訊息。@param {{message: string}} entry 錯誤。@returns {string} 訊息。 */ (entry) => entry.message))].join('；')}`);
  for (const note of notes) parts.push(note);
  if (complete) parts.push('資料已完整，請確認右側內容後按「套用」帶回需求內容');
  return parts.join('；');
}

/**
 * 在簽核交易內執行定義中 on 包含 approve 的檢查（例如送出後人資調減額度造成核准會超用）。
 * 類別、數量、期間優先取自需求單保存的 form.ledger，舊版需求單改取定義指定的欄位與計算結果。
 * @param {object} type 需求單的需求類型。
 * @param {object} ticket 待簽核的需求單（requester.username、ticket_id、form）。
 * @param {object} helpers 交易內的 ledger 查詢。
 * @returns {{code: string, message: string}|null} 第一個失敗的檢查錯誤；都通過時 null。
 */
export function approvalFailure(type, ticket, helpers) {
  if (!type.ledger) return null;
  const form = ticket.form ?? {};
  const fields = form.fields ?? {};
  const snapshot = form.ledger ?? {
    category: fields[type.ledger.category_field],
    amount: form.computed?.[type.ledger.amount],
    period: yearOf(fields[type.ledger.period_from] ?? ''),
  };
  for (const check of type.checks) {
    if (!check.on.includes('approve')) continue;
    if (check.capability === 'ledger_balance' && snapshot.category && Number.isFinite(snapshot.amount) && snapshot.period) {
      const outcome = balanceOutcome(helpers.ledgerBalances(type.ledgerSpec, ticket.requester.username, snapshot.period), snapshot.category, snapshot.amount);
      if (!outcome.enough) return check.error;
    }
    if (check.capability === 'ledger_overlap') {
      const start = form.ledger?.start ?? fields[check.args.start];
      const end = form.ledger?.end ?? fields[check.args.end];
      if (start && end && helpers.ledgerOverlaps({ typeId: type.id, startField: check.args.start, endField: check.args.end }, ticket.requester.username, start, end, ticket.ticket_id)) return check.error;
    }
  }
  return null;
}
