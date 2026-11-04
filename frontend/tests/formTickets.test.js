import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument } from './helpers/fakeDom.js';
import { submitTicket, normalizeTicketResponse, normalizeStoredTicket, describeHttpError, FORM_ERROR_MESSAGES, MESSAGES } from '../src/services/ticketService.js';
import { summarizeTicketResult, RESULT_TEXT } from '../src/components/propose/dialogs.js';
import { buildTicketCard, describeRoute } from '../src/components/tickets/ticketCard.js';
import { renderTodoTickets, renderMyTickets } from '../src/components/tickets/ticketTracking.js';
import { FILLED_LEAVE_VALUES, LEAVE_TYPE, EQUIPMENT_TYPE } from './helpers/draftFixtures.js';

// 模擬 GET /api/forms 整理後的目錄：請假為目前的 version 2（舊單是 version 1），設備申請允許轉單。
const FORM_TYPES = [
  { ...LEAVE_TYPE, computed: [{ key: 'minutes', label: '請假時數', display: 'hours_minutes' }], workflow: { transfer: false, not_requester: true } },
  { ...EQUIPMENT_TYPE, computed: [], workflow: { transfer: true, not_requester: true } },
];

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.sessionStorage;
/** 建立有效的前端登入狀態（假帳號、假憑證）。@returns {void} */
function setupSession() {
  const session = { user: { username: 'tina.test', userID: 'user-tina.test', department: { id: 'dept-it-test', name: '測試資訊部' } }, token: 'test-token', expiresAt: Date.now() + 60000 };
  globalThis.sessionStorage = {
    /** 讀取工作階段。@returns {string} 序列化登入資料。 */
    getItem() { return JSON.stringify(session); },
  };
}
/** 還原 fetch、儲存體與全域文件替身。@returns {void} */
function restore() { globalThis.fetch = originalFetch; globalThis.sessionStorage = originalStorage; delete globalThis.document; }
test.beforeEach(setupSession);
test.afterEach(restore);

/**
 * 驗證送單本文：套用需求類型帶 form（同時給 departmentId 時一併帶 department_id，供沒有固定部門的類型使用）、只有部門時帶 department_id、都沒有時與舊版相同；表單格式不符時不送出。
 * @returns {Promise<void>}
 */
