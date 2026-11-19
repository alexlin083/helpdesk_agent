import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/testEnv.js';

setupTestEnv();
const { createHolidaySync, parseSourceYear, holidayDigest, sourceUrl, HOLIDAY_SOURCE } = await import('../src/services/holidays/holidaySync.js');
const { parseHolidayRecord, serializeHolidayRecord, HOLIDAY_RECORD } = await import('../src/services/holidays/holidayRecord.js');
const { computeWorkMinutes, pickerCalendar, setSyncedHolidays, workdaysBefore } = await import('../src/services/requestTypes/capabilities.js');
const { getRequestTypes } = await import('../src/services/requestTypes/registry.js');
const { createSqliteDataStore } = await import('../src/services/storage/dataStore.js');
const { WEEKDAYS } = await import('../src/utils/dates.js');
const { app } = await import('../src/server.js');
const { ACCOUNTS } = await import('../src/services/authService.js');

const DAY_MS = 86400000;
// 測試的「現在」：2026-11-19（台北），可同步的最晚年度是 2027
const NOW = Date.parse('2026-11-19T04:00:00Z');
const types = getRequestTypes();
const leaveCalendar = types.find('leave').computations[0].resolved.calendar;

/**
 * 依來源格式組出一整年的假資料：週末放假、其餘上班，再套上指定的放假日與上班日。
 * @param {number} year 年度。
 * @param {Record<string, string>} [holidays={}] 放假日 YYYY-MM-DD → 說明。
 * @param {string[]} [workdays=[]] 要上班的日期（用來做週末補班日）。
 * @returns {object[]} 來源格式的陣列。
 */
function sourceYear(year, holidays = {}, workdays = []) {
  const first = Date.UTC(year, 0, 1);
  const days = Math.round((Date.UTC(year + 1, 0, 1) - first) / DAY_MS);
  return Array.from({ length: days }, /** 組一天。@param {unknown} _ 未使用。@param {number} index 第幾天。@returns {object} 一筆。 */ (_, index) => {
    const at = new Date(first + index * DAY_MS);
    const iso = at.toISOString().slice(0, 10);
    const weekend = at.getUTCDay() === 0 || at.getUTCDay() === 6;
    const isHoliday = workdays.includes(iso) ? false : Object.hasOwn(holidays, iso) || weekend;
    return { date: iso.replaceAll('-', ''), week: WEEKDAYS[at.getUTCDay()], isHoliday, description: holidays[iso] ?? '' };
  });
}

// 2027 年的假來源：和請假定義相同的 7 天，再多一天 2027-06-09（週三，端午節）
const SOURCE_2027 = { '2027-01-01': '開國紀念日', '2027-02-04': '小年夜', '2027-02-05': '農曆除夕', '2027-02-08': '春節', '2027-02-09': '補假', '2027-02-10': '補假', '2027-03-01': '補假', '2027-06-09': '端午節' };

/**
 * 建立假的來源：依網址回應設定好的年度資料，記錄每次請求；沒有設定的年度回 404。
 * @param {Record<number, unknown>} years 年度 → 回應的 JSON（或 { status } 指定錯誤狀態）。
 * @returns {{fetchImpl: Function, calls: string[], years: Record<number, unknown>}} 假 fetch 與紀錄。
 */
function fakeSource(years) {
  const calls = [];
  /**
   * 假的 fetch。
   * @param {string} url 網址。
   * @returns {Promise<object>} 回應替身。
   */
  async function fetchImpl(url) {
    calls.push(url);
    const year = Number(url.match(/(\d{4})\.json$/)[1]);
    const value = years[year];
    if (value instanceof Error) throw value;
    if (value === undefined) return { ok: false, status: 404, text: async () => '' };
    if (value?.status) return { ok: false, status: value.status, text: async () => '' };
    return { ok: true, status: 200, text: async () => (typeof value === 'string' ? value : JSON.stringify(value)) };
  }
  return { fetchImpl, calls, years };
}

/**
 * 建立測試用的同步服務（記憶體資料庫、假來源、記錄日誌）。
 * @param {Record<number, unknown>} years 假來源的年度資料。
 * @returns {object} 服務、資料庫、來源與日誌。
 */
function setup(years) {
  const store = createSqliteDataStore({ file: ':memory:' });
  const source = fakeSource(years);
  const logs = [];
  const sync = createHolidaySync({ store, types: () => types, fetchImpl: source.fetchImpl, clock: () => NOW,
    log: /** 記錄日誌。@param {string} level 等級。@param {string} event 事件。@returns {void} */ (level, event) => { logs.push(`${level}:${event}`); } });
  return { sync, store, source, logs };
}

