import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, fakeAuth, pageIds } from './helpers/fakeDom.js';
import { initAdminHolidays } from '../src/components/admin/adminHolidays.js';
import { applyHolidays, checkHolidays, loadHolidays, HolidayServiceError } from '../src/services/holidayService.js';

const ADMIN = { username: 'alex.admin', userID: 'user-alex.admin', role: 'ADMIN', department: { id: 'dept-it-1', name: '測試資訊部門' } };
const NODES = [['section', 'admin-holidays'], ['p', 'holidays-state'], ['tbody', 'holidays-years'], ['form', 'holidays-check-form'], ['input', 'holidays-year'], ['button', 'holidays-check'],
  ['div', 'holidays-preview'], ['p', 'holidays-preview-summary'], ['ul', 'holidays-preview-list'], ['button', 'holidays-apply'], ['p', 'holidays-status'], ['a', 'holidays-source-link']];
const SOURCE = { id: 'ruyut/TaiwanCalendar', name: '來源', url_template: 'https://example.test/{year}.json', license: 'CC BY 4.0', homepage: 'https://example.test/home' };

/**
 * 組出假日資料摘要
 * @param {object[]} years 年度摘要
 * @returns {object} 摘要
 */
function summary(years) {
  return { source: SOURCE, latest_year: 2027, years };
}
const DEFINITION = summary([{ year: 2026, origin: 'definition', dates: [{ date: '2026-12-25', description: null }], applied_by: null, applied_at: null },
  { year: 2027, origin: 'definition', dates: [{ date: '2027-01-01', description: null }], applied_by: null, applied_at: null }]);
const SYNCED = summary([DEFINITION.years[0], { year: 2027, origin: 'synced', dates: [{ date: '2027-01-01', description: '開國紀念日' }, { date: '2027-06-09', description: '端午節' }], applied_by: 'alex.admin', applied_at: '2026-11-19T04:00:00.000Z' }]);
const CHECKED = { year: 2027, origin: 'definition', holidays: [], added: [{ date: '2027-06-09', description: '端午節' }], removed: [], unchanged: 1, makeup_days: [], can_apply: true, blocked_reason: null, digest: 'a'.repeat(64) };

/**
 * 建立假日資料區需要的節點
 * @returns {{doc: object, nodes: Record<string, object>}} 文件與節點
 */
function setup() {
  const doc = createFakeDocument();
  const nodes = {};
  for (const [tag, id] of NODES) {
    nodes[id] = doc.createElement(tag);
    nodes[id].setAttribute('id', id);
    doc.body.append(nodes[id]);
  }
  return { doc, nodes };
}

test('管理頁假日資料：顯示各年度來源；檢查只列差異；套用送回摘要值；改年度清掉預覽；同步過的年度可以還原', async () => {
  const { doc, nodes } = setup();
  const calls = [];
  const holidays = initAdminHolidays(doc, {
    auth: fakeAuth(ADMIN), leave() { calls.push('leave'); },
    /** 讀摘要 @returns {Promise<object>} 摘要 */ async load() { return DEFINITION; },
    /** 檢查 @param {number} year 年度 @returns {Promise<object>} 結果 */ async check(year) { calls.push(`check:${year}`); return CHECKED; },
    /** 套用 @param {object} choice 年度與摘要值 @returns {Promise<object>} 摘要 */ async apply(choice) { calls.push(`apply:${choice.year}:${choice.digest.length}`); return SYNCED; },
    /** 還原 @param {number} year 年度 @returns {Promise<object>} 摘要 */ async revert(year) { calls.push(`revert:${year}`); return DEFINITION; },
  });
  await holidays.refresh();
  assert.equal(nodes['holidays-year'].value, '2027', '預設為可同步的最晚年度');
  assert.equal(nodes['holidays-years'].children.length, 2);
  assert.match(nodes['holidays-state'].textContent, /還沒有同步過/);
  assert.equal(nodes['holidays-source-link'].getAttribute('href'), SOURCE.homepage);
  assert.equal(nodes['holidays-preview'].hidden, true);
  assert.equal(nodes['holidays-apply'].disabled, true, '還沒檢查不能套用');

  await holidays.runCheck();
  assert.deepEqual(calls, ['check:2027']);
  assert.equal(nodes['holidays-preview'].hidden, false);
  assert.match(nodes['holidays-preview-summary'].textContent, /新增 1 天、移除 0 天、沒變 1 天/);
  assert.match(nodes['holidays-preview-list'].textContent, /＋ 2027-06-09（端午節）/);
  assert.equal(nodes['holidays-apply'].disabled, false);

  await nodes['holidays-year'].dispatch('input');
  assert.equal(nodes['holidays-preview'].hidden, true, '改了年度就清掉舊的預覽');
  assert.equal(nodes['holidays-apply'].disabled, true);
  await holidays.runApply();
  assert.deepEqual(calls, ['check:2027'], '沒有檢查結果時不套用');

  await holidays.runCheck();
  await holidays.runApply();
  assert.deepEqual(calls.slice(-1), ['apply:2027:64']);
  assert.match(nodes['holidays-status'].textContent, /已套用 2027 年/);
  assert.equal(nodes['holidays-preview'].hidden, true);
  assert.match(nodes['holidays-state'].textContent, /2027 年使用同步的假日/);
  const syncedRow = nodes['holidays-years'].children[1];
  assert.match(syncedRow.textContent, /已同步/);
  const revertButton = syncedRow.querySelector('button');
  assert.ok(revertButton, '同步過的年度有還原按鈕');
  await revertButton.click();
  assert.deepEqual(calls.slice(-1), ['revert:2027']);
  assert.match(nodes['holidays-status'].textContent, /已把 2027 年還原/);

  nodes['holidays-year'].value = 'abc';
  await holidays.runCheck();
  assert.ok(nodes['holidays-status'].classList.contains('is-error'));
  assert.equal(calls.filter(/** 檢查呼叫 @param {string} item 紀錄 @returns {boolean} 是時 true */ (item) => item.startsWith('check')).length, 2, '年度格式不對不送出');
  assert.equal(initAdminHolidays(createFakeDocument(), { auth: fakeAuth(ADMIN), leave() {} }), null, '頁面沒有這一區時不初始化');
});

