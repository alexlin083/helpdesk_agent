import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument } from './helpers/fakeDom.js';
import { summarizeTicketResult, renderTicketResult, renderDepartmentCards, RESULT_TEXT } from '../src/components/dialogs.js';

/**
 * 驗證三種 route 的送達、方式、說明與判斷依據文案。
 * @returns {void}
 */
function summaries() {
  assert.deepEqual(summarizeTicketResult({ ticket_id: 'TK-1', route: 'HANDLER', department: '資訊管理一部', handler: { name: 'racky.huang' } }),
    { target: 'racky.huang（資訊管理一部）', method: '已指定處理人，直接送達', note: '需求單已送到指定處理人手上', basis: '' });
  assert.deepEqual(summarizeTicketResult({ ticket_id: 'TK-2', route: 'DEPARTMENT', department: '資訊管理二部', basis: '需求提到 ERP' }),
    { target: '資訊管理二部', method: 'AI 依主題與內容判斷部門', note: '需求單已送往「資訊管理二部」簽核', basis: '需求提到 ERP' });
  assert.deepEqual(summarizeTicketResult({ ticket_id: 'TK-3', route: 'DEPARTMENT', department: '資訊管理二部' }),
    { target: '資訊管理二部', method: RESULT_TEXT.DEPARTMENT.method, note: '需求單已送往「資訊管理二部」簽核', basis: '' });
  assert.deepEqual(summarizeTicketResult({ ticket_id: 'TK-4', route: 'FALLBACK', department: '資訊管理一部', basis: '對不到部門' }),
    { target: '資訊管理一部', method: '內容未對應到明確部門', note: '先送「資訊管理一部」，由人工分派部門', basis: '對不到部門' });
}
test('結果視窗的三種 route 文案', summaries);

/**
 * 驗證結果視窗節點的填寫，以及沒有判斷依據時隱藏整列。
 * @returns {void}
 */
function resultRendering() {
  const doc = createFakeDocument();
  const nodes = {};
  for (const name of ['subject', 'ticket', 'target', 'method', 'basisRow', 'basis', 'note']) nodes[name] = doc.createElement('div');
  renderTicketResult(nodes, 'VPN 連不上', { ticket_id: 'TK-9', route: 'DEPARTMENT', department: 'IT資訊服務台', basis: '關鍵字：VPN' });
  assert.equal(nodes.subject.textContent, 'VPN 連不上');
  assert.equal(nodes.ticket.textContent, 'TK-9');
  assert.equal(nodes.target.textContent, 'IT資訊服務台');
  assert.equal(nodes.method.textContent, 'AI 依主題與內容判斷部門');
  assert.equal(nodes.basis.textContent, '關鍵字：VPN');
  assert.equal(nodes.basisRow.hidden, false);
  assert.equal(nodes.note.textContent, '需求單已送往「IT資訊服務台」簽核');
  renderTicketResult(nodes, '申請 VPN 帳號', { ticket_id: 'TK-10', route: 'HANDLER', department: '資訊管理一部', handler: { name: 'racky.huang' } });
  assert.equal(nodes.basisRow.hidden, true);
  assert.equal(nodes.basis.textContent, '');
  assert.equal(nodes.target.textContent, 'racky.huang（資訊管理一部）');
}
test('結果視窗填寫與判斷依據列的顯示', resultRendering);

/**
 * 驗證部門卡片：type 為空時不顯示標籤、沒有處理人的部門仍列出、關鍵字逐項顯示、沒有部門時沒有內容。
 * @returns {void}
 */
function departmentCards() {
  const doc = createFakeDocument();
  globalThis.document = doc;
  try {
    const container = doc.createElement('div');
    renderDepartmentCards(container, [
      { id: 'd1', name: 'IT資訊服務台', type: 'IT', duty: '處理帳號、密碼、網路', business: ['VPN', '帳號與密碼'], handlers: [] },
      { id: 'd2', name: '人力資源部', type: '', duty: '', business: [], handlers: [{ id: 'h', name: 'x' }] },
    ]);
    assert.equal(container.children.length, 2);
    const [first, second] = container.children;
    assert.equal(first.querySelector('.department-name').textContent, 'IT資訊服務台');
    assert.equal(first.querySelector('.department-type').textContent, 'IT');
    assert.equal(first.querySelector('.department-duty').textContent, '處理帳號、密碼、網路');
    assert.deepEqual(first.querySelectorAll('.keyword').map((node) => node.textContent), ['VPN', '帳號與密碼']);
    assert.equal(second.querySelector('.department-type'), null);
    assert.equal(second.querySelector('.department-duty'), null);
    assert.equal(second.querySelector('.keyword-list'), null);
    renderDepartmentCards(container, []);
    assert.equal(container.children.length, 0);
    assert.equal(container.textContent, '');
  } finally { delete globalThis.document; }
}
test('各部門業務範圍卡片的呈現規則', departmentCards);
