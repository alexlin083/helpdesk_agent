// 日期與時間的共用工具：需求類型引擎、人員資料驗證與查詢參數都使用「當地牆上時間」字串，不換算時區。
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const OFFSET_PATTERN = /^[+-](0\d|1[0-4]):[0-5]\d$/;
export const WEEKDAYS = Object.freeze(['日', '一', '二', '三', '四', '五', '六']);
export const DEFAULT_TIMEZONE_OFFSET = '+08:00';

/**
 * 判斷 YYYY-MM-DD 是否為實際存在的日期（拒絕 2026-02-30 這類會被 Date 自動進位的日期）。
 * @param {unknown} value 待檢查的值。
 * @returns {boolean} 是有效日期字串時 true。
 */
export function isCalendarDate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * 判斷字串是否為 HH:mm（00:00～23:59）。
 * @param {unknown} value 待檢查的值。
 * @returns {boolean} 符合時 true。
 */
export function isClockTime(value) {
  return typeof value === 'string' && TIME_PATTERN.test(value);
}

/**
 * 判斷字串是否為 ±HH:mm 的時區位移。
 * @param {unknown} value 待檢查的值。
 * @returns {boolean} 符合時 true。
 */
export function isTimezoneOffset(value) {
  return typeof value === 'string' && OFFSET_PATTERN.test(value);
}

/**
 * 把 HH:mm 轉成當天的分鐘數。
 * @param {string} value 已通過 isClockTime 的時間字串。
 * @returns {number} 0～1439 的分鐘數。
 */
export function minutesOfDay(value) {
  const [, hour, minute] = TIME_PATTERN.exec(value);
  return Number(hour) * 60 + Number(minute);
}

/**
 * 解析當地時間「YYYY-MM-DDTHH:mm」（不含秒與時區）。回傳以「當地牆上時間」計算的分鐘序號：
 * 兩個當地時間相減即為經過的分鐘數（設定的時區沒有日光節約時間時成立），不需要換算成 UTC。
 * @param {unknown} value 待解析的字串。
 * @returns {{year: number, date: string, time: string, weekday: number, minutes: number}|null}
 *   year 年度、date 日期、time 時分、weekday（0＝週日）、minutes 當地分鐘序號；格式不符或日期不存在時 null。
 */
export function parseLocalDateTime(value) {
  if (typeof value !== 'string') return null;
  const match = DATETIME_PATTERN.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const time = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(time);
  if (date.toISOString().slice(0, 16) !== value) return null;
  return { year, date: value.slice(0, 10), time: value.slice(11), weekday: date.getUTCDay(), minutes: time / 60000 };
}

/**
 * 解析日期「YYYY-MM-DD」或日期時間「YYYY-MM-DDTHH:mm」的日期部分。
 * @param {unknown} value 待解析的字串。
 * @returns {{year: number, date: string, weekday: number}|null} 年度、日期與星期（0＝週日）；無法解析時 null。
 */
export function parseLocalDate(value) {
  if (isCalendarDate(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return { year, date: value, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
  }
  const parsed = parseLocalDateTime(value);
  return parsed ? { year: parsed.year, date: parsed.date, weekday: parsed.weekday } : null;
}

/**
 * 把日期或日期時間格式化為「YYYY-MM-DD（週X）」。
 * @param {unknown} value 日期或日期時間字串。
 * @returns {string} 格式化後的日期；無法解析時空字串。
 */
export function formatLocalDate(value) {
  const parsed = parseLocalDate(value);
  return parsed ? `${parsed.date}（週${WEEKDAYS[parsed.weekday]}）` : '';
}

/**
 * 取出日期時間的「HH:mm」。
 * @param {unknown} value 日期時間字串。
 * @returns {string} 時分；無法解析時空字串。
 */
export function formatLocalTime(value) {
  return parseLocalDateTime(value)?.time ?? '';
}

/**
 * 以「X 小時 Y 分鐘」顯示分鐘數。
 * @param {number} minutes 整數分鐘（負數時加上負號）。
 * @returns {string} 例如 420 →「7 小時 0 分鐘」。
 */
export function formatHoursMinutes(minutes) {
  const sign = minutes < 0 ? '-' : '';
  const absolute = Math.abs(minutes);
  return `${sign}${Math.floor(absolute / 60)} 小時 ${absolute % 60} 分鐘`;
}

/**
 * 取得指定時區目前的日期、星期與年度，供 AI 提示、日期規則與預設查詢年度使用。
 * @param {number} [now=Date.now()] 目前 epoch 毫秒。
 * @param {string} [offset=DEFAULT_TIMEZONE_OFFSET] 時區位移（±HH:mm）。
 * @returns {{date: string, weekday: string, year: number}} 當地日期、「週X」與年度。
 */
export function localToday(now = Date.now(), offset = DEFAULT_TIMEZONE_OFFSET) {
  const sign = offset.startsWith('-') ? -1 : 1;
  const [hours, minutes] = offset.slice(1).split(':').map(Number);
  const local = new Date(now + sign * (hours * 60 + minutes) * 60000);
  return { date: local.toISOString().slice(0, 10), weekday: `週${WEEKDAYS[local.getUTCDay()]}`, year: local.getUTCFullYear() };
}