async function submitBodies() {
  const bodies = [];
  /** 記錄本文並回 FORM 結果。@param {string} url 網址。@param {RequestInit} options 設定。@returns {Promise<Response>} 回應。 */
  async function fakeFetch(url, options) {
    bodies.push(JSON.parse(options.body));
    return Response.json({ ticket_id: 'TK-1', route: 'FORM', department: '測試人資部', basis: '依「請假申請」表單規則送達' });
  }
  globalThis.fetch = fakeFetch;
  const form = { id: 'leave', version: 1, fields: { leave_type: '事假', agent: 'kevin.test' } };
  await submitTicket({ subject: ' 請假 ', content: ' 內容 ', handlerId: 'u-hr-a', form, departmentId: 'dept-hr-test' });
  await submitTicket({ subject: '電腦很慢', content: '內容', handlerId: '', departmentId: 'dept-it-test' });
  await submitTicket({ subject: '電腦很慢', content: '內容', departmentId: '  ' });
  assert.deepEqual(bodies, [
    { subject: '請假', content: '內容', handler_id: 'u-hr-a', form, department_id: 'dept-hr-test' },
    { subject: '電腦很慢', content: '內容', handler_id: null, department_id: 'dept-it-test' },
    { subject: '電腦很慢', content: '內容', handler_id: null },
  ]);
  await assert.rejects(submitTicket({ subject: 'a', content: 'b', form: { id: 'leave', version: 0, fields: {} } }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(submitTicket({ subject: 'a', content: 'b', form: { id: 'leave', version: 1, fields: { a: 1 } } }), { code: 'INVALID_PAYLOAD' });
  assert.equal(bodies.length, 3);
}
test('送單本文帶 form 或 department_id', submitBodies);

/**
 * 驗證 409：有後端訊息時優先顯示（定義檔的檢查錯誤一律由後端附訊息）；沒有訊息時共用代碼使用固定提示、需求單狀態衝突顯示已簽核、
 * 其他代碼（前端不認得的定義檔錯誤代碼）顯示通用的規則不符提示。
 * @returns {void}
 */
function formErrors() {
  assert.equal(describeHttpError(409, { error: { code: 'LEAVE_OVERLAP', message: '這段時間已有請假單' } }).message, '這段時間已有請假單');
  assert.equal(describeHttpError(409, { error: { code: 'SOME_FUTURE_CHECK' } }).message, MESSAGES.formConflict);
  assert.equal(describeHttpError(409, { error: { code: 'TICKET_ALREADY_DECIDED' } }).message, MESSAGES.conflict);
  assert.equal(describeHttpError(409, { error: { code: 'FORM_TICKET_LOCKED' } }).message, FORM_ERROR_MESSAGES.FORM_TICKET_LOCKED);
  assert.equal(describeHttpError(409, { error: { code: 'FORM_VERSION_CHANGED', message: '範本已更新' } }).message, '範本已更新');
  assert.equal(describeHttpError(400, { error: { code: 'INVALID_PAYLOAD', message: '需求內容與表單資料不一致，請重新按「自動生成」確認' } }).message,
    '送出的內容不符合規定，請檢查後再試\n需求內容與表單資料不一致，請重新按「自動生成」確認');
}
test('表單需求單的錯誤提示', formErrors);

/**
 * 驗證送單回應：FORM 與 DEPARTMENT 可以帶處理人，結果視窗依 fromDraft 顯示「依 AI 對話確認部門」且不顯示判斷依據。
 * @returns {void}
 */
function responsesAndSummaries() {
  const form = normalizeTicketResponse({ ticket_id: 'TK-1', route: 'FORM', department: '測試人資部', handler: { name: ' hana.test ' }, basis: ' 依「請假申請」表單規則送達 ' });
  assert.deepEqual(form, { ticket_id: 'TK-1', route: 'FORM', department: '測試人資部', handler: { name: 'hana.test' }, basis: '依「請假申請」表單規則送達' });
  assert.deepEqual(summarizeTicketResult(form), { target: 'hana.test（測試人資部）', method: '依「請假申請」表單規則送達', note: '需求單已送到 hana.test 簽核', basis: '' });
  assert.deepEqual(summarizeTicketResult({ ticket_id: 'TK-2', route: 'FORM', department: '測試人資部' }),
    { target: '測試人資部', method: RESULT_TEXT.FORM.method, note: '需求單已送往「測試人資部」簽核', basis: '' });
  const draft = normalizeTicketResponse({ ticket_id: 'TK-3', route: 'DEPARTMENT', department: '測試資訊部', handler: { name: 'ivan.test' }, basis: '依 AI 對話確認送達' });
  assert.deepEqual(draft.handler, { name: 'ivan.test' });
  assert.deepEqual(summarizeTicketResult(draft, { fromDraft: true }), { target: 'ivan.test（測試資訊部）', method: '依 AI 對話確認部門', note: '需求單已送到 ivan.test 簽核', basis: '' });
  assert.deepEqual(summarizeTicketResult({ ticket_id: 'TK-4', route: 'DEPARTMENT', department: '測試資訊部', basis: '提到筆電' }, { fromDraft: false }),
    { target: '測試資訊部', method: RESULT_TEXT.DEPARTMENT.method, note: '需求單已送往「測試資訊部」簽核', basis: '提到筆電' });
  assert.deepEqual(normalizeTicketResponse({ ticket_id: 'TK-5', route: 'DEPARTMENT', department: 'd', handler: { id: 'x' } }), { ticket_id: 'TK-5', route: 'DEPARTMENT', department: 'd' });
}
test('FORM 與對話確認部門的送單結果', responsesAndSummaries);

/**
 * 建立一筆請假單記錄樣本（後端 JSON 形狀，已整理）。
 * @param {object} [overrides={}] 覆寫欄位。
 * @returns {object} 正規化的需求單。
 */
function leaveTicket(overrides = {}) {
  return normalizeStoredTicket({
    ticket_id: 'TK-L', created_at: '2026-11-01T01:00:00.000Z', subject: '我要請假', content: '[請假人]: tina.test', status: 'PENDING', route: 'FORM',
    department_id: 'dept-hr-test', department_name: '測試人資部', handler: null, requester: { user_id: 'user-tina.test', username: 'tina.test', department_name: '測試資訊部' },
    judgement: null, decision: null, history: [{ at: '2026-11-01T01:00:00.000Z', event: 'SUBMITTED', by_username: 'tina.test' }],
    form: { id: 'leave', version: 1, name: '請假申請', fields: { ...FILLED_LEAVE_VALUES, bad: 3 }, computed: { minutes: 420, year: 2026 } }, ...overrides,
  });
}

/**
 * 驗證需求單記錄：保留 FORM 與表單資料（只留文字欄位、文字名稱、數字或文字的計算結果與布林的 workflow，舊版本照樣保留自己的版本）、
 * 不保存欄位的單所記錄的 request_type（需含 id）、judgement.source 只接受 draft。
 * @returns {void}
 */
function storedTickets() {
  const ticket = leaveTicket();
  assert.equal(ticket.route, 'FORM');
  assert.deepEqual(ticket.form, { id: 'leave', version: 1, name: '請假申請', fields: { ...FILLED_LEAVE_VALUES }, labels: {}, computed: { minutes: 420, year: 2026 },
    workflow: { transfer: null, not_requester: null } });
  const generic = leaveTicket({ form: { id: 'future-test', fields: { a: 'x' }, labels: { a: ' 甲 ', b: 3 }, computed: [{ key: 'k', label: ' K ', value: 5 }, { key: 'bad' }],
    workflow: { transfer: true, not_requester: 'no' } } }).form;
  assert.deepEqual(generic, { id: 'future-test', version: null, name: '', fields: { a: 'x' }, labels: { a: '甲' }, computed: [{ key: 'k', label: 'K', text: '5' }],
    workflow: { transfer: true, not_requester: null } });
  assert.deepEqual(leaveTicket({ form: { id: 'leave', computed: { minutes: 420, nested: {} } } }).form.computed, { minutes: 420 });
  assert.equal(leaveTicket({ form: { name: '請假申請' } }).form, null, '沒有 id 的表單資料視為沒有');
  assert.equal(ticket.request_type, null, '沒有 request_type 時為 null');
  assert.deepEqual(leaveTicket({ route: 'DEPARTMENT', form: null, request_type: { id: ' general ', version: 1 } }).request_type, { id: 'general', version: 1 });
  assert.deepEqual(leaveTicket({ request_type: { id: 'general', version: '1' } }).request_type, { id: 'general', version: null });
  assert.equal(leaveTicket({ request_type: { version: 1 } }).request_type, null, '沒有 id 的需求類型視為沒有');
  const draft = leaveTicket({ route: 'DEPARTMENT', form: null, judgement: { source: 'draft', basis: '依 AI 對話確認送達', confidence_score: 90 } });
  assert.deepEqual(draft.judgement, { basis: '依 AI 對話確認送達', confidence_score: 90, source: 'draft' });
  assert.equal(leaveTicket({ judgement: { source: 'gemini', basis: 'x' } }).judgement.source, '');
  assert.equal(describeRoute(draft), '依 AI 對話確認部門');
  assert.equal(describeRoute({ ...draft, judgement: { source: '' } }), 'AI 依主題與內容判斷部門');
  assert.equal(describeRoute(ticket), '依表單規則送達');
}
test('請假單與對話確認部門的需求單記錄', storedTickets);

/**
 * 驗證舊版請假單（version 1、計算結果為物件）在目錄是 version 2 時仍以目前的欄位名稱與時數顯示；可簽核與取消，
 * 目錄規定不能轉單時不顯示轉單；目錄沒有載入時改以欄位代號顯示、route 為 FORM 的單預設也不能轉單。
 * @returns {Promise<void>}
 */
async function leaveCard() {
  globalThis.document = createFakeDocument();
  const options = { showRequester: true, tag: '待本部門簽核', onDecide: noop, onTransfer: noop, onCancel: noop, cancelRequiresComment: true,
    departments: [{ id: 'dept-it-test', name: '測試資訊部', handlers: [] }] };
  const card = buildTicketCard(leaveTicket(), { ...options, formTypes: FORM_TYPES });
  const table = card.querySelector('.form-table');
  assert.ok(table);
  assert.equal(table.querySelector('caption').textContent, '請假申請表單');
  const rows = table.querySelectorAll('tr').map(rowText);
  assert.deepEqual(rows, [
    ['請假人', 'tina.test'], ['假別', '事假'], ['請假起始時間', '2026-12-01（週二）09:30'], ['請假截止時間', '2026-12-01（週二）17:30'],
    ['代理人', 'kevin.test'], ['備註', '無'], ['請假時數', '7 小時'],
  ]);
  assert.equal(table.querySelectorAll('tr').at(-1).className, 'form-table-computed', '計算結果的列另外標示');
  assert.ok(card.querySelector('.ticket-main').querySelector('.form-table'), '表單欄位在左欄「申請內容」');
  assert.equal(card.querySelector('.ticket-content'), null, '帶 form 的單不重複顯示由欄位產生的需求內容文字');
  assert.ok(card.querySelector('.approve-button'));
  assert.equal(card.querySelector('.transfer-button'), null, '請假單不能轉出範本部門');
  assert.ok(card.textContent.includes('依表單規則送達'));
  const bare = buildTicketCard(leaveTicket(), options);
  assert.deepEqual(bare.querySelector('.form-table').querySelectorAll('tr').map(rowText)[0], ['applicant', 'tina.test'], '沒有目錄時以欄位代號顯示');
  assert.equal(bare.querySelector('.transfer-button'), null);
}
/**
 * 空的回呼替身。
 * @returns {Promise<void>}
 */
async function noop() {}
/**
 * 取出表格一列的標題與內容。
 * @param {object} row 表格列。
 * @returns {string[]} 標題與內容。
 */
function rowText(row) { return [row.querySelector('th').textContent, row.querySelector('td').textContent]; }
test('舊版請假單卡片以目錄名稱顯示欄位與時數', leaveCard);

/**
 * 驗證設備申請（模擬 equipment.json）卡片：欄位名稱與日期格式取自目錄、計算結果陣列直接顯示；目錄允許轉單時顯示轉單。
 * @returns {void}
 */
function equipmentCard() {
  globalThis.document = createFakeDocument();
  const ticket = leaveTicket({ department_id: 'dept-ga-test', department_name: '測試總務組', content: '[申請人]: tina.test',
    form: { id: 'equipment', version: 1, name: '設備申請', fields: { applicant: 'tina.test', item: '螢幕', quantity: '2', purpose: '雙螢幕', needed_by: '2026-11-20', location: '3F' },
      computed: [{ key: 'total', label: '測試總數', value: 2, text: '2 台' }] } });
  const card = buildTicketCard(ticket, { showRequester: true, onDecide: noop, onTransfer: noop, onCancel: noop, departments: [{ id: 'dept-it-test', name: '測試資訊部', handlers: [] }], formTypes: FORM_TYPES });
  assert.deepEqual(card.querySelector('.form-table').querySelectorAll('tr').map(rowText), [
    ['申請人', 'tina.test'], ['設備品項', '螢幕'], ['數量', '2'], ['用途說明', '雙螢幕'], ['需要日期', '2026-11-20（週五）'], ['送交地點', '3F'], ['測試總數', '2 台'],
  ]);
  assert.ok(card.querySelector('.transfer-button'), '目錄允許轉單');
}
test('設備申請卡片依目錄顯示並允許轉單', equipmentCard);

/**
 * 驗證待辦表單：送達本部門、但由目前登入者本人提出的請假單不顯示簽核與退回（後端會以 403 拒絕自己簽核），仍可取消並標示「我提出的」；
 * 同部門其他人提出的請假單照常顯示簽核；同一張單也列在申請表單的待簽核區，只能取消。
 * @returns {void}
 */
function ownLeaveNotDecidable() {
  const doc = createFakeDocument();
  globalThis.document = doc;
  /** 建立節點替身。@returns {object} 元素。 */
  function node() { return doc.createElement('div'); }
  const nodes = { listTodo: node(), listMinePending: node(), listMineDone: node(), empties: { todo: node(), minePending: node(), mineDone: node() },
    counts: { todo: node(), mine: node(), minePending: node(), mineDone: node() } };
  const own = leaveTicket({ ticket_id: 'TK-OWN', requester: { user_id: 'user-hana.test', username: 'hana.test', department_name: '測試人資部' } });
  const other = leaveTicket({ ticket_id: 'TK-OTHER' });
  const state = { mine: [own], department: { tickets: [own, other] }, departments: [] };
  renderTodoTickets(state, nodes, { onDecide: noop, onTransfer: noop, onCancel: noop }, { userID: 'user-hana.test' });
  renderMyTickets(state, nodes, { onCancel: noop, onResubmit: noop });
  const [ownCard, otherCard] = nodes.listTodo.children;
  assert.equal(nodes.listTodo.children.length, 2);
  assert.equal(ownCard.querySelector('.ticket-tag').textContent, '我提出的');
  assert.equal(nodes.listMinePending.children.length, 1, '本人的單也列在申請表單');
  assert.equal(nodes.listMinePending.children[0].querySelector('.approve-button'), null);
  assert.equal(ownCard.querySelector('.approve-button'), null, '自己的請假單不顯示簽核');
  assert.equal(ownCard.querySelector('.reject-button'), null, '自己的請假單不顯示退回');
  assert.ok(ownCard.querySelector('.cancel-button'), '仍可取消自己的請假單');
  assert.ok(otherCard.querySelector('.approve-button'), '同事的請假單可簽核');
}
test('自己提出的請假單在部門清單不顯示簽核', ownLeaveNotDecidable);
