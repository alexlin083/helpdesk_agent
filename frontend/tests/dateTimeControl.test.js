import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument } from './helpers/fakeDom.js';
import { createDateTimeControl, normalizeTimeText } from '../src/components/propose/dateTimeControl.js';

/**
 * 驗證時間文字整理成 24 小時制「HH:mm」：常見的打字方式都接受，超出範圍或無法辨識的保留原文交給後端驗證
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
 * 驗證日期＋時間組合欄位：寫入時拆成兩邊、讀取時組回「YYYY-MM-DDTHH:mm」、只填一邊時讀到空字串、
 * 時間欄 change 時先整理成「HH:mm」，並帶有 30 分鐘一筆的建議清單與無障礙名稱
 * @returns {Promise<void>}
 */
async function composite() {
  globalThis.document = createFakeDocument();
  const { root, date, time } = createDateTimeControl({ id: 'draft-field-start_at', label: '請假起始時間' });
  assert.equal(date.getAttribute('id'), 'draft-field-start_at');
  assert.equal(time.getAttribute('aria-label'), '請假起始時間的時間（24 小時制）');
  assert.equal(root.getAttribute('role'), 'group');
  root.value = '2026-12-01T09:30:00';
  assert.equal(date.value, '2026-12-01');
  assert.equal(time.value, '09:30');
  assert.equal(root.value, '2026-12-01T09:30');
  time.value = '';
  assert.equal(root.value, '', '只有日期時讀到空字串');
  time.value = '1730';
  await time.dispatch('change');
  assert.equal(time.value, '17:30', '離開時間欄時整理格式');
  assert.equal(root.value, '2026-12-01T17:30');
  root.value = '';
  assert.equal(date.value, '');
  assert.equal(time.value, '');
  const list = root.querySelector('datalist');
  assert.equal(list.children.length, 48);
  assert.equal(list.children[19].value, '09:30');
}
test('日期＋時間組合欄位的讀寫與整理', composite);
