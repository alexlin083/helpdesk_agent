import { formatHoursMinutes, formatLocalDate, formatLocalTime, parseLocalDate } from '../../utils/dates.js';
import { definitionError } from './fieldTypes.js';

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * 渲染篩選器：每個篩選器收到上一步的值（字串、數字或 null）、參數與取值函式，回傳新值。
 * - date：日期或日期時間 →「YYYY-MM-DD（週X）」；
 * - time：日期時間 →「HH:mm」；
 * - date_range:<欄位>：與另一個日期欄位同一天時只顯示一天，不同天時為「A～ B」；
 * - hours_minutes：分鐘數 →「X 小時 Y 分鐘」；
 * - default:<文字>：值為空時改用文字。
 * 無法解析的值一律變成空字串（預覽時缺少的值留空）。
 */
export const FILTERS = Object.freeze({
  date: Object.freeze({ arg: 'none', apply: /** 格式化日期。@param {unknown} value 值。@returns {string} 日期。 */ (value) => formatLocalDate(value) }),
  time: Object.freeze({ arg: 'none', apply: /** 取出時分。@param {unknown} value 值。@returns {string} 時分。 */ (value) => formatLocalTime(value) }),
  date_range: Object.freeze({
    arg: 'field',
    /**
     * 組出日期區間。
     * @param {unknown} value 起點。
     * @param {string} arg 終點欄位 key。
     * @param {(name: string) => unknown} raw 取值函式。
     * @returns {string} 區間文字。
     */
    apply(value, arg, raw) {
      const start = parseLocalDate(value);
      if (!start) return '';
      const end = parseLocalDate(raw(arg));
      return end && end.date !== start.date ? `${formatLocalDate(value)}～ ${formatLocalDate(raw(arg))}` : formatLocalDate(value);
    },
  }),
  hours_minutes: Object.freeze({
    arg: 'none',
    /** 分鐘數轉時分。@param {unknown} value 值。@returns {string} 文字。 */
    apply: (value) => (Number.isInteger(value) ? formatHoursMinutes(value) : ''),
  }),
  default: Object.freeze({
    arg: 'text',
    /** 空值時改用預設文字。@param {unknown} value 值。@param {string} arg 預設文字。@returns {unknown} 值或預設文字。 */
    apply: (value, arg) => (value === null || value === undefined || value === '' ? arg : value),
  }),
});

/**
 * 解析一行範本：以 {名稱|篩選器:參數|...} 表示要代入的值，其他文字原樣保留。參數到下一個 | 或 } 為止。
 * @param {string} line 範本文字。
 * @returns {Array<{text: string}|{name: string, filters: Array<{name: string, arg: string|null}>}>} 片段。
 * @throws {Error} 大括號不成對（訊息不含位置，由呼叫端補上）。
 */
export function parseTemplate(line) {
  const segments = [];
  let rest = line;
  while (rest.length) {
    const open = rest.indexOf('{');
    const close = rest.indexOf('}');
    if (open < 0) {
      if (close >= 0) throw new Error('有多餘的「}」');
      segments.push({ text: rest });
      break;
    }
    if (close >= 0 && close < open) throw new Error('有多餘的「}」');
    if (open > 0) segments.push({ text: rest.slice(0, open) });
    const end = rest.indexOf('}', open);
    if (end < 0) throw new Error('「{」沒有對應的「}」');
    const [name, ...filters] = rest.slice(open + 1, end).split('|').map(/** 去除空白。@param {string} part 片段。@returns {string} 去空白後的片段。 */ (part) => part.trim());
    segments.push({ name, filters: filters.map(/** 拆出篩選器名稱與參數。@param {string} part 片段。@returns {{name: string, arg: string|null}} 篩選器。 */ (part) => {
      const colon = part.indexOf(':');
      return colon < 0 ? { name: part, arg: null } : { name: part.slice(0, colon).trim(), arg: part.slice(colon + 1) };
    }) });
    rest = rest.slice(end + 1);
  }
  return segments;
}

/**
 * 驗證並編譯一行範本：代入的名稱必須是 names 之一、篩選器必須已知，date_range 的參數必須是欄位 key，default 必須有參數。
 * @param {unknown} line 範本文字。
 * @param {object} options 檢查資料。
 * @param {Set<string>} options.names 可代入的名稱（欄位、計算結果與保留名稱）。
 * @param {Set<string>} options.fieldKeys 欄位 key（date_range 參數用）。
 * @param {string} options.where 錯誤訊息位置。
 * @returns {Array<object>} parseTemplate 的片段。
 * @throws {Error} REQUEST_TYPES_INVALID：格式、名稱或篩選器不符。
 */
export function compileTemplate(line, { names, fieldKeys, where }) {
  if (typeof line !== 'string' || !line.trim()) throw definitionError(where, '必須是非空白字串');
  let segments;
  try { segments = parseTemplate(line); } catch (error) { throw definitionError(where, error.message); }
  for (const segment of segments) {
    if (!('name' in segment)) continue;
    if (!NAME_PATTERN.test(segment.name) || !names.has(segment.name)) throw definitionError(where, `的佔位文字「{${segment.name}}」不是這份定義的欄位或計算結果`);
    for (const filter of segment.filters) {
      const known = FILTERS[filter.name];
      if (!known) throw definitionError(where, `使用了未知的篩選器「${filter.name}」，只接受 ${Object.keys(FILTERS).join('、')}`);
      if (known.arg === 'none' && filter.arg !== null) throw definitionError(where, `的篩選器 ${filter.name} 不接受參數`);
      if (known.arg === 'field' && !fieldKeys.has(filter.arg ?? '')) throw definitionError(where, `的篩選器 ${filter.name} 參數必須是欄位 key`);
      if (known.arg === 'text' && filter.arg === null) throw definitionError(where, `的篩選器 ${filter.name} 需要參數`);
    }
  }
  return segments;
}

/**
 * 依編譯後的範本產生一行文字。
 * @param {Array<object>} segments compileTemplate 的結果。
 * @param {object} context 取值函式。
 * @param {(name: string) => unknown} context.raw 取原始值（欄位字串、計算數值；空值為空字串或 null）。
 * @param {(name: string) => string} context.display 取沒有篩選器時顯示的文字（例如部門欄位顯示名稱）。
 * @returns {string} 渲染結果。
 */
export function renderSegments(segments, { raw, display }) {
  return segments.map(/** 渲染單一片段。@param {object} segment 片段。@returns {string} 文字。 */ (segment) => {
    if (!('name' in segment)) return segment.text;
    if (!segment.filters.length) return display(segment.name);
    let value = raw(segment.name);
    for (const filter of segment.filters) value = FILTERS[filter.name].apply(value, filter.arg, raw);
    return value === null || value === undefined ? '' : String(value);
  }).join('');
}
