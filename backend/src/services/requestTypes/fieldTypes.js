import { isCalendarDate, parseLocalDate, parseLocalDateTime } from '../../utils/dates.js';

// 需求類型定義可使用的欄位型別；新增型別時同時補上定義驗證、值的整理與檢查。
export const FIELD_TYPES = Object.freeze(['self', 'enum', 'text', 'number', 'date', 'datetime', 'account', 'department']);
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
// 需求內容渲染保留的名稱（處理部門與指定處理人），欄位 key 不可使用。
export const RESERVED_KEYS = Object.freeze(['department', 'handler', 'type_id', 'department_id', 'handler_id']);
// 單一欄位值的基本上限（code points）；text 欄位的 max_length 較大時以 max_length 為準。超過時視為格式錯誤的請求。
export const FIELD_VALUE_MAX = 500;
export const TEXT_MAX = 2000;
const ACCOUNT_FILTERS = Object.freeze(['same_department', 'not_self', 'active']);
const RULE_KEYS = Object.freeze(['after', 'not_before_today']);
const DATE_LIKE = Object.freeze(['date', 'datetime']);

/**
 * 判斷值是否為一般物件（排除 null 與陣列）。
 * @param {unknown} value 待檢查的值。
 * @returns {boolean} 是一般物件時 true。
 */
export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 判斷值是否為非空白字串。
 * @param {unknown} value 待檢查的值。
 * @returns {boolean} 是非空白字串時 true。
 */
export function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 建立定義檔驗證錯誤；訊息格式為「位置 原因」，位置含檔名與鍵路徑，不輸出設定內容。
 * @param {string} where 位置，例如「leave.json fields[2].type」。
 * @param {string} reason 中文原因。
 * @returns {Error} code 為 REQUEST_TYPES_INVALID 的錯誤。
 */
export function definitionError(where, reason) {
  return Object.assign(new Error(`${where} ${reason}`), { code: 'REQUEST_TYPES_INVALID' });
}

/**
 * 驗證單一欄位定義並整理成固定形狀（只保留已知屬性）。跨欄位與跨檔案的參照（rules.after、filters.not_busy_between、options_tool）
 * 只檢查格式，是否存在由 registry 在整份定義載入後檢查。
 * 規則：key 為小寫英數與底線、不可使用保留名稱；label 非空白；type 為 FIELD_TYPES 之一；required 省略為 false（self 一律 false）；
 * enum 需要不重複的 options；text 需要 1～2000 的 max_length，可帶 multiline（保留換行）；number 可帶 min、max（數字，min ≤ max）與 integer；
 * date／datetime 可帶 rules（after：另一個欄位 key；date 另可帶 not_before_today）；account 可帶 options_tool、filters
 * （same_department、not_self、active 布林值，not_busy_between 為兩個欄位 key）、unavailable_message、unavailable_reason；
 * department 可帶 options_tool。
 * @param {unknown} raw 定義檔中的欄位。
 * @param {string} where 錯誤訊息使用的位置。
 * @returns {object} 整理後的欄位定義。
 * @throws {Error} REQUEST_TYPES_INVALID：格式不符。
 */
