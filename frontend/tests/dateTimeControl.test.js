import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument } from './helpers/fakeDom.js';
import { createDateTimeControl, normalizeTimeText, periodLabel, layoutFields, timeGroups, todayIn, formatPickerDate, PICKER_TEXT } from '../src/components/propose/dateTimeControl.js';

// 測試用的工作日曆（正規化後的形狀）與固定的目前時間：台北時間 2026-11-04（週三）10:00；值都是假資料
const CALENDAR = { start: 'from_at', end: 'to_at', workWindows: [['09:00', '12:00'], ['13:00', '18:00']], workdays: [1, 2, 3, 4, 5], holidays: ['2026-11-11'], openYears: [2026], timezoneOffset: '+08:00' };
const NOW = Date.UTC(2026, 10, 4, 2);

/**
 * 固定的目前時間。
 * @returns {number} 毫秒時間戳。
 */
function now() { return NOW; }

/**
 * 依文字找出面板中的按鈕。
 * @param {object} panel 面板。
 * @param {string} className 按鈕樣式。
 * @param {string} text 文字。
 * @returns {object|undefined} 按鈕。
 */
function buttonIn(panel, className, text) {
  return panel.querySelectorAll(`.${className}`).find(/** 文字是否相符。@param {object} node 按鈕。@returns {boolean} 相符時 true。 */ (node) => node.textContent === text);
}

/**
 * 取出節點文字。
 * @param {object} node 元素。
 * @returns {string} 文字。
 */
function textOf(node) { return node.textContent; }

/**
 * 建立選擇器並記錄 onChange 通知的部分。
 * @param {object} options createDateTimeControl 的設定（不含 onChange 與 now）。
 * @returns {{picker: object, changes: number[]}} 選擇器與通知紀錄。
 */
function mount(options) {
  globalThis.document = createFakeDocument();
  const changes = [];
  const picker = createDateTimeControl({ id: 'pick', now, ...options, onChange: /** 記錄通知。@param {number} index 部分索引。@returns {void} */ (index) => changes.push(index) });
  globalThis.document.body.append(picker.root);
  return { picker, changes };
}

/** 清除全域文件替身。@returns {void} */
function cleanup() { delete globalThis.document; }
test.afterEach(cleanup);

/**
 * 驗證時間文字整理成 24 小時制「HH:mm」：常見的打字方式都接受，超出範圍或無法辨識的保留原文。
 * @returns {void}
 */
function timeText() {
  assert.equal(normalizeTimeText('9'), '09:00');
  assert.equal(normalizeTimeText('9:30'), '09:30');
  assert.equal(normalizeTimeText('0930'), '09:30');
  assert.equal(normalizeTimeText('930'), '09:30');
  assert.equal(normalizeTimeText(' 17:30 '), '17:30');
  assert.equal(normalizeTimeText('１８：００'), '18:00', '全形數字與冒號');
  assert.equal(normalizeTimeText(''), '');
  assert.equal(normalizeTimeText('25:00'), '25:00', '超出範圍保留原文');
  assert.equal(normalizeTimeText('下午三點'), '下午三點', '無法辨識保留原文');
}
test('時間文字整理成 24 小時制', timeText);

/**
 * 驗證純函式：期間名稱取共同開頭、今天依時區計算、日期顯示含星期、時間分組依工作日曆或全天。
 * @returns {void}
 */
