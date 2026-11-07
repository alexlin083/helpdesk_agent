import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFormDate, formatFormDateTime, formatMinutes, formatFieldValue, formatComputedValue, previewFields, describeFormFields, describeFormComputed, describeFormPolicy, ticketTypeId } from '../src/utils/formFormatters.js';
import { LEAVE_TYPE, EQUIPMENT_TYPE, FILLED_LEAVE_VALUES } from './helpers/draftFixtures.js';

/**
 * 驗證日期與日期時間加上星期（依日曆日期計算），格式不符或日期不存在時原樣回傳。
 * @returns {void}
 */
function dates() {
  assert.equal(formatFormDate('2026-12-01'), '2026-12-01（週二）');
  assert.equal(formatFormDate('2027-01-03'), '2027-01-03（週日）');
  assert.equal(formatFormDate('2026-02-30'), '2026-02-30');
  assert.equal(formatFormDate('12/01'), '12/01');
  assert.equal(formatFormDate(null), '');
  assert.equal(formatFormDateTime('2026-12-01T09:30'), '2026-12-01（週二）09:30');
  assert.equal(formatFormDateTime('2026-13-01T09:30'), '2026-13-01T09:30');
  assert.equal(formatFormDateTime(5), '');
}
test('日期與日期時間加上星期', dates);

/**
 * 驗證欄位值與計算值的通用格式：依欄位型別（或未知型別時依值的格式）加星期；hours_minutes 顯示為時數，其他以文字顯示。
 * @returns {void}
 */
function values() {
  assert.equal(formatMinutes(420), '7 小時');
  assert.equal(formatMinutes(61), '1 小時 1 分鐘');
  assert.equal(formatMinutes(-90), '-1 小時 30 分鐘');
  assert.equal(formatMinutes('x'), '—');
  assert.equal(formatFieldValue(' 2026-12-01 ', 'date'), '2026-12-01（週二）');
  assert.equal(formatFieldValue('2026-12-01T09:30', 'datetime'), '2026-12-01（週二）09:30');
  assert.equal(formatFieldValue('2026-12-01T09:30'), '2026-12-01（週二）09:30', '未知型別時依格式判斷');
  assert.equal(formatFieldValue('2026-12-01', 'text'), '2026-12-01', '已知是文字時不轉換');
  assert.equal(formatFieldValue('  ', 'text'), '');
  assert.equal(formatFieldValue(3), '');
  assert.equal(formatComputedValue(420, 'hours_minutes'), '7 小時');
  assert.equal(formatComputedValue(30, ''), '30');
  assert.equal(formatComputedValue(null, 'hours_minutes'), '');
}
test('欄位值與計算值的通用格式', values);

/**
 * 驗證簡易預覽依欄位定義列出「[名稱]: 值」，self 欄位沒有值時填入登入者；任何類型都使用同一套規則。
 * @returns {void}
 */
function preview() {
  assert.equal(previewFields({ fields: LEAVE_TYPE.fields, values: {}, username: 'tina.test' }),
    '[請假人]: tina.test\n[假別]: \n[請假起始時間]: \n[請假截止時間]: \n[代理人]: \n[備註]: ');
  assert.equal(previewFields({ fields: EQUIPMENT_TYPE.fields, values: { applicant: 'other.test', item: ' 螢幕 ', quantity: '2' }, username: 'tina.test' }),
    '[申請人]: other.test\n[設備品項]: 螢幕\n[數量]: 2\n[用途說明]: \n[需要日期]: \n[送交地點]: ');
}
test('簡易預覽依欄位定義列出', preview);

/**
 * 把欄位列轉成 [名稱, 值]。
 * @param {{label: string, value: string}} row 欄位列。
 * @returns {string[]} 名稱與值。
 */
function toPair(row) { return [row.label, row.value]; }

/**
 * 驗證狀態追蹤頁的表單欄位清單：有目錄定義時使用定義的名稱、順序與型別（舊版本的單也一樣），定義外的欄位接在後面；
 * 沒有目錄時改用記錄帶的 labels，再沒有就以欄位代號為名稱，日期時間依格式加上星期；空白值顯示「無」。
 * @returns {void}
 */