export function normalizeFieldDefinition(raw, where) {
  if (!isPlainObject(raw)) throw definitionError(where, '必須是物件');
  if (typeof raw.key !== 'string' || !FIELD_KEY_PATTERN.test(raw.key)) throw definitionError(`${where}.key`, '必須是小寫英數與底線');
  if (RESERVED_KEYS.includes(raw.key)) throw definitionError(`${where}.key`, `不可使用保留名稱 ${raw.key}`);
  if (!nonempty(raw.label)) throw definitionError(`${where}.label`, '必須是非空白字串');
  if (!FIELD_TYPES.includes(raw.type)) throw definitionError(`${where}.type`, `未知的欄位型別「${String(raw.type)}」，只接受 ${FIELD_TYPES.join('、')}`);
  if (raw.required !== undefined && typeof raw.required !== 'boolean') throw definitionError(`${where}.required`, '必須是布林值');
  const field = { key: raw.key, label: raw.label, type: raw.type, required: raw.type === 'self' ? false : raw.required ?? false };
  if (raw.type === 'enum') {
    if (!Array.isArray(raw.options) || !raw.options.length || !raw.options.every(nonempty) || new Set(raw.options).size !== raw.options.length) {
      throw definitionError(`${where}.options`, '必須是不重複的非空白字串陣列');
    }
    field.options = [...raw.options];
  }
  if (raw.type === 'text') {
    if (!Number.isSafeInteger(raw.max_length) || raw.max_length < 1 || raw.max_length > TEXT_MAX) throw definitionError(`${where}.max_length`, `必須是 1～${TEXT_MAX} 的整數`);
    field.max_length = raw.max_length;
    if (raw.multiline !== undefined && typeof raw.multiline !== 'boolean') throw definitionError(`${where}.multiline`, '必須是布林值');
    field.multiline = raw.multiline ?? false;
  }
  if (raw.type === 'number') {
    for (const name of ['min', 'max']) {
      if (raw[name] !== undefined && !Number.isFinite(raw[name])) throw definitionError(`${where}.${name}`, '必須是數字');
      if (raw[name] !== undefined) field[name] = raw[name];
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) throw definitionError(`${where}.min`, '不可大於 max');
    if (raw.integer !== undefined && typeof raw.integer !== 'boolean') throw definitionError(`${where}.integer`, '必須是布林值');
    field.integer = raw.integer ?? false;
  }
  if (raw.rules !== undefined) {
    if (!DATE_LIKE.includes(raw.type)) throw definitionError(`${where}.rules`, '只適用於 date 或 datetime 欄位');
    if (!isPlainObject(raw.rules)) throw definitionError(`${where}.rules`, '必須是物件');
    for (const name of Object.keys(raw.rules)) if (!RULE_KEYS.includes(name)) throw definitionError(`${where}.rules.${name}`, `未知的規則，只接受 ${RULE_KEYS.join('、')}`);
    if (raw.rules.after !== undefined && (typeof raw.rules.after !== 'string' || !FIELD_KEY_PATTERN.test(raw.rules.after))) throw definitionError(`${where}.rules.after`, '必須是欄位 key');
    if (raw.rules.not_before_today !== undefined && (raw.type !== 'date' || typeof raw.rules.not_before_today !== 'boolean')) {
      throw definitionError(`${where}.rules.not_before_today`, '只適用於 date 欄位且必須是布林值');
    }
    field.rules = { ...(raw.rules.after ? { after: raw.rules.after } : {}), ...(raw.rules.not_before_today ? { not_before_today: true } : {}) };
  }
  if (raw.options_tool !== undefined) {
    if (!['account', 'department'].includes(raw.type)) throw definitionError(`${where}.options_tool`, '只適用於 account 或 department 欄位');
    if (typeof raw.options_tool !== 'string' || !FIELD_KEY_PATTERN.test(raw.options_tool)) throw definitionError(`${where}.options_tool`, '必須是工具 id');
    field.options_tool = raw.options_tool;
  }
  if (raw.type === 'account') {
    const filters = raw.filters ?? {};
    if (!isPlainObject(filters)) throw definitionError(`${where}.filters`, '必須是物件');
    field.filters = {};
    for (const [name, value] of Object.entries(filters)) {
      if (name === 'not_busy_between') {
        if (!Array.isArray(value) || value.length !== 2 || !value.every(/** 是否為欄位 key 格式。@param {unknown} key 項目。@returns {boolean} 符合時 true。 */ (key) => typeof key === 'string' && FIELD_KEY_PATTERN.test(key)) || value[0] === value[1]) {
          throw definitionError(`${where}.filters.not_busy_between`, '必須是兩個不同的欄位 key');
        }
        field.filters.not_busy_between = [...value];
      } else if (ACCOUNT_FILTERS.includes(name)) {
        if (typeof value !== 'boolean') throw definitionError(`${where}.filters.${name}`, '必須是布林值');
        field.filters[name] = value;
      } else {
        throw definitionError(`${where}.filters.${name}`, `未知的篩選條件，只接受 ${[...ACCOUNT_FILTERS, 'not_busy_between'].join('、')}`);
      }
    }
    for (const name of ['unavailable_message', 'unavailable_reason']) {
      if (raw[name] !== undefined && !nonempty(raw[name])) throw definitionError(`${where}.${name}`, '必須是非空白字串');
      if (raw[name] !== undefined) field[name] = raw[name];
    }
  }
  return field;
}

/**
 * 取得欄位原始值的長度上限（code points）：text 取 max_length 與基本上限的較大者，其他型別為基本上限。
 * @param {object} field 欄位定義。
 * @returns {number} 上限。
 */
export function rawValueMax(field) {
  return field.type === 'text' ? Math.max(FIELD_VALUE_MAX, field.max_length) : FIELD_VALUE_MAX;
}

/**
 * 依欄位型別整理單一值：
 * - text：multiline 時統一換行為 \n 並去除首尾空白；否則把連續空白與換行合併為一個空白（需求內容一行一個欄位）；
 * - datetime：去除首尾空白，把「YYYY-MM-DD HH:mm」、「YYYY/MM/DD HH:mm」或帶 :00 秒數的寫法統一成「YYYY-MM-DDTHH:mm」；
 * - date：去除首尾空白，把「YYYY/M/D」統一成「YYYY-MM-DD」；
 * - number：去除首尾空白與千分位逗號；
 * - 其他型別只去除首尾空白。
 * @param {object} field 欄位定義。
 * @param {string} value 原始字串。
 * @returns {string} 整理後的字串。
 */