test('管理頁假日資料：有補班日時不能套用；來源在檢查後變了就清掉預覽；登入失效時登出', async () => {
  const { doc, nodes } = setup();
  let left = 0;
  let result = { ...CHECKED, can_apply: false, blocked_reason: '這一年有週末補班日', makeup_days: [{ date: '2027-02-20', description: '補班' }] };
  const holidays = initAdminHolidays(doc, {
    auth: fakeAuth(ADMIN), leave() { left += 1; },
    /** 讀摘要 @returns {Promise<object>} 摘要 */ async load() { return DEFINITION; },
    /** 檢查 @returns {Promise<object>} 結果 */ async check() { return result; },
    /** 套用失敗 @returns {Promise<never>} 拋出 */ async apply() { throw new HolidayServiceError('來源資料在檢查之後有變動', 409, 'HOLIDAYS_CHANGED'); },
    /** 還原 @returns {Promise<never>} 拋出 */ async revert() { throw new HolidayServiceError('請先登入管理員帳號', 401); },
  });
  await holidays.refresh();
  await holidays.runCheck();
  assert.equal(nodes['holidays-apply'].disabled, true, '有補班日不能套用');
  assert.match(nodes['holidays-preview-list'].textContent, /補班日：2027-02-20（補班）/);
  assert.ok(nodes['holidays-status'].classList.contains('is-error'));

  result = CHECKED;
  await holidays.runCheck();
  await holidays.runApply();
  assert.equal(nodes['holidays-preview'].hidden, true, '來源變了就清掉預覽，請重新檢查');
  assert.match(nodes['holidays-status'].textContent, /有變動/);
  await holidays.runRevert(2027);
  assert.equal(left, 1, '登入失效時登出');
});

test('假日服務：帶管理員憑證；回應格式不符時拋出；錯誤保留狀態與代碼；管理頁有所需節點', async () => {
  const original = globalThis.fetch;
  const requests = [];
  try {
    /**
     * 假的 fetch
     * @param {object} body 回應 JSON
     * @param {number} [status=200] 狀態
     * @returns {Function} fetch
     */
    const respond = (body, status = 200) => /** 記錄請求並回應 @param {string} url 網址 @param {object} init 選項 @returns {Promise<object>} 回應替身 */ async (url, init) => {
      requests.push({ url, init });
      return { ok: status < 400, status, json: /** 回應 JSON @returns {Promise<object>} 本文 */ async () => body };
    };
    globalThis.fetch = respond(DEFINITION);
    assert.deepEqual(await loadHolidays(fakeAuth(ADMIN)), DEFINITION);
    assert.match(requests[0].url, /\/api\/admin\/holidays$/);
    assert.equal(requests[0].init.method, 'GET');
    globalThis.fetch = respond(CHECKED);
    await checkHolidays(2027, fakeAuth(ADMIN));
    assert.equal(requests[1].init.body, JSON.stringify({ year: 2027 }));
    globalThis.fetch = respond({ years: [] });
    await assert.rejects(loadHolidays(fakeAuth(ADMIN)), /格式異常/);
    globalThis.fetch = respond({ error: { code: 'HOLIDAYS_CHANGED', message: '來源資料在檢查之後有變動' } }, 409);
    await assert.rejects(applyHolidays({ year: 2027, digest: 'a'.repeat(64) }, fakeAuth(ADMIN)), { status: 409, code: 'HOLIDAYS_CHANGED' });
    await assert.rejects(loadHolidays(fakeAuth(null)), { status: 401 }, '沒登入不送出');
  } finally { globalThis.fetch = original; }
  const ids = pageIds(new URL('../pages/admin/admin.html', import.meta.url));
  for (const [, id] of NODES) assert.ok(ids.has(id), id);
});