test.afterEach(() => { setSyncedHolidays(new Map()); });

test('來源格式：只取工作日的放假日，週末補班日另外列出；天數、日期順序、星期不符時整份拒絕', () => {
  const parsed = parseSourceYear(2027, sourceYear(2027, SOURCE_2027));
  assert.deepEqual(parsed.holidays.map(/** 取日期。@param {{date: string}} item 假日。@returns {string} 日期。 */ (item) => item.date), Object.keys(SOURCE_2027));
  assert.equal(parsed.holidays[0].description, '開國紀念日');
  assert.deepEqual(parsed.makeupDays, []);
  const makeup = parseSourceYear(2027, sourceYear(2027, {}, ['2027-02-20']));
  assert.deepEqual(makeup.makeupDays, [{ date: '2027-02-20', description: '' }], '週六上班是補班日');
  const days = sourceYear(2027);
  assert.throws(() => parseSourceYear(2027, days.slice(1)), { code: 'HOLIDAYS_SOURCE_INVALID', status: 502 });
  assert.throws(() => parseSourceYear(2027, { data: days }), { code: 'HOLIDAYS_SOURCE_INVALID' });
  const swapped = [...days];
  [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  assert.throws(() => parseSourceYear(2027, swapped), /第 4 筆應為 2027-01-04/);
  const wrongWeek = days.map(/** 改壞第一天的星期。@param {object} item 一筆。@param {number} index 第幾天。@returns {object} 一筆。 */ (item, index) => (index ? item : { ...item, week: '一' }));
  assert.throws(() => parseSourceYear(2027, wrongWeek), /星期不符/);
  assert.equal(parseSourceYear(2028, sourceYear(2028)).holidays.length, 0, '閏年 366 天');
  assert.equal(sourceUrl(2027), 'https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/2027.json');
});

test('meta 紀錄：可來回轉換；JSON 壞掉、版本不對、日期不屬於年度或沒排序時整筆無效', () => {
  const years = new Map([[2027, { dates: [{ date: '2027-01-01', description: '開國紀念日' }], source: HOLIDAY_SOURCE.id, appliedBy: 'alex.admin', appliedAt: '2026-11-19T04:00:00.000Z' }]]);
  const parsed = parseHolidayRecord(serializeHolidayRecord(years));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.years, years);
  assert.deepEqual(parseHolidayRecord(null), { ok: true, years: new Map() });
  assert.equal(parseHolidayRecord('{').ok, false);
  assert.equal(parseHolidayRecord(JSON.stringify({ version: 2, years: {} })).ok, false);
  const record = JSON.parse(serializeHolidayRecord(years));
  record.years['2027'].dates.push({ date: '2026-12-25', description: '' });
  assert.equal(parseHolidayRecord(JSON.stringify(record)).ok, false, '日期不屬於年度');
  record.years['2027'].dates = [{ date: '2027-03-01', description: '' }, { date: '2027-01-01', description: '' }];
  assert.equal(parseHolidayRecord(JSON.stringify(record)).ok, false, '沒有依日期排序');
});

