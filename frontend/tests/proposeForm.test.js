import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTicketInput, countCodePoints, TICKET_LIMITS } from '../src/services/ticketService.js';
import { buildHandlerOptions } from '../src/propose.js';

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
 * 驗證下拉選單依部門分組、只顯示帳號名稱，沒有處理人的部門不列出。
 * @returns {void}
 */
function handlerOptions() {
  const departments = [
    { id: 'd1', name: '資訊管理一部', type: '', duty: '', business: [], handlers: [{ id: 'h1', name: 'racky.huang' }, { id: 'h2', name: 'amy.chen' }] },
    { id: 'd2', name: '沒有處理人', type: '', duty: '', business: ['x'], handlers: [] },
    { id: 'd3', name: '人力資源部', type: '', duty: '', business: [], handlers: [{ id: 'h3', name: 'emily.wu' }] },
  ];
  assert.deepEqual(buildHandlerOptions(departments), [
    { label: '資訊管理一部', type: '', options: [
      { value: 'h1', label: 'racky.huang', target: 'racky.huang（資訊管理一部）' },
      { value: 'h2', label: 'amy.chen', target: 'amy.chen（資訊管理一部）' },
    ] },
    { label: '人力資源部', type: '', options: [{ value: 'h3', label: 'emily.wu', target: 'emily.wu（人力資源部）' }] },
  ]);
  assert.deepEqual(buildHandlerOptions([]), []);
}
test('指定處理人選項依部門分組並略過沒有處理人的部門', handlerOptions);
