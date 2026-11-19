import { createHash } from 'node:crypto';
import { HttpError } from '../../middleware/errorHandler.js';
import { WEEKDAYS, localToday } from '../../utils/dates.js';
import { setSyncedHolidays } from '../requestTypes/capabilities.js';
import { MAX_DESCRIPTION, MAX_HOLIDAYS_PER_YEAR, parseHolidayRecord, serializeHolidayRecord } from './holidayRecord.js';

// 假日資料來源：社群把政府資料開放平臺「中華民國政府行政機關辦公日曆表」（data.gov.tw 資料集 14718，行政院人事行政總處）轉成每年一份 JSON，
// 經 jsDelivr CDN 提供；網址寫死在這裡，不接受管理員或前端指定，避免被拿來向任意網址發出請求
export const HOLIDAY_SOURCE = Object.freeze({
  id: 'ruyut/TaiwanCalendar',
  name: 'ruyut/TaiwanCalendar（政府資料開放平臺「中華民國政府行政機關辦公日曆表」的 JSON 版）',
  urlTemplate: 'https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/{year}.json',
  license: 'CC BY 4.0（原始資料為政府資料開放授權條款第 1 版）',
  homepage: 'https://github.com/ruyut/TaiwanCalendar',
});
// 來源最早的年度（資料集從民國 106 年開始）；最晚只到明年（政府約每年 6 月公布下一年度）
export const FIRST_SOURCE_YEAR = 2017;
// 向來源請求的等待上限與回應大小上限（一年 365 筆約 30 KB）
export const FETCH_TIMEOUT_MS = 10000;
export const MAX_RESPONSE_BYTES = 256 * 1024;
const DAY_MS = 86400000;

/**
 * 組出某年度的來源網址。
 * @param {number} year 西元年度。
 * @returns {string} 網址。
 */
export function sourceUrl(year) {
  return HOLIDAY_SOURCE.urlTemplate.replace('{year}', String(year));
}

/**
 * 驗證並整理來源的一年資料。來源格式為陣列，每筆 { date: 'YYYYMMDD', week: '日'～'六', isHoliday: boolean, description: string }。
 * 規則：必須剛好是該年度從 1/1 到 12/31 的每一天、依序不缺不重複，星期與日期相符；不符合時視為來源資料異常，整份不採用。
 * 只保留週一到週五的放假日（週末本來就不是工作日）；週六、週日要上班的日子列為補班日，系統目前不支援，由呼叫端擋下。
 * @param {number} year 西元年度。
 * @param {unknown} data 解析後的 JSON。
 * @returns {{holidays: Array<{date: string, description: string}>, makeupDays: Array<{date: string, description: string}>}} 工作日的放假日與週末補班日（YYYY-MM-DD，遞增）。
 * @throws {HttpError} 502 HOLIDAYS_SOURCE_INVALID：格式不符。
 */
export function parseSourceYear(year, data) {
  /** 建立格式不符的錯誤。@param {string} detail 哪裡不符。@returns {HttpError} 502 錯誤。 */
  const invalid = (detail) => new HttpError(502, 'HOLIDAYS_SOURCE_INVALID', `假日資料來源的 ${year} 年資料格式不符（${detail}），沒有套用任何變更`);
  if (!Array.isArray(data)) throw invalid('不是陣列');
  const first = Date.UTC(year, 0, 1);
  const days = Math.round((Date.UTC(year + 1, 0, 1) - first) / DAY_MS);
  if (data.length !== days) throw invalid(`應有 ${days} 天，實際 ${data.length} 筆`);
  const holidays = [];
  const makeupDays = [];
  data.forEach(/** 檢查一天。@param {unknown} item 一筆資料。@param {number} index 第幾天（從 0 起算）。@returns {void} */ (item, index) => {
    const at = new Date(first + index * DAY_MS);
    const iso = at.toISOString().slice(0, 10);
    if (!item || typeof item !== 'object' || item.date !== iso.replaceAll('-', '')) throw invalid(`第 ${index + 1} 筆應為 ${iso}`);
    if (item.week !== WEEKDAYS[at.getUTCDay()]) throw invalid(`${iso} 的星期不符`);
    if (typeof item.isHoliday !== 'boolean') throw invalid(`${iso} 的 isHoliday 不是布林值`);
    if (item.description !== undefined && typeof item.description !== 'string') throw invalid(`${iso} 的說明不是文字`);
    const description = String(item.description ?? '').trim().slice(0, MAX_DESCRIPTION);
    const weekend = at.getUTCDay() === 0 || at.getUTCDay() === 6;
    if (item.isHoliday && !weekend) holidays.push({ date: iso, description });
    if (!item.isHoliday && weekend) makeupDays.push({ date: iso, description });
  });
  if (holidays.length > MAX_HOLIDAYS_PER_YEAR) throw invalid(`工作日放假超過 ${MAX_HOLIDAYS_PER_YEAR} 天`);
  return { holidays, makeupDays };
}