function helpers() {
  assert.equal(periodLabel('使用起始日期', '使用截止日期'), '使用期間');
  assert.equal(periodLabel('開始日', '結束日'), '開始日～結束日', '沒有共同開頭時以～串接');
  assert.equal(periodLabel('日期', '日期時間'), '日期～日期時間', '一方完全是開頭時不縮寫');
  assert.equal(todayIn(Date.UTC(2026, 10, 4, 17), '+08:00'), '2026-11-05', '台北已過午夜');
  assert.equal(todayIn(Date.UTC(2026, 10, 4, 17), '-05:00'), '2026-11-04');
  assert.equal(formatPickerDate('2026-11-05'), '2026/11/05（四）');
  const start = timeGroups(CALENDAR, 'start');
  assert.deepEqual(start.map(/** 組名。@param {{name: string}} group 分組。@returns {string} 組名。 */ (group) => group.name), ['上午', '下午']);
  assert.deepEqual(start[0].times, ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30'], '開始時間不含時段終點');
  assert.deepEqual(timeGroups(CALENDAR, 'end')[1].times.at(-1), '18:00', '結束時間含時段終點');
  assert.equal(timeGroups(CALENDAR, 'end')[1].times[0], '13:30', '結束時間不含時段起點');
  assert.deepEqual(timeGroups({ ...CALENDAR, workWindows: [['08:00', '17:15']] }, 'end')[0].times.slice(-2), ['17:00', '17:15'], '時段終點不在 30 分鐘格線時補上');
  const day = timeGroups(null, 'start');
  assert.deepEqual(day.map(/** 每組數量。@param {{times: string[]}} group 分組。@returns {number} 數量。 */ (group) => group.times.length), [24, 12, 12]);
}
test('期間名稱、今天、日期顯示與時間分組', helpers);

/**
 * 驗證版面配對：rules.after 指向前面同型別的欄位時合併成期間並附上對應的日曆；型別不同、指向後面或不存在的欄位不合併。
 * @returns {void}
 */
function layout() {
  const fields = [
    { key: 'who', type: 'self', rules: { after: null } },
    { key: 'from_at', type: 'datetime', rules: { after: null } },
    { key: 'to_at', type: 'datetime', rules: { after: 'from_at' } },
    { key: 'due', type: 'date', rules: { after: 'from_at' } },
    { key: 'other', type: 'date', rules: { after: 'missing' } },
  ];
  const items = layoutFields(fields, [CALENDAR]);
  assert.deepEqual(items.map(/** 項目摘要。@param {object} item 項目。@returns {string} 摘要。 */ (item) => (item.kind === 'period' ? `${item.start.key}+${item.end.key}` : item.field.key)),
    ['who', 'from_at+to_at', 'due', 'other']);
  assert.equal(items[1].calendar, CALENDAR);
  assert.equal(items[2].calendar, null, '沒有日曆引用的單一欄位');
  assert.deepEqual(layoutFields([{ key: 'b', type: 'date', rules: { after: 'a' } }, { key: 'a', type: 'date', rules: {} }]).map(/** 種類。@param {object} item 項目。@returns {string} 種類。 */ (item) => item.kind),
    ['field', 'field'], '指向後面的欄位不合併');
}
test('依規則把起訖欄位合併成期間', layout);

/**
 * 驗證單一日期時間欄位：寫入值拆成日期與時間並切到該月；點選日期、時間按鈕或輸入其他時間時通知改變；看不懂的時間只提示；
 * 只選日期時值為空字串；無法解析的寫入值保留原文；清除後全部清空；Esc 關閉面板並把焦點還給按鈕。
 * @returns {Promise<void>}
 */
async function singleDateTime() {
  const { picker, changes } = mount({ labels: ['打卡時間'], mode: 'datetime' });
  const [part] = picker.parts;
  assert.equal(part.getAttribute('id'), 'pick');
  assert.equal(part.querySelector('.picker-part-value').textContent, PICKER_TEXT.chooseDateTime);
  part.value = '2026-12-01T09:30:00';
  assert.equal(part.value, '2026-12-01T09:30');
  assert.equal(part.querySelector('.picker-part-value').textContent, '2026/12/01（二） 09:30');
  assert.deepEqual(changes, [], '程式寫入不通知');
  await part.click();
  const panel = picker.panel;
  assert.equal(panel.hidden, false);
  assert.equal(part.getAttribute('aria-expanded'), 'true');
  assert.equal(panel.querySelector('.picker-month-title').textContent, '2026 年 12 月');
  assert.equal(panel.querySelectorAll('.picker-chip').length, 48, '沒有工作日曆時列出全天');
  assert.equal(buttonIn(panel, 'picker-chip', '09:30').getAttribute('aria-pressed'), 'true');
  await buttonIn(panel, 'picker-day', '3').click();
  assert.equal(part.value, '2026-12-03T09:30');
  await buttonIn(panel, 'picker-chip', '18:00').click();
  assert.equal(part.value, '2026-12-03T18:00');
  const custom = panel.querySelector('#pick-custom-0');
  custom.value = '０７４５';
  await custom.dispatch('change');
  assert.equal(part.value, '2026-12-03T07:45', '其他時間接受任何分鐘');
  assert.deepEqual(changes, [0, 0, 0]);
  const again = panel.querySelector('#pick-custom-0');
  again.value = '七點';
  await again.dispatch('change');
  assert.equal(panel.querySelector('.picker-message').textContent, PICKER_TEXT.unreadable);
  assert.equal(part.value, '2026-12-03T07:45', '看不懂的時間不改變選擇');
  assert.deepEqual(changes, [0, 0, 0]);
  await panel.querySelector('.picker-clear').click();
  assert.equal(part.value, '');
  await buttonIn(panel, 'picker-day', '4').click();
  assert.equal(part.value, '', '只選日期時值為空字串');
  assert.equal(part.querySelector('.picker-part-value').textContent, `2026/12/04（五） ${PICKER_TEXT.noTime}`);
  await panel.dispatch('keydown', {
    key: 'Escape',
    /** 空的預設行為攔截。@returns {void} */
    preventDefault() {},
  });
  assert.equal(panel.hidden, true);
  assert.equal(globalThis.document.activeElement, part);
  part.value = '明天早上';
  assert.equal(part.value, '明天早上', '無法解析的值保留原文，交給後端回報');
  assert.equal(part.querySelector('.picker-part-value').textContent, '明天早上');
}
test('單一日期時間欄位的選擇與讀寫', singleDateTime);

/**
 * 驗證期間（有工作日曆）：週末、假日與未開放年度停用；先點開始日再點結束日；快捷需要先選日期；同一天時早於開始的結束時間停用，
 * 開始時間改到結束之後會清除結束時間；結束日早於新的開始日時清除；點結束按鈕開啟時下一次點選設定結束日。
 * @returns {Promise<void>}
 */
async function periodWithCalendar() {
  const { picker, changes } = mount({ labels: ['起始時間', '截止時間'], mode: 'datetime', calendar: CALENDAR });
  const [start, end] = picker.parts;
  assert.equal(end.getAttribute('id'), 'pick-end');
  assert.deepEqual(picker.root.querySelectorAll('.picker-part-caption').map(textOf), [PICKER_TEXT.start, PICKER_TEXT.end]);
  await start.click();
  const panel = picker.panel;
  assert.equal(panel.querySelector('.picker-month-title').textContent, '2026 年 11 月', '沒有值時顯示今天的月份');
  assert.equal(buttonIn(panel, 'picker-day', '8').disabled, true, '週日');
  assert.equal(buttonIn(panel, 'picker-day', '11').disabled, true, '假日');
  await buttonIn(panel, 'picker-chip', '整天 09:00–18:00').click();
  assert.equal(panel.querySelector('.picker-message').textContent, PICKER_TEXT.pickDateFirst);
  assert.deepEqual(changes, []);
  await buttonIn(panel, 'picker-day', '5').click();
  assert.deepEqual(changes, [0, 1], '選開始日時兩個部分都標記為手動');
  assert.equal(panel.querySelector('.picker-hint').textContent, PICKER_TEXT.hintEnd);
  await buttonIn(panel, 'picker-chip', '10:00').click();
  const endTen = panel.querySelectorAll('.picker-times')[1].querySelectorAll('.picker-chip').find(/** 結束的 10:00。@param {object} node 按鈕。@returns {boolean} 相符時 true。 */ (node) => node.textContent === '10:00');
  assert.equal(endTen.disabled, true, '同一天時不晚於開始的結束時間停用');
  await panel.querySelectorAll('.picker-times')[1].querySelectorAll('.picker-chip').find(/** 結束的 17:00。@param {object} node 按鈕。@returns {boolean} 相符時 true。 */ (node) => node.textContent === '17:00').click();
  assert.deepEqual([start.value, end.value], ['2026-11-05T10:00', '2026-11-05T17:00']);
  await panel.querySelectorAll('.picker-times')[0].querySelectorAll('.picker-chip').find(/** 開始的 17:30。@param {object} node 按鈕。@returns {boolean} 相符時 true。 */ (node) => node.textContent === '17:30').click();
  assert.equal(end.value, '', '開始晚於結束時清除結束時間');
  assert.equal(panel.querySelector('.picker-message').textContent, PICKER_TEXT.endCleared);
  await buttonIn(panel, 'picker-day', '9').click();
  await buttonIn(panel, 'picker-chip', '下午 13:00–18:00').click();
  assert.deepEqual([start.value, end.value], ['2026-11-05T13:00', '2026-11-09T18:00'], '跨日期間');
  assert.equal(buttonIn(panel, 'picker-day', '6').className.includes('is-inside'), true, '中間的日期標示在期間內');
  await buttonIn(panel, 'picker-day', '3').click();
  assert.equal(start.value, '2026-11-03T13:00', '早於開始日的點選改為新的開始日');
  assert.equal(end.value, '2026-11-09T18:00', '結束日仍晚於開始日時保留');
  await end.click();
  assert.equal(panel.hidden, false, '點另一個部分時面板保持開啟');
  await buttonIn(panel, 'picker-day', '10').click();
  assert.equal(end.value, '2026-11-10T18:00', '從結束按鈕開啟時點選設定結束日');
  for (let step = 0; step < 2; step += 1) await panel.querySelectorAll('.picker-nav')[1].click();
  assert.equal(panel.querySelector('.picker-month-title').textContent, '2027 年 1 月');
  assert.equal(buttonIn(panel, 'picker-day', '4').disabled, true, '未開放的年度停用');
  await end.click();
  assert.equal(panel.hidden, true, '同一個部分再點一次關閉面板');
}
test('期間選擇器依工作日曆限制日期與時間', periodWithCalendar);

/**
 * 驗證日期期間（不含時間）：沒有時間區與快捷；not_before_today 停用今天以前；結束日要另外點選。
 * @returns {Promise<void>}
 */
async function dateRange() {
  const { picker } = mount({ labels: ['起始日期', '截止日期'], mode: 'date', notBeforeToday: true });
  const [start, end] = picker.parts;
  await start.click();
  const panel = picker.panel;
  assert.equal(panel.querySelectorAll('.picker-chip').length, 0);
  assert.equal(buttonIn(panel, 'picker-day', '3').disabled, true, '今天以前停用');
  assert.equal(buttonIn(panel, 'picker-day', '7').disabled, false, '沒有工作日曆時週末可選');
  await buttonIn(panel, 'picker-day', '7').click();
  assert.deepEqual([start.value, end.value], ['2026-11-07', ''], '結束日不沿用開始日');
  await buttonIn(panel, 'picker-day', '7').click();
  assert.deepEqual([start.value, end.value], ['2026-11-07', '2026-11-07'], '同一天再點一次');
  assert.equal(end.querySelector('.picker-part-value').textContent, '2026/11/07（六）');
  start.value = '2026-11-20T00:00';
  assert.equal(start.value, '2026-11-20', '日期欄位接受帶時間的值，只取日期');
}
test('日期期間與今天以前的限制', dateRange);
