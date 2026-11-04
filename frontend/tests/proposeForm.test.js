import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTicketInput, countCodePoints, TICKET_LIMITS } from '../src/services/ticketService.js';
import { describeAttached, PROPOSE_TEXT } from '../src/pages/propose.js';

/**
 * 驗證主題與需求內容的必填、空白與字數邊界提示，兩欄一起檢查。
 * @returns {void}
 */
function fieldValidation() {
  assert.deepEqual(validateTicketInput({ subject: '', content: '' }), { subject: '請填寫主題', content: '請填寫需求內容' });
  assert.deepEqual(validateTicketInput({ subject: '   ', content: '\n\t' }), { subject: '請填寫主題', content: '請填寫需求內容' });
  assert.deepEqual(validateTicketInput({ subject: undefined, content: null }), { subject: '請填寫主題', content: '請填寫需求內容' });
  assert.deepEqual(validateTicketInput({ subject: ' 申請 VPN 帳號 ', content: '新進同仁需要 VPN 連線權限' }), { subject: '', content: '' });
  assert.deepEqual(validateTicketInput({ subject: '😀'.repeat(100), content: '😀'.repeat(2000) }), { subject: '', content: '' });
  assert.deepEqual(validateTicketInput({ subject: '😀'.repeat(101), content: 'x' }), { subject: '主題最多 100 字，目前 101 字', content: '' });
  assert.deepEqual(validateTicketInput({ subject: 'x', content: 'a'.repeat(2345) }), { subject: '', content: '需求內容最多 2000 字，目前 2345 字' });
  assert.deepEqual(validateTicketInput({ subject: 'a'.repeat(150), content: '' }), { subject: '主題最多 100 字，目前 150 字', content: '請填寫需求內容' });
  assert.equal(TICKET_LIMITS.subject, 100);
  assert.equal(TICKET_LIMITS.content, 2000);
}
test('主題與需求內容的驗證提示', fieldValidation);

/**
 * 驗證字數以去除首尾空白後的 Unicode code points 計算。
 * @returns {void}
 */
function counting() {
  assert.equal(countCodePoints(''), 0);
  assert.equal(countCodePoints('  '), 0);
  assert.equal(countCodePoints(' 中文 '), 2);
  assert.equal(countCodePoints('😀😀'), 2);
  assert.equal(countCodePoints('a b'), 3);
  assert.equal(countCodePoints(null), 0);
  assert.equal(countCodePoints(123), 0);
}
test('字數以 Unicode code points 計算', counting);

/**
 * 驗證套用「自動生成」後的提示文字：只有部門時使用 PROPOSE_TEXT.attached；對話中指定處理人時改用 PROPOSE_TEXT.attachedHandler 並列出處理人帳號；
 * 處理人省略或為空字串時視為不指定，退回只顯示部門的版本。
 * @returns {void}
 */
function attachedDescription() {
  assert.equal(describeAttached('測試人資部'), PROPOSE_TEXT.attached.replace('{department}', '測試人資部'));
  assert.equal(describeAttached('測試人資部'), '已由自動生成確認，將送達「測試人資部」');
  assert.equal(describeAttached('測試人資部', ''), describeAttached('測試人資部'), '空字串代表不指定處理人');
  assert.equal(describeAttached('測試資訊部', 'ivan.test'), PROPOSE_TEXT.attachedHandler.replace('{department}', '測試資訊部').replace('{handler}', 'ivan.test'));
  assert.equal(describeAttached('測試資訊部', 'ivan.test'), '已由自動生成確認，將送達「測試資訊部」的 ivan.test');
}
test('套用提示依是否指定處理人組出文字', attachedDescription);