/**
 * 計算一份假日清單的摘要值：檢查時回給畫面，套用時重新抓取並比對，確保套用的就是管理員看過的那一份。
 * @param {Array<{date: string, description: string}>} holidays 假日。
 * @returns {string} SHA-256 十六進位字串。
 */
export function holidayDigest(holidays) {
  return createHash('sha256').update(JSON.stringify(holidays.map(/** 取日期與說明。@param {{date: string, description: string}} item 假日。@returns {[string, string]} 陣列。 */ (item) => [item.date, item.description]))).digest('hex');
}

/**
 * 建立假日同步服務：管理員檢查某年度的來源資料、看過差異後套用，套用的資料存在 meta 表並立即用於所有工作日曆。
 * 處理原則：
 * - 檢查（check）只抓取與比對，不寫入；套用（apply）重新抓取並比對摘要值，來源在兩次之間變了就拒絕，請管理員重新檢查；
 * - 有週末補班日的年度不能套用（工作日曆只有固定的工作日與假日，不支援補班）；
 * - 有同步資料的年度整年取代定義檔的假日；還原（revert）刪掉該年度的同步資料，改回定義檔；
 * - 只影響之後的計算：已送出的單在送出時已保存計算結果（例如時數），簽核與額度都沿用保存的值，不會因為同步而改變。
 * @param {object} options 依賴。
 * @param {{readHolidayRecord: Function, updateHolidayRecord: Function}} options.store 資料庫（dataStore）。
 * @param {() => {list: Function}} options.types 取得需求類型目錄的函式（讀定義檔的假日）。
 * @param {typeof fetch} [options.fetchImpl=fetch] 向來源請求的函式；測試注入替身，不連外。
 * @param {() => number} [options.clock=Date.now] 時間來源。
 * @param {number} [options.timeoutMs=FETCH_TIMEOUT_MS] 請求等待上限。
 * @param {Function} [options.log] 日誌函式 (level, event, fields)。
 * @returns {{load: Function, status: Function, check: Function, apply: Function, revert: Function}} 服務。
 */