function storedFields() {
  const stored = { id: 'leave', version: 1, fields: { ...FILLED_LEAVE_VALUES, extra: '附加' }, labels: {}, computed: { minutes: 420, year: 2026 } };
  assert.deepEqual(describeFormFields(stored, LEAVE_TYPE).map(toPair), [
    ['請假人', 'tina.test'], ['假別', '事假'], ['請假起始時間', '2026-12-01（週二）09:30'], ['請假截止時間', '2026-12-01（週二）17:30'],
    ['代理人', 'kevin.test'], ['備註', '無'], ['extra', '附加'],
  ]);
  const labelled = { id: 'future-test', fields: { b: '2026-11-20', a: '' }, labels: { a: '甲', b: '乙' } };
  assert.deepEqual(describeFormFields(labelled).map(toPair), [['甲', '無'], ['乙', '2026-11-20（週五）']]);
  assert.deepEqual(describeFormFields({ id: 'x', fields: { start_at: '2026-12-01T09:30' } }).map(toPair), [['start_at', '2026-12-01（週二）09:30']]);
}
test('狀態追蹤頁的表單欄位名稱與順序', storedFields);

/**
 * 驗證保存的計算結果：新版陣列直接顯示；舊版物件只顯示目錄有名稱的鍵並依 display 格式化；沒有目錄時不顯示舊版物件。
 * @returns {void}
 */
function storedComputed() {
  assert.deepEqual(describeFormComputed({ computed: [{ key: 'minutes', label: '請假時數', text: '7 小時 0 分鐘' }, { key: 'blank', label: '空', text: '' }] }).map(toPair), [['請假時數', '7 小時 0 分鐘']]);
  const definition = { computed: [{ key: 'minutes', label: '請假時數', display: 'hours_minutes' }, { key: 'missing', label: '沒有值', display: '' }] };
  assert.deepEqual(describeFormComputed({ computed: { minutes: 420, year: 2026 } }, definition).map(toPair), [['請假時數', '7 小時']]);
  assert.deepEqual(describeFormComputed({ computed: { minutes: 420 } }), []);
  assert.deepEqual(describeFormComputed({ computed: null }), []);
}
test('狀態追蹤頁的計算結果', storedComputed);

/**
 * 驗證卡片動作設定：記錄的 workflow 優先、其次目錄（以 ticketTypeId 取得 form.id 或 request_type.id），都沒有時 route 為 FORM 的單不能轉單；
 * 提單人只有在定義明確設 not_requester 為 false 時才能自己簽核，沒有需求類型的單也不行。
 * @returns {void}
 */
function policy() {
  const formTicket = { route: 'FORM', form: { workflow: { transfer: null, not_requester: null } } };
  assert.deepEqual(describeFormPolicy(formTicket), { transferable: false, selfApprovable: false });
  assert.deepEqual(describeFormPolicy(formTicket, { workflow: { transfer: true, not_requester: true } }), { transferable: true, selfApprovable: false });
  assert.deepEqual(describeFormPolicy({ route: 'FORM', form: { workflow: { transfer: false, not_requester: false } } }, { workflow: { transfer: true, not_requester: true } }),
    { transferable: false, selfApprovable: true }, '記錄的設定優先於目錄');
  assert.deepEqual(describeFormPolicy({ route: 'DEPARTMENT', form: { workflow: {} } }), { transferable: true, selfApprovable: false }, '查不到設定時提單人不能自己簽核');
  assert.deepEqual(describeFormPolicy({ route: 'HANDLER', form: null }), { transferable: true, selfApprovable: false }, '沒有需求類型的舊流程單同樣不能自己簽核');
  const general = { route: 'DEPARTMENT', form: null, request_type: { id: 'general', version: 1 } };
  assert.equal(ticketTypeId(general), 'general');
  assert.equal(ticketTypeId({ form: { id: 'leave' }, request_type: null }), 'leave');
  assert.equal(ticketTypeId({ form: null, request_type: null }), null);
  assert.deepEqual(describeFormPolicy(general, { workflow: { transfer: true, not_requester: true } }), { transferable: true, selfApprovable: false });
  assert.deepEqual(describeFormPolicy(general, { workflow: { transfer: false, not_requester: false } }), { transferable: false, selfApprovable: true }, '定義明確允許時才可以自己簽核');
}
test('依 workflow 決定卡片動作', policy);