test('檢查：列出和請假定義的差異，不寫入；套用後存進 meta 並立即用於時數、選擇器、AI 摘要與提前工作日', async () => {
  const { sync, store, source } = setup({ 2027: sourceYear(2027, SOURCE_2027) });
  const before = sync.status();
  assert.equal(before.latest_year, 2027);
  assert.deepEqual(before.years.map(/** 年度與來源。@param {object} item 年度。@returns {string} 文字。 */ (item) => `${item.year}:${item.origin}:${item.dates.length}`), ['2026:definition:1', '2027:definition:7']);
  const checked = await sync.check(2027);
  assert.deepEqual(source.calls, [sourceUrl(2027)]);
  assert.equal(checked.origin, 'definition');
  assert.deepEqual(checked.added, [{ date: '2027-06-09', description: '端午節' }]);
  assert.deepEqual(checked.removed, []);
  assert.equal(checked.unchanged, 7);
  assert.equal(checked.can_apply, true);
  assert.equal(checked.digest, holidayDigest(checked.holidays));
  assert.equal(store.readHolidayRecord(), null, '檢查不寫入');
  assert.equal(computeWorkMinutes('2027-06-09T09:00', '2027-06-09T18:00', leaveCalendar).minutes, 480, '套用前端午節還是工作日');

  const applied = await sync.apply({ year: 2027, digest: checked.digest }, 'alex.admin');
  const year2027 = applied.years.find(/** 找 2027。@param {{year: number}} item 年度。@returns {boolean} 是時 true。 */ (item) => item.year === 2027);
  assert.equal(year2027.origin, 'synced');
  assert.equal(year2027.applied_by, 'alex.admin');
  assert.equal(year2027.applied_at, new Date(NOW).toISOString());
  assert.equal(year2027.dates.length, 8);
  assert.equal(JSON.parse(store.readHolidayRecord()).years['2027'].dates.length, 8, '存在 meta 表');
  assert.equal(computeWorkMinutes('2027-06-09T09:00', '2027-06-09T18:00', leaveCalendar).ok, false, '套用後端午節不能單獨請假');
  assert.equal(computeWorkMinutes('2027-06-08T09:00', '2027-06-10T18:00', leaveCalendar).minutes, 960, '端午節不計時數');
  assert.ok(pickerCalendar(leaveCalendar).holidays.includes('2027-06-09'), '選擇器停用端午節');
  assert.ok(types.find('leave').references.calendar.holidays.includes('2027-06-09'), 'AI 摘要列出端午節');
  assert.ok(pickerCalendar(leaveCalendar).holidays.includes('2026-12-25'), '沒同步的年度照用定義檔');
  assert.equal(workdaysBefore(leaveCalendar, '2027-06-07', '2027-06-11', 10), 3, '提前工作日不算端午節');
});

test('套用：摘要值不同（來源變了）或有週末補班日時拒絕；重新啟動時從 meta 載入；還原後改回定義檔', async () => {
  const { sync, store, source, logs } = setup({ 2027: sourceYear(2027, SOURCE_2027) });
  const checked = await sync.check(2027);
  source.years[2027] = sourceYear(2027, { ...SOURCE_2027, '2027-09-28': '教師節' });
  await assert.rejects(sync.apply({ year: 2027, digest: checked.digest }, 'alex.admin'), { status: 409, code: 'HOLIDAYS_CHANGED' });
  assert.equal(store.readHolidayRecord(), null);
  await assert.rejects(sync.apply({ year: 2027, digest: 'x' }, 'alex.admin'), { status: 400, code: 'INVALID_PAYLOAD' });

  source.years[2027] = sourceYear(2027, SOURCE_2027, ['2027-02-20']);
  const blocked = await sync.check(2027);
  assert.equal(blocked.can_apply, false);
  assert.match(blocked.blocked_reason, /補班/);
  await assert.rejects(sync.apply({ year: 2027, digest: blocked.digest }, 'alex.admin'), { status: 409, code: 'HOLIDAYS_MAKEUP_UNSUPPORTED' });

  source.years[2027] = sourceYear(2027, SOURCE_2027);
  await sync.apply({ year: 2027, digest: (await sync.check(2027)).digest }, 'alex.admin');
  setSyncedHolidays(new Map());
  assert.equal(computeWorkMinutes('2027-06-09T09:00', '2027-06-09T18:00', leaveCalendar).minutes, 480, '模擬重新啟動：記憶體清空');
  const restarted = createHolidaySync({ store, types: () => types, fetchImpl: source.fetchImpl, clock: () => NOW });
  assert.equal(restarted.load(), 1);
  assert.equal(computeWorkMinutes('2027-06-09T09:00', '2027-06-09T18:00', leaveCalendar).ok, false, '啟動時從 meta 載入');

  const reverted = sync.revert({ year: 2027 }, 'alex.admin');
  assert.equal(reverted.years.find(/** 找 2027。@param {{year: number}} item 年度。@returns {boolean} 是時 true。 */ (item) => item.year === 2027).origin, 'definition');
  assert.equal(computeWorkMinutes('2027-06-09T09:00', '2027-06-09T18:00', leaveCalendar).minutes, 480, '還原後端午節回到工作日');
  assert.equal(computeWorkMinutes('2027-02-04T09:00', '2027-02-04T18:00', leaveCalendar).ok, false, '定義檔的春節照樣是假日');
  assert.throws(() => sync.revert({ year: 2027 }, 'alex.admin'), { status: 404, code: 'HOLIDAYS_NOT_SYNCED' });
  assert.ok(logs.includes('info:holidays.applied') && logs.includes('info:holidays.reverted'));
});