export function createHolidaySync({ store, types, fetchImpl = fetch, clock = Date.now, timeoutMs = FETCH_TIMEOUT_MS, log = () => {} }) {
  /**
   * 讀出資料庫的同步紀錄；格式不符時記錄警告並當成沒有同步資料。
   * @returns {Map<number, object>} 年度 → 同步資料。
   * @throws {HttpError} 503 TICKET_STORE_UNAVAILABLE。
   */
  function readYears() {
    const parsed = parseHolidayRecord(store.readHolidayRecord());
    if (parsed.ok) return parsed.years;
    log('warn', 'holidays.record_invalid', { hint: 'meta 表 holiday_calendar 格式不符，暫時改用定義檔的假日；請到管理頁重新套用' });
    return new Map();
  }

  /**
   * 把同步資料交給工作日曆計算使用。
   * @param {Map<number, object>} years 年度 → 同步資料。
   * @returns {void}
   */
  function activate(years) {
    setSyncedHolidays(new Map([...years].map(/** 只取日期。@param {[number, object]} entry 年度與資料。@returns {[number, string[]]} 年度與日期。 */ ([year, entry]) => [year, entry.dates.map(/** 取日期。@param {{date: string}} item 假日。@returns {string} 日期。 */ (item) => item.date)])));
  }

  /**
   * 定義檔（各需求類型的工作日曆）列出的假日，依年度合併；不含同步資料。
   * @returns {Map<number, Set<string>>} 年度 → 日期。
   */
  function definitionYears() {
    const years = new Map();
    for (const type of types().list()) {
      for (const item of type.computations) {
        for (const [year, dates] of item.resolved.calendar?.holidays ?? []) {
          if (!years.has(year)) years.set(year, new Set());
          for (const date of dates) years.get(year).add(date);
        }
      }
    }
    return years;
  }

  /**
   * 檢查年度參數：整數，介於來源最早的年度與明年之間。
   * @param {unknown} value 年度。
   * @returns {number} 年度。
   * @throws {HttpError} 400 INVALID_PAYLOAD。
   */
  function yearOf(value) {
    const latest = localToday(clock()).year + 1;
    if (!Number.isInteger(value) || value < FIRST_SOURCE_YEAR || value > latest) throw new HttpError(400, 'INVALID_PAYLOAD', `year 必須是 ${FIRST_SOURCE_YEAR}～${latest} 的整數`);
    return value;
  }

  /**
   * 向來源抓取一年的資料並驗證。
   * @param {number} year 年度。
   * @returns {Promise<{holidays: Array<{date: string, description: string}>, makeupDays: Array<{date: string, description: string}>}>} 整理後的資料。
   * @throws {HttpError} 404 HOLIDAYS_NOT_PUBLISHED：來源還沒有這一年；502 HOLIDAYS_SOURCE_UNAVAILABLE：連線失敗、逾時或非 2xx；502 HOLIDAYS_SOURCE_INVALID：內容不符。
   */
  async function fetchYear(year) {
    let response;
    let text;
    try {
      response = await fetchImpl(sourceUrl(year), { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) text = await response.text();
    } catch (error) {
      // 記下底層原因（例如 ENOTFOUND、ECONNRESET、UND_ERR_CONNECT_TIMEOUT、憑證錯誤），排查時才知道是 DNS、防火牆、代理還是 TLS 的問題；不含任何金鑰
      const cause = error?.cause ?? error;
      log('warn', 'holidays.fetch_failed', { year, reason: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', url: sourceUrl(year),
        cause: typeof cause?.code === 'string' ? cause.code : String(cause?.name ?? 'Error'), detail: String(cause?.message ?? '').slice(0, 160) });
      throw new HttpError(502, 'HOLIDAYS_SOURCE_UNAVAILABLE', '無法連線到假日資料來源，請稍後再試；目前的假日資料不受影響');
    }
    if (response.status === 404) throw new HttpError(404, 'HOLIDAYS_NOT_PUBLISHED', `假日資料來源還沒有 ${year} 年的資料；政府約每年 6 月公布下一年度，來源更新後再試`);
    if (!response.ok) {
      log('warn', 'holidays.fetch_failed', { year, status: response.status });
      throw new HttpError(502, 'HOLIDAYS_SOURCE_UNAVAILABLE', '假日資料來源暫時無法使用，請稍後再試；目前的假日資料不受影響');
    }
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new HttpError(502, 'HOLIDAYS_SOURCE_INVALID', `假日資料來源的 ${year} 年資料過大，沒有套用任何變更`);
    let data;
    try { data = JSON.parse(text); } catch { throw new HttpError(502, 'HOLIDAYS_SOURCE_INVALID', `假日資料來源的 ${year} 年資料不是 JSON，沒有套用任何變更`); }
    return parseSourceYear(year, data);
  }

  /**
   * 某年度目前使用的假日與來源（同步資料優先，否則定義檔）。
   * @param {number} year 年度。
   * @param {Map<number, object>} synced 同步資料。
   * @param {Map<number, Set<string>>} definition 定義檔假日。
   * @returns {{origin: 'synced'|'definition'|'none', dates: Array<{date: string, description: string|null}>, applied_by: string|null, applied_at: string|null}} 目前狀態。
   */
  function currentOf(year, synced, definition) {
    const entry = synced.get(year);
    if (entry) return { origin: 'synced', dates: entry.dates.map(/** 複製一筆。@param {object} item 假日。@returns {object} 副本。 */ (item) => ({ ...item })), applied_by: entry.appliedBy, applied_at: entry.appliedAt };
    const dates = [...(definition.get(year) ?? [])].sort().map(/** 定義檔沒有說明。@param {string} date 日期。@returns {object} 假日。 */ (date) => ({ date, description: null }));
    return { origin: definition.has(year) ? 'definition' : 'none', dates, applied_by: null, applied_at: null };
  }

  /**
   * 管理頁的假日資料摘要：來源資訊與每個有資料的年度（定義檔或同步）目前使用的假日。
   * @returns {{source: object, years: object[]}} 摘要；years 依年度遞增，每筆 { year, origin, dates, applied_by, applied_at }。
   * @throws {HttpError} 503 TICKET_STORE_UNAVAILABLE。
   */
function status() {
    const synced = readYears();
    const definition = definitionYears();
    const years = [...new Set([...definition.keys(), ...synced.keys()])].sort(/** 年度遞增。@param {number} a 前者。@param {number} b 後者。@returns {number} 差值。 */ (a, b) => a - b);
    return {
      source: { id: HOLIDAY_SOURCE.id, name: HOLIDAY_SOURCE.name, url_template: HOLIDAY_SOURCE.urlTemplate, license: HOLIDAY_SOURCE.license, homepage: HOLIDAY_SOURCE.homepage },
      latest_year: localToday(clock()).year + 1,
      years: years.map(/** 年度摘要。@param {number} year 年度。@returns {object} 摘要。 */ (year) => ({ year, ...currentOf(year, synced, definition) })),
    };
  }

  return {
    /**
     * 啟動時讀出資料庫的同步資料並交給工作日曆；資料庫讀不到時記錄錯誤、改用定義檔的假日，不讓服務啟動失敗。
     * @returns {number} 載入的同步年度數。
     */
    load() {
      try {
        const years = readYears();
        activate(years);
        return years.size;
      } catch (error) {
        log('error', 'holidays.load_failed', { reason: typeof error?.code === 'string' ? error.code : 'LOAD_FAILED' });
        activate(new Map());
        return 0;
      }
    },
    status,
    /**
     * 檢查某年度：抓取來源、驗證並和目前使用的假日比對；不寫入任何資料。
     * @param {unknown} rawYear 年度（本文的 year）。
     * @returns {Promise<object>} { year, origin, holidays, added, removed, unchanged, makeup_days, can_apply, blocked_reason, digest }。
     * @throws {HttpError} 400、404、502、503（見 yearOf、fetchYear）。
     */
    async check(rawYear) {
      const year = yearOf(rawYear);
      const fetched = await fetchYear(year);
      const current = currentOf(year, readYears(), definitionYears());
      /** 取日期。@param {{date: string}} item 假日。@returns {string} 日期。 */
      const dateOf = (item) => item.date;
      const before = new Set(current.dates.map(dateOf));
      const after = new Set(fetched.holidays.map(dateOf));
      const blocked = fetched.makeupDays.length > 0;
      return {
        year, origin: current.origin, holidays: fetched.holidays,
        added: fetched.holidays.filter(/** 新增的。@param {{date: string}} item 假日。@returns {boolean} 目前沒有時 true。 */ (item) => !before.has(item.date)),
        removed: current.dates.filter(/** 移除的。@param {{date: string}} item 假日。@returns {boolean} 來源沒有時 true。 */ (item) => !after.has(item.date)),
        unchanged: fetched.holidays.filter(/** 沒變的。@param {{date: string}} item 假日。@returns {boolean} 目前也有時 true。 */ (item) => before.has(item.date)).length,
        makeup_days: fetched.makeupDays,
        can_apply: !blocked,
        blocked_reason: blocked ? '這一年有週末補班日，系統的工作日曆目前不支援補班，不能套用；請改由組員擴充工作日曆後再同步' : null,
        digest: holidayDigest(fetched.holidays),
      };
    },
    /**
     * 套用某年度：重新抓取來源，摘要值必須和檢查時相同，再寫入 meta 表並立即用於所有工作日曆。
     * @param {{year: unknown, digest: unknown}} body 本文。
     * @param {string} username 套用的管理員帳號。
     * @returns {Promise<object>} 套用後的摘要（同 status）。
     * @throws {HttpError} 400 INVALID_PAYLOAD；409 HOLIDAYS_CHANGED：來源在檢查後變了；409 HOLIDAYS_MAKEUP_UNSUPPORTED：有週末補班日；404、502、503。
     */
    async apply(body, username) {
      const year = yearOf(body?.year);
      if (typeof body?.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(body.digest)) throw new HttpError(400, 'INVALID_PAYLOAD', 'digest 必須是檢查結果的摘要值，請先按「檢查更新」');
      const fetched = await fetchYear(year);
      if (fetched.makeupDays.length) throw new HttpError(409, 'HOLIDAYS_MAKEUP_UNSUPPORTED', '這一年有週末補班日，系統的工作日曆目前不支援補班，不能套用');
      if (holidayDigest(fetched.holidays) !== body.digest) throw new HttpError(409, 'HOLIDAYS_CHANGED', '來源資料在檢查之後有變動，請重新按「檢查更新」確認差異後再套用');
      let years;
      store.updateHolidayRecord(/** 加入這一年。@param {string|null} raw 原始值。@returns {string} 新值。 */ (raw) => {
        const parsed = parseHolidayRecord(raw);
        if (!parsed.ok) log('warn', 'holidays.record_invalid', { hint: '套用時發現 meta 表 holiday_calendar 格式不符，已改寫成只含這次套用的年度' });
        years = parsed.ok ? parsed.years : new Map();
        years.set(year, { dates: fetched.holidays, source: HOLIDAY_SOURCE.id, appliedBy: username, appliedAt: new Date(clock()).toISOString() });
        return serializeHolidayRecord(years);
      });
      activate(years);
      log('info', 'holidays.applied', { year, holidays: fetched.holidays.length, username });
      return status();
    },
    /**
     * 還原某年度：刪掉這一年的同步資料，改回定義檔的假日（定義檔沒有這一年時，這一年變成未開放）。
     * @param {{year: unknown}} body 本文。
     * @param {string} username 操作的管理員帳號（只記在日誌）。
     * @returns {object} 還原後的摘要（同 status）。
     * @throws {HttpError} 400 INVALID_PAYLOAD；404 HOLIDAYS_NOT_SYNCED：這一年沒有同步資料；503。
     */
    revert(body, username) {
      const year = body?.year;
      if (!Number.isInteger(year)) throw new HttpError(400, 'INVALID_PAYLOAD', 'year 必須是整數');
      let years;
      let removed = false;
      store.updateHolidayRecord(/** 移除這一年。@param {string|null} raw 原始值。@returns {string|null} 新值；沒有這一年時不寫入。 */ (raw) => {
        const parsed = parseHolidayRecord(raw);
        years = parsed.ok ? parsed.years : new Map();
        removed = years.delete(year);
        return removed || !parsed.ok ? serializeHolidayRecord(years) : null;
      });
      activate(years);
      if (!removed) throw new HttpError(404, 'HOLIDAYS_NOT_SYNCED', `${year} 年沒有同步過的假日資料，不需要還原`);
      log('info', 'holidays.reverted', { year, username });
      return status();
    },
  };
}