export function normalizeFieldValue(field, value) {
  if (field.type === 'text') return field.multiline ? value.replace(/\r\n?/gu, '\n').trim() : value.replace(/\s+/gu, ' ').trim();
  if (field.type === 'datetime') {
    return value.trim().replace(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::00)?$/u,
      /** 補零並組成標準格式。@param {string} _ 原字串。@param {string} y 年。@param {string} m 月。@param {string} d 日。@param {string} h 時。@param {string} mi 分。@returns {string} 標準格式。 */
      (_, y, m, d, h, mi) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}`);
  }
  if (field.type === 'date') {
    return value.trim().replace(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u,
      /** 補零並組成標準格式。@param {string} _ 原字串。@param {string} y 年。@param {string} m 月。@param {string} d 日。@returns {string} 標準格式。 */
      (_, y, m, d) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
  }
  if (field.type === 'number') return value.trim().replace(/,/gu, '');
  return value.trim();
}

/**
 * 判斷 date／datetime 欄位的值是否格式有效。
 * @param {object} field 欄位定義。
 * @param {string} value 值。
 * @returns {boolean} 有效時 true。
 */
export function isValidDateLike(field, value) {
  return field.type === 'date' ? isCalendarDate(value) : Boolean(parseLocalDateTime(value));
}

/**
 * 依型別與規則檢查單一「有值」的欄位（純函式；帳號是否在期間內已有申請由呼叫端先查好放在 context.unavailable）。
 * 訊息為可直接顯示的繁體中文，使用欄位的 label。
 * @param {object} field 欄位定義。
 * @param {string} value 已整理的非空字串。
 * @param {object} context 檢查需要的資料。
 * @param {object} context.user 憑證身分（username、department）。
 * @param {object} context.accounts 帳號查詢服務（find）。
 * @param {object} context.departments 部門查詢服務（findDepartment）。
 * @param {string} context.selfLabel 申請人欄位名稱（定義沒有 self 欄位時為「申請人」）。
 * @param {Record<string, string>} context.values 全部欄位值（檢查 after 規則用）。
 * @param {Map<string, object>} context.fieldsByKey 欄位定義索引。
 * @param {Set<string>} context.invalidKeys 已判定格式錯誤的欄位 key（after 規則不比較格式錯誤的欄位）。
 * @param {string} context.today 當地今天 YYYY-MM-DD。
 * @param {Set<string>} [context.unavailable] 期間內已有申請、不可選的帳號。
 * @returns {string|null} 錯誤訊息，通過時 null。
 */
export function fieldError(field, value, { user, accounts, departments, selfLabel, values, fieldsByKey, invalidKeys, today, unavailable = new Set() }) {
  const { label } = field;
  if (Array.from(value).length > rawValueMax(field)) return `${label}最多 ${rawValueMax(field)} 字`;
  if (field.type === 'enum' && !field.options.includes(value)) return `${label}請從「${field.options.join('、')}」擇一`;
  if (field.type === 'text' && Array.from(value).length > field.max_length) return `${label}最多 ${field.max_length} 字`;
  if (field.type === 'number') {
    if (!/^-?\d+(?:\.\d+)?$/u.test(value)) return `${label}必須是數字`;
    const number = Number(value);
    if (field.integer && !Number.isInteger(number)) return `${label}必須是整數`;
    if (field.min !== undefined && number < field.min) return `${label}不可小於 ${field.min}`;
    if (field.max !== undefined && number > field.max) return `${label}不可大於 ${field.max}`;
  }
  if (DATE_LIKE.includes(field.type)) {
    if (!isValidDateLike(field, value)) return `${label}格式需為 ${field.type === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm'}`;
    if (field.rules?.not_before_today && value < today) return `${label}不可早於今天`;
    const other = field.rules?.after ? fieldsByKey.get(field.rules.after) : null;
    const otherValue = other ? values[other.key] : '';
    if (other && otherValue && !invalidKeys.has(other.key) && isValidDateLike(other, otherValue) && value <= otherValue) return `${label}必須晚於${other.label}`;
  }
  if (field.type === 'account') {
    const account = accounts.find(value);
    if (!account || account.role !== 'USER') return `${label}必須是系統內的一般帳號`;
    if (field.filters.not_self && account.username === user.username) return `${label}不能是${selfLabel}本人`;
    if (field.filters.same_department && account.department.id !== user.department.id) return `${label}必須與${selfLabel}同部門`;
    if (unavailable.has(account.username)) return field.unavailable_message ?? `${label}在此期間已有其他申請，不能選擇`;
  }
  if (field.type === 'department' && !departments.findDepartment(value)) return `${label}必須是存在的部門`;
  return null;
}

/**
 * 取出日期類欄位值的年度（ledger 的期間）。
 * @param {string} value date 或 datetime 字串。
 * @returns {number|null} 年度；無法解析時 null。
 */
export function yearOf(value) {
  return parseLocalDate(value)?.year ?? null;
}

/**
 * 轉成前端與 GET /api/forms 使用的欄位形狀：不含 AI 專用文字與內部篩選設定。
 * 只有定義檔有設定的選填項目才會出現；number 欄位要求整數時另帶 integer: true，讓前端的數字輸入框以整數為單位。
 * @param {object} field 欄位定義。
 * @returns {{key: string, label: string, type: string, required: boolean, options?: string[], max_length?: number, min?: number, max?: number, integer?: true}} 欄位。
 */
export function clientField(field) {
  return {
    key: field.key, label: field.label, type: field.type, required: field.required,
    ...(field.options ? { options: [...field.options] } : {}),
    ...(field.max_length !== undefined ? { max_length: field.max_length } : {}),
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
    ...(field.integer ? { integer: true } : {}),
  };
}