test('來源錯誤：還沒發布回 404、連線失敗與非 2xx 回 502、內容不是 JSON 回 502；年度超出範圍回 400，都不寫入', async () => {
  const { sync, store, logs } = setup({ 2026: { status: 503 }, 2025: new Error('offline'), 2024: 'not json' });
  await assert.rejects(sync.check(2027), { status: 404, code: 'HOLIDAYS_NOT_PUBLISHED' });
  await assert.rejects(sync.check(2026), { status: 502, code: 'HOLIDAYS_SOURCE_UNAVAILABLE' });
  await assert.rejects(sync.check(2025), { status: 502, code: 'HOLIDAYS_SOURCE_UNAVAILABLE' });
  await assert.rejects(sync.check(2024), { status: 502, code: 'HOLIDAYS_SOURCE_INVALID' });
  for (const year of [2016, 2028, '2027', 2027.5]) await assert.rejects(sync.check(year), { status: 400, code: 'INVALID_PAYLOAD' }, String(year));
  assert.equal(store.readHolidayRecord(), null);
  assert.ok(logs.includes('warn:holidays.fetch_failed'));
});

test('同步新的年度會開放該年度；meta 紀錄壞掉時改用定義檔並記錄警告，套用時覆寫', async () => {
  const { sync, store, logs } = setup({ 2027: sourceYear(2027, SOURCE_2027) });
  store.updateHolidayRecord(/** 寫入壞掉的紀錄。@returns {string} 值。 */ () => '{"version":1,"years":{"2027":{"dates":"bad"}}}');
  assert.equal(sync.load(), 0);
  assert.ok(logs.includes('warn:holidays.record_invalid'));
  assert.equal(sync.status().years.find(/** 找 2027。@param {{year: number}} item 年度。@returns {boolean} 是時 true。 */ (item) => item.year === 2027).origin, 'definition');
  await sync.apply({ year: 2027, digest: (await sync.check(2027)).digest }, 'alex.admin');
  assert.equal(parseHolidayRecord(store.readHolidayRecord()).ok, true, '套用時覆寫成正確格式');

  setSyncedHolidays(new Map([[2028, ['2028-01-03']]]));
  assert.equal(computeWorkMinutes('2028-01-04T09:00', '2028-01-04T18:00', leaveCalendar).minutes, 480, '同步過的年度視為開放');
  assert.deepEqual(pickerCalendar(leaveCalendar).open_years, [2026, 2027, 2028]);
  assert.throws(() => setSyncedHolidays(new Map([[2028, ['2027-01-01']]])), TypeError);
  assert.equal(HOLIDAY_RECORD, 'holiday_calendar');
});

test('API：一般帳號不能用；管理員可查看假日資料；年度格式不對時在連外之前就回 400', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(/** 等待監聽。@param {Function} resolve 成功。@returns {void} */ (resolve) => { server.once('listening', resolve); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  /** 呼叫 API。@param {string} path 路徑。@param {string} [token] 憑證。@param {object} [body] 本文。@returns {Promise<Response>} 回應。 */
  const call = (path, token, body) => fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  /** 登入。@param {string} username 帳號。@param {string} password 密碼。@returns {Promise<string>} 憑證。 */
  const login = async (username, password) => (await (await call('/auth/login', undefined, { username, password })).json()).token;
  try {
    assert.equal((await call('/admin/holidays')).status, 401);
    const user = await login(ACCOUNTS[0], 'test-only-password');
    const admin = await login('alex.admin', 'test-admin-only-password');
    assert.equal((await call('/admin/holidays', user)).status, 403);
    assert.equal((await call('/admin/holidays/check', user, { year: 2027 })).status, 403);
    const status = await call('/admin/holidays', admin);
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.source.url_template, HOLIDAY_SOURCE.urlTemplate);
    assert.ok(body.years.some(/** 有 2027。@param {{year: number}} item 年度。@returns {boolean} 是時 true。 */ (item) => item.year === 2027));
    const invalid = await call('/admin/holidays/check', admin, { year: 'abc' });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'INVALID_PAYLOAD');
    assert.equal((await call('/admin/holidays/apply', admin, { year: 2027, digest: 'x' })).status, 400);
    assert.equal((await call('/admin/holidays/revert', admin, { year: 2027 })).status, 404, '沒有同步資料時不需還原');
  } finally { server.closeAllConnections(); server.close(); }
});
