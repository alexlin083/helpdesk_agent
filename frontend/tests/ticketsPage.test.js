import { PAGE_URLS } from '../src/pageUrls.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createFakeWindow, pageIds, fakeAuth } from './helpers/fakeDom.js';
import { initTicketsPage } from '../src/pages/tickets.js';
import { buildTicketCard } from '../src/components/tickets/ticketCard.js';
import { describeTarget, formatTime } from '../src/utils/ticketFormatters.js';
import { TICKETS_TEXT } from '../src/components/tickets/ticketText.js';
import { TicketServiceError, MESSAGES, normalizeStoredTicket, DRAFT_KEY } from '../src/services/ticketService.js';

const user = { username: 'amy.chen', userID: 'user-amy.chen', department: { id: 'dept-it-1', name: '資訊管理一部' } };
const departmentList = [
  { id: 'dept-it-1', name: '資訊管理一部', type: '', duty: '', business: [], handlers: [{ id: 'h-1', name: 'racky.huang' }] },
  { id: 'dept-it-2', name: '資訊管理二部', type: '', duty: '', business: [], handlers: [{ id: 'h-2', name: 'cindy.wang' }] },
  { id: 'dept-hr-1', name: '人力資源部', type: '', duty: '', business: [], handlers: [] },
];

/**
 * 建立一筆正規化的需求單樣本（預設由 erp.user 提出、送達資訊管理一部的 racky.huang）。
 * @param {object} [overrides={}] 覆寫欄位。
 * @returns {object} 需求單。
 */
function sampleTicket(overrides = {}) {
  return normalizeStoredTicket({
    ticket_id: 'TK-1', created_at: '2026-10-23T01:00:00.000Z', updated_at: '2026-10-23T01:00:00.000Z', subject: '申請 VPN', content: '新人需要 VPN',
    status: 'PENDING', route: 'HANDLER', department_id: 'dept-it-1', department_name: '資訊管理一部', handler: { name: 'racky.huang' },
    requester: { username: 'erp.user', department_name: '資訊管理二部' }, judgement: null, decision: null,
    history: [{ at: '2026-10-23T01:00:00.000Z', event: 'SUBMITTED', by_username: 'erp.user' }], ...overrides,
  });
}

/**
 * 建立一筆由登入者 amy.chen 提出、送到資訊管理二部的需求單樣本。
 * @param {object} [overrides={}] 覆寫欄位。
 * @returns {object} 需求單。
 */
function mineTicket(overrides = {}) {
  return sampleTicket({ ticket_id: 'TK-M', department_id: 'dept-it-2', department_name: '資訊管理二部', handler: { name: 'cindy.wang' },
    requester: { username: 'amy.chen', department_name: '資訊管理一部' }, history: [{ at: '2026-10-23T01:00:00.000Z', event: 'SUBMITTED', by_username: 'amy.chen' }], ...overrides });
}

/**
 * 依規格建立元素並掛到父節點。
 * @param {object} doc 文件替身。
 * @param {object} parent 父節點。
 * @param {string} tag 標籤。
 * @param {string} id 元素 id。
 * @param {object} [props={}] 其他屬性。
 * @returns {object} 元素。
 */
function add(doc, parent, tag, id, props = {}) {
  const node = doc.createElement(tag);
  if (id) node.setAttribute('id', id);
  Object.assign(node, props);
  parent.append(node);
  return node;
}

/**
 * 建立狀態追蹤頁需要的節點樹（與 tickets.html 的 id 對應）。
 * @param {object} doc 文件替身。
 * @returns {object} 常用節點。
 */
function buildTicketsDom(doc) {
  const body = doc.body;
  body.hidden = true;
  const nodes = {};
  for (const id of ['account-avatar', 'account-name', 'account-id', 'account-department']) nodes[id] = add(doc, body, 'span', id);
  nodes.logout = add(doc, body, 'button', 'logout-button');
  nodes.refresh = add(doc, body, 'button', 'refresh-button');
  nodes.tabTracking = add(doc, body, 'button', 'tab-tracking');
  nodes.tabCompleted = add(doc, body, 'button', 'tab-completed');
  nodes.countTracking = add(doc, nodes.tabTracking, 'span', 'count-tracking');
  nodes.panelTracking = add(doc, body, 'section', 'panel-tracking');
  nodes.noticeTracking = add(doc, nodes.panelTracking, 'p', 'notice-tracking', { hidden: true });
  nodes.countPending = add(doc, nodes.panelTracking, 'span', 'count-pending');
  nodes.pendingHint = add(doc, nodes.panelTracking, 'p', 'pending-hint');
  nodes.emptyPending = add(doc, nodes.panelTracking, 'p', 'empty-pending', { hidden: true });
  nodes.listPending = add(doc, nodes.panelTracking, 'div', 'list-pending');
  nodes.countRejected = add(doc, nodes.panelTracking, 'span', 'count-rejected');
  nodes.emptyRejected = add(doc, nodes.panelTracking, 'p', 'empty-rejected', { hidden: true });
  nodes.listRejected = add(doc, nodes.panelTracking, 'div', 'list-rejected');
  nodes.panelCompleted = add(doc, body, 'section', 'panel-completed', { hidden: true });
  nodes.completedTitle = add(doc, nodes.panelCompleted, 'p', 'completed-title');
  nodes.filterForm = add(doc, nodes.panelCompleted, 'form', 'filter-form');
  nodes.filterKeyword = add(doc, nodes.filterForm, 'input', 'filter-q');
  nodes.filterStatus = add(doc, nodes.filterForm, 'select', 'filter-status');
  nodes.filterFrom = add(doc, nodes.filterForm, 'input', 'filter-from');
  nodes.filterTo = add(doc, nodes.filterForm, 'input', 'filter-to');
  nodes.quick = {};
  for (const range of ['today', '7', '30', 'all']) {
    const button = add(doc, nodes.filterForm, 'button', '', { className: 'chip-button' });
    button.setAttribute('data-range', range);
    nodes.quick[range] = button;
  }
  nodes.filterReset = add(doc, nodes.filterForm, 'button', 'filter-reset');
  nodes.filterSubmit = add(doc, nodes.filterForm, 'button', 'filter-submit');
  nodes.summary = add(doc, nodes.panelCompleted, 'p', 'completed-summary');
  nodes.noticeCompleted = add(doc, nodes.panelCompleted, 'p', 'notice-completed', { hidden: true });
  nodes.emptyCompleted = add(doc, nodes.panelCompleted, 'p', 'empty-completed', { hidden: true });
  nodes.listCompleted = add(doc, nodes.panelCompleted, 'div', 'list-completed');
  return nodes;
}

/**
 * 建立已登入的頁面環境。
 * @param {object} [services={}] 服務替身。
 * @param {object} [win] 視窗替身。
 * @returns {object} doc、win、nodes、auth 與頁面控制器。
 */
function mountPage(services = {}, win = createFakeWindow()) {
  const doc = createFakeDocument();
  const nodes = buildTicketsDom(doc);
  const auth = fakeAuth(user);
  globalThis.document = doc;
  const defaults = {
    /** 預設沒有我的需求單。@returns {Promise<object[]>} 清單。 */
    async loadMyTickets() { return []; },
    /** 預設沒有部門需求單。@returns {Promise<object>} 清單。 */
    async loadDepartmentTickets() { return { department: user.department, tickets: [] }; },
    /** 預設沒有已完成。@returns {Promise<object>} 清單。 */
    async loadCompletedTickets() { return { department: user.department, total: 0, limit: 100, tickets: [] }; },
    /** 預設部門名單。@returns {Promise<object[]>} 部門。 */
    async loadDepartments() { return departmentList; },
    /** 預設需求類型目錄為空（卡片改用記錄本身的資料）。@returns {Promise<object[]>} 需求類型。 */
    async loadRequestTypes() { return []; },
  };
  const page = initTicketsPage(doc, win, { auth, ...defaults, ...services });
  return { doc, win, nodes, auth, page };
}
/** 清除全域文件替身。@returns {void} */
function cleanup() { delete globalThis.document; }
test.afterEach(cleanup);

/**
 * 驗證 tickets.html 具備頁面腳本依賴的所有節點 id。
 * @returns {void}
 */
function pageStructure() {
  const ids = pageIds(new URL('../pages/tickets/tickets.html', import.meta.url));
  for (const id of ['account-avatar', 'account-name', 'account-id', 'account-department', 'logout-button', 'refresh-button', 'tab-tracking', 'tab-completed', 'count-tracking',
    'panel-tracking', 'notice-tracking', 'count-pending', 'pending-hint', 'empty-pending', 'list-pending', 'count-rejected', 'empty-rejected', 'list-rejected',
    'panel-completed', 'completed-title', 'filter-form', 'filter-q', 'filter-status', 'filter-from', 'filter-to', 'filter-reset', 'filter-submit',
    'completed-summary', 'notice-completed', 'empty-completed', 'list-completed']) {
    assert.ok(ids.has(id), `tickets.html 缺少 #${id}`);
  }
  assert.ok(pageIds(new URL('../pages/propose/propose.html', import.meta.url)).has('account-department'));
}
test('狀態追蹤頁具備腳本需要的節點', pageStructure);

/**
 * 驗證卡片的摘要、身分標籤、欄位、歷程、簽核表單、轉單選單與重新提出按鈕的顯示規則。
 * @returns {Promise<void>}
 */
async function cardRendering() {
  globalThis.document = createFakeDocument();
  const pending = buildTicketCard(sampleTicket(), { showRequester: true, tag: '待本部門簽核', onDecide: async () => {}, onTransfer: async () => {}, departments: departmentList });
  assert.equal(pending.querySelector('.ticket-subject').textContent, '申請 VPN');
  assert.equal(pending.querySelector('.status').textContent, '待簽核');
  assert.equal(pending.querySelector('.ticket-tag').textContent, '待本部門簽核');
  assert.ok(pending.querySelector('.ticket-meta').textContent.includes('送達：racky.huang（資訊管理一部）'));
  assert.ok(pending.querySelector('.ticket-meta').textContent.includes('提單人：erp.user'));
  assert.ok(pending.querySelector('.decision-form'));
  assert.equal(pending.querySelector('.resubmit-button'), null);
  assert.equal(pending.querySelector('.ticket-main').querySelector('.ticket-content').textContent, '新人需要 VPN', '沒有 form 的單在左欄顯示需求內容文字');
  assert.deepEqual(pending.querySelector('.ticket-side').querySelectorAll('.ticket-row').map((row) => row.querySelector('dt').textContent), ['方式', '提單人'],
    '右欄「處理資訊」只放方式與提單人，需求內容不再重複列在這裡');
  assert.ok(pending.querySelector('.ticket-side').querySelector('.ticket-history'), '歷程在右欄');
  const departmentSelect = pending.querySelector('.transfer-department');
  assert.deepEqual(departmentSelect.children.map((option) => option.value), ['', 'dept-it-2', 'dept-hr-1'], '不含目前部門');
  assert.equal(pending.querySelector('.transfer-button').disabled, true, '未選部門不能轉');
  departmentSelect.value = 'dept-it-2';
  await departmentSelect.dispatch('change');
  const handlerSelect = pending.querySelector('.transfer-handler');
  assert.deepEqual(handlerSelect.children.map((option) => option.textContent), [TICKETS_TEXT.noHandler, 'cindy.wang']);
  assert.equal(pending.querySelector('.transfer-button').disabled, false);
  departmentSelect.value = 'dept-hr-1';
  await departmentSelect.dispatch('change');
  assert.equal(handlerSelect.disabled, true, '沒有處理人的部門只能不指定');
  const noTargets = buildTicketCard(sampleTicket(), { onDecide: async () => {}, onTransfer: async () => {}, departments: null });
  assert.equal(noTargets.querySelector('.transfer-department').disabled, true);
  assert.equal(noTargets.querySelector('.transfer-department').children[0].textContent, TICKETS_TEXT.transferUnavailable);
  assert.equal(noTargets.querySelector('.ticket-tag'), null, '沒有標籤時不顯示');
  const approved = buildTicketCard(sampleTicket({ status: 'APPROVED', route: 'DEPARTMENT', handler: null, judgement: { basis: '提到 VPN', confidence_score: 90 },
    decision: { by_username: 'amy.chen', at: '2026-10-23T02:00:00.000Z', comment: '已安排' },
    history: [{ at: '2026-10-23T01:00:00.000Z', event: 'SUBMITTED', by_username: 'erp.user' },
      { at: '2026-10-23T01:30:00.000Z', event: 'TRANSFERRED', by_username: 'cindy.wang', from_department_name: '資訊管理二部', to_department_name: '資訊管理一部' },
      { at: '2026-10-23T02:00:00.000Z', event: 'APPROVED', by_username: 'amy.chen', comment: '已安排' }] }));
  assert.equal(approved.querySelector('.status').textContent, '已簽核');
  assert.equal(approved.querySelector('.decision-form'), null);
  const rows = approved.querySelectorAll('.ticket-row').map((row) => row.textContent);
  assert.ok(rows.some((row) => row.includes('判斷依據') && row.includes('提到 VPN')));
  assert.ok(rows.some((row) => row.includes('簽核') && row.includes('amy.chen') && row.includes('備註：已安排')));
  assert.ok(rows.some((row) => row.includes('轉單') && row.includes('資訊管理二部 → 資訊管理一部') && row.includes('cindy.wang')));
  const historyItems = approved.querySelector('.ticket-history').querySelectorAll('li');
  assert.equal(historyItems.length, 3);
  assert.ok(historyItems[1].textContent.includes('轉單・cindy.wang：資訊管理二部 → 資訊管理一部'));
  const resubmitted = [];
  const rejected = buildTicketCard(mineTicket({ status: 'REJECTED', decision: { by_username: 'cindy.wang', at: '2026-10-23T02:00:00.000Z', comment: '資料不足' } }),
    { onResubmit: (ticket) => resubmitted.push(ticket.ticket_id) });
  assert.ok(rejected.querySelectorAll('.ticket-row').map((row) => row.textContent).some((row) => row.includes('退回') && row.includes('備註：資料不足')));
  assert.equal(rejected.querySelector('.decision-form'), null, '已退回的單沒有簽核表單');
  await rejected.querySelector('.resubmit-button').click();
  assert.deepEqual(resubmitted, ['TK-M']);
  assert.equal(buildTicketCard(mineTicket({ status: 'REJECTED' })).querySelector('.resubmit-button'), null, '沒有回呼時不顯示重新提出');
  assert.equal(describeTarget(sampleTicket({ handler: null })), '資訊管理一部');
  assert.equal(formatTime('not-a-date'), 'not-a-date');
  assert.match(formatTime('2026-10-23T01:00:00.000Z'), /2026\/10\/23/);
}
test('需求單卡片的摘要、欄位、簽核表單、轉單選單與重新提出', cardRendering);

/**
 * 驗證表單追蹤的分區：待簽核先列部門的單再列我的單（同一張只列一次並保留簽核操作），已退回只列我被退回的單；已簽核與已取消的單不出現；計數、空狀態、分頁切換與重新整理。
 * @returns {Promise<void>}
 */
async function trackingSections() {
  const mineList = [
    mineTicket({ ticket_id: 'TK-A', status: 'APPROVED', decision: { by_username: 'cindy.wang', at: '2026-10-23T02:00:00.000Z', comment: '' } }),
    mineTicket({ ticket_id: 'TK-B' }),
    mineTicket({ ticket_id: 'TK-R', status: 'REJECTED', decision: { by_username: 'cindy.wang', at: '2026-10-23T02:00:00.000Z', comment: '資料不足' } }),
    mineTicket({ ticket_id: 'TK-S', department_id: 'dept-it-1', department_name: '資訊管理一部', handler: { name: 'racky.huang' } }),
    mineTicket({ ticket_id: 'TK-X', status: 'CANCELLED', decision: { by_username: 'amy.chen', at: '2026-10-23T02:00:00.000Z', comment: '', cancelled_by: 'REQUESTER' } }),
  ];
  const departmentTickets = { department: user.department, tickets: [
    sampleTicket({ ticket_id: 'TK-C' }),
    sampleTicket({ ticket_id: 'TK-D', status: 'REJECTED' }),
    mineTicket({ ticket_id: 'TK-S', department_id: 'dept-it-1', department_name: '資訊管理一部', handler: { name: 'racky.huang' } }),
  ] };
  let loads = 0;
  let completedLoads = 0;
  const { doc, nodes, page } = mountPage({
    /** 回傳我的需求單並計數。@returns {Promise<object[]>} 清單。 */
    async loadMyTickets() { loads += 1; return [...mineList]; },
    /** 回傳部門需求單。@returns {Promise<object>} 清單。 */
    async loadDepartmentTickets() { return { department: user.department, tickets: [...departmentTickets.tickets] }; },
    /** 計數已完成查詢。@returns {Promise<object>} 清單。 */
    async loadCompletedTickets() { completedLoads += 1; return { department: user.department, total: 0, limit: 100, tickets: [] }; },
  });
  await page.ready;
  assert.equal(doc.body.hidden, false);
  assert.equal(doc.querySelector('#account-department').textContent, '資訊管理一部');
  assert.ok(nodes.pendingHint.textContent.includes('資訊管理一部'));
  assert.ok(nodes.completedTitle.textContent.includes('最新 100 筆'));
  const pendingCards = nodes.listPending.children;
  assert.deepEqual(pendingCards.map((card) => card.getAttribute('data-ticket-id')), ['TK-C', 'TK-S', 'TK-B'], '部門的待簽核在前，我送出的在後，重複的只列一次');
  assert.deepEqual(pendingCards.map((card) => card.querySelector('.ticket-tag').textContent), [TICKETS_TEXT.tagDepartment, TICKETS_TEXT.tagDepartment, TICKETS_TEXT.tagMine]);
  assert.equal(pendingCards[1].querySelector('.approve-button'), null, '自己提出的單送到自己部門時不顯示簽核，需由同部門其他成員簽核');
  assert.equal(pendingCards[1].querySelector('.cancel-button').textContent, TICKETS_TEXT.cancel, '自己的單送到自己部門時是提單人取消');
  assert.equal(pendingCards[0].querySelector('.cancel-button').textContent, TICKETS_TEXT.cancelForRequester, '別人的單是替提單人取消');
  assert.equal(pendingCards[2].querySelector('.approve-button'), null, '我送出的單沒有簽核按鈕');
  assert.equal(pendingCards[2].querySelector('.cancel-button').textContent, TICKETS_TEXT.cancel);
  assert.equal(nodes.countPending.textContent, '3');
  assert.deepEqual(nodes.listRejected.children.map((card) => card.getAttribute('data-ticket-id')), ['TK-R'], '已退回只列我被退回的單');
  assert.ok(nodes.listRejected.children[0].querySelector('.resubmit-button'));
  assert.equal(nodes.countRejected.textContent, '1');
  assert.equal(nodes.countTracking.textContent, '4', '分頁計數是兩區總和');
  assert.equal(nodes.emptyPending.hidden, true);
  assert.equal(nodes.emptyRejected.hidden, true);
  assert.equal(completedLoads, 0, '已完成分頁在切換前不查詢');
  assert.equal(nodes.tabTracking.getAttribute('aria-selected'), 'true');
  await nodes.tabCompleted.click();
  await page.state.completedRequest;
  assert.equal(nodes.panelTracking.hidden, true);
  assert.equal(nodes.panelCompleted.hidden, false);
  assert.equal(completedLoads, 1);
  await nodes.tabTracking.click();
  assert.equal(nodes.panelTracking.hidden, false);
  mineList.length = 0;
  departmentTickets.tickets.length = 0;
  await nodes.refresh.click();
  assert.equal(loads, 2);
  assert.equal(completedLoads, 2, '看過已完成後重新整理也會一起查');
  assert.equal(nodes.listPending.children.length, 0);
  assert.equal(nodes.emptyPending.hidden, false);
  assert.equal(nodes.emptyRejected.hidden, false);
  assert.equal(nodes.countTracking.textContent, '');
  assert.equal(nodes.countPending.textContent, '');
  const win = createFakeWindow();
  win.location.hash = '#completed';
  const deep = mountPage({}, win);
  await deep.page.ready;
  assert.equal(deep.nodes.tabCompleted.getAttribute('aria-selected'), 'true');
}
test('表單追蹤的待簽核與已退回分區、計數、分頁切換與重新整理', trackingSections);

/**
 * 驗證已完成分頁：篩選條件送出、常用區間、清除條件、摘要與空狀態、日期順序檢查，以及我提出的單帶標籤。
 * @returns {Promise<void>}
 */
async function completedTab() {
  const received = [];
  const { nodes, page } = mountPage({
    /** 記錄條件並回傳結果。@param {object} filters 條件。@returns {Promise<object>} 清單。 */
    async loadCompletedTickets(filters) {
      received.push(filters);
      const tickets = filters.status === 'REJECTED' ? [] : [
        sampleTicket({ ticket_id: 'TK-Z', status: 'APPROVED', decision: { by_username: 'amy.chen', at: '2026-10-23T02:00:00.000Z', comment: '' } }),
        mineTicket({ ticket_id: 'TK-Y', status: 'APPROVED', decision: { by_username: 'cindy.wang', at: '2026-10-23T02:00:00.000Z', comment: '' } }),
      ];
      return { department: user.department, total: tickets.length ? 150 : 0, limit: 100, tickets };
    },
  });
  await page.ready;
  await nodes.tabCompleted.click();
  await page.state.completedRequest;
  assert.deepEqual(received.at(-1), { status: '', q: '', from: '', to: '' });
  assert.equal(nodes.listCompleted.children.length, 2);
  assert.equal(nodes.summary.textContent, '符合條件 150 筆，顯示最新 2 筆（上限 100 筆）');
  assert.equal(nodes.listCompleted.children[0].querySelector('.decision-form'), null, '已完成的卡片沒有簽核表單');
  assert.equal(nodes.listCompleted.children[0].querySelector('.ticket-tag'), null, '部門的紀錄沒有標籤');
  assert.equal(nodes.listCompleted.children[1].querySelector('.ticket-tag').textContent, TICKETS_TEXT.tagMine, '我提出的單帶標籤');
  nodes.filterKeyword.value = ' VPN ';
  nodes.filterStatus.value = 'REJECTED';
  await nodes.filterForm.dispatch('submit');
  assert.deepEqual(received.at(-1), { status: 'REJECTED', q: ' VPN ', from: '', to: '' });
  assert.equal(nodes.listCompleted.children.length, 0);
  assert.equal(nodes.emptyCompleted.hidden, false);
  assert.equal(nodes.summary.textContent, '符合條件 0 筆');
  await nodes.quick['7'].click();
  const last = received.at(-1);
  assert.equal(last.status, 'REJECTED', '常用區間保留其他條件');
  assert.match(last.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(last.to, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(last.from <= last.to);
  await nodes.filterReset.click();
  assert.deepEqual(received.at(-1), { status: '', q: '', from: '', to: '' });
  assert.equal(nodes.filterKeyword.value, '');
  nodes.filterFrom.value = '2026-10-10';
  nodes.filterTo.value = '2026-10-01';
  const before = received.length;
  await nodes.filterForm.dispatch('submit');
  assert.equal(received.length, before, '日期順序錯誤不送出');
  assert.equal(nodes.noticeCompleted.textContent, '起始日期不可晚於結束日期');
}
test('已完成分頁的篩選、常用區間、摘要與標籤', completedTab);

/**
 * 驗證簽核、退回與轉單：呼叫服務、成功後重新載入並顯示提示；備註過長與一般服務錯誤顯示在卡片內；
 * 409 已簽核過與 403 已無權限（例如同事已把單轉走）時改在表單追蹤上方顯示提示並重新整理清單（原卡片被新卡片取代）。
 * @param {import('node:test').TestContext} context mock 管理器。
 * @returns {Promise<void>}
 */
async function decisionsAndTransfers(context) {
  const tickets = [sampleTicket({ ticket_id: 'TK-P' })];
  const calls = [];
  let departmentLoads = 0;
  const { nodes, page, win, auth } = mountPage({
    /** 回傳目前的部門清單並計數。@returns {Promise<object>} 清單。 */
    async loadDepartmentTickets() { departmentLoads += 1; return { department: user.department, tickets: [...tickets] }; },
    /** 記錄簽核並更新狀態。@param {string} id 單號。@param {string} action 動作。@param {string} comment 備註。@returns {Promise<object>} 結果。 */
    async decideTicket(id, action, comment) {
      calls.push(['decide', id, action, comment]);
      if (comment === 'boom') throw new TicketServiceError('這張需求單已經簽核過，請重新整理清單', { status: 409, code: 'TICKET_ALREADY_DECIDED' });
      if (comment === 'crash') throw new Error('bug');
      tickets[0] = sampleTicket({ ticket_id: 'TK-P', status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED' });
      return tickets[0];
    },
    /** 記錄轉單並移出清單。@param {string} id 單號。@param {string} department 目標部門。@param {string} handler 處理人。@param {string} comment 備註。@returns {Promise<object>} 結果。 */
    async transferTicket(id, department, handler, comment) {
      calls.push(['transfer', id, department, handler, comment]);
      if (comment === 'forbidden') throw new TicketServiceError('只有送達部門的成員可以轉這張需求單', { status: 403, code: 'FORBIDDEN' });
      tickets.length = 0;
      return sampleTicket({ ticket_id: 'TK-P', department_id: department });
    },
  });
  await page.ready;
  let card = nodes.listPending.children[0];
  let comment = card.querySelector('textarea');
  comment.value = 'a'.repeat(201);
  await card.querySelector('.approve-button').click();
  assert.match(card.querySelector('.decision-error').textContent, /備註最多 200 字/);
  assert.equal(calls.length, 0);
  comment.value = 'boom';
  const loadsBefore = departmentLoads;
  await card.querySelector('.approve-button').click();
  assert.equal(nodes.noticeTracking.textContent, '這張需求單已經簽核過，請重新整理清單', '409 的提示顯示在表單追蹤上方');
  assert.equal(nodes.noticeTracking.hidden, false);
  assert.equal(departmentLoads, loadsBefore + 1, '409 後重新整理清單');
  assert.notEqual(nodes.listPending.children[0], card, '重新繪製取代原卡片');
  card = nodes.listPending.children[0];
  comment = card.querySelector('textarea');
  assert.equal(card.querySelector('.approve-button').disabled, false);
  const errors = context.mock.method(console, 'error', () => {});
  comment.value = 'crash';
  await card.querySelector('.reject-button').click();
  assert.equal(card.querySelector('.decision-error').textContent, TICKETS_TEXT.unexpected);
  assert.equal(errors.mock.callCount(), 1);
  comment.value = '';
  await card.querySelector('.transfer-button').click();
  assert.equal(card.querySelector('.decision-error').textContent, TICKETS_TEXT.chooseDepartment, '未選部門不送出');
  assert.equal(calls.filter(([kind]) => kind === 'transfer').length, 0);
  card.querySelector('.transfer-department').value = 'dept-it-2';
  await card.querySelector('.transfer-department').dispatch('change');
  card.querySelector('.transfer-handler').value = 'h-2';
  comment.value = 'forbidden';
  const beforeForbidden = departmentLoads;
  await card.querySelector('.transfer-button').click();
  assert.equal(nodes.noticeTracking.textContent, '只有送達部門的成員可以轉這張需求單', '403（例如同事已轉走）的提示顯示在表單追蹤上方');
  assert.equal(departmentLoads, beforeForbidden + 1, '403 後重新整理清單');
  assert.notEqual(nodes.listPending.children[0], card, '403 後以新卡片取代過期的卡片');
  card = nodes.listPending.children[0];
  comment = card.querySelector('textarea');
  assert.equal(card.querySelector('.decision-error').textContent, '', '過期錯誤不留在卡片內');
  card.querySelector('.transfer-department').value = 'dept-it-2';
  await card.querySelector('.transfer-department').dispatch('change');
  card.querySelector('.transfer-handler').value = 'h-2';
  comment.value = ' AI 判斷錯誤 ';
  await card.querySelector('.transfer-button').click();
  assert.deepEqual(calls.at(-1), ['transfer', 'TK-P', 'dept-it-2', 'h-2', ' AI 判斷錯誤 ']);
  assert.equal(nodes.noticeTracking.textContent, TICKETS_TEXT.transferred);
  assert.equal(nodes.listPending.children.length, 0, '轉出後從待簽核消失');
  assert.equal(nodes.emptyPending.hidden, false);
  tickets.push(sampleTicket({ ticket_id: 'TK-Q' }));
  await nodes.refresh.click();
  const next = nodes.listPending.children[0];
  next.querySelector('textarea').value = ' 已安排 ';
  await next.querySelector('.approve-button').click();
  assert.deepEqual(calls.at(-1), ['decide', 'TK-Q', 'APPROVE', ' 已安排 ']);
  assert.equal(nodes.noticeTracking.textContent, TICKETS_TEXT.decided);
  assert.equal(nodes.listPending.children.length, 0, '簽核後不再出現在待簽核');
  assert.deepEqual(win.redirects, []);
  assert.deepEqual(auth.calls, []);
}
test('簽核、退回與轉單的呼叫、錯誤提示與清單更新', decisionsAndTransfers);

/**
 * 驗證清單載入失敗的提示（另一份清單仍顯示）、部門名單失敗時轉單停用、401 回登入頁，以及未登入不初始化。
 * @param {import('node:test').TestContext} context mock 管理器。
 * @returns {Promise<void>}
 */
async function loadFailures(context) {
  const failed = mountPage({
    /** 模擬逾時。@returns {Promise<never>} @throws {TicketServiceError} 逾時。 */
    async loadMyTickets() { throw new TicketServiceError(MESSAGES.listTimeout, { code: 'TIMEOUT' }); },
    /** 模擬部門清單成功但部門名單失敗。@returns {Promise<object>} 清單。 */
    async loadDepartmentTickets() { return { department: user.department, tickets: [sampleTicket()] }; },
    /** 模擬名單失敗。@returns {Promise<never>} @throws {TicketServiceError} 404。 */
    async loadDepartments() { throw new TicketServiceError(MESSAGES.notFound, { status: 404, code: 'NOT_FOUND' }); },
  });
  await failed.page.ready;
  assert.equal(failed.nodes.noticeTracking.textContent, MESSAGES.listTimeout);
  assert.equal(failed.nodes.listPending.children.length, 1, '我的需求單失敗時部門的單仍顯示');
  assert.equal(failed.nodes.listPending.children[0].querySelector('.transfer-department').disabled, true, '名單失敗時轉單停用');
  assert.equal(failed.nodes.listPending.children[0].querySelector('.approve-button').disabled, false, '仍可簽核');
  cleanup();
  const errors = context.mock.method(console, 'error', () => {});
  const crashed = mountPage({ loadMyTickets: async () => { throw new Error('bug'); } });
  await crashed.page.ready;
  assert.equal(crashed.nodes.noticeTracking.textContent, TICKETS_TEXT.unexpected);
  assert.equal(errors.mock.callCount(), 1);
  cleanup();
  const expired = mountPage({ loadDepartmentTickets: async () => { throw new TicketServiceError(MESSAGES.loginRequired, { status: 401, code: 'UNAUTHORIZED' }); } });
  await expired.page.ready;
  assert.deepEqual(expired.win.redirects, [PAGE_URLS.login]);
  assert.deepEqual(expired.auth.calls, ['logout']);
  cleanup();
  const doc = createFakeDocument();
  const win = createFakeWindow();
  buildTicketsDom(doc);
  assert.equal(initTicketsPage(doc, win, { auth: fakeAuth(null) }), null);
  assert.deepEqual(win.redirects, [PAGE_URLS.login]);
}
test('清單載入失敗的提示、轉單停用與登入守門', loadFailures);

/**
 * 驗證簽核、退回、轉單與取消遇到登入失效（後端 401 或本機憑證過期）時，清除登入狀態並導回登入頁，
 * 不在卡片內只顯示錯誤文字。
 * @returns {Promise<void>}
 */
async function actionsRedirectOnExpiredLogin() {
  /** 模擬後端回 401。@returns {Promise<never>} @throws {TicketServiceError} 401。 */
  async function expired() { throw new TicketServiceError(MESSAGES.loginRequired, { status: 401, code: 'UNAUTHORIZED' }); }
  /** 模擬本機憑證已過期、未送出請求。@returns {Promise<never>} @throws {TicketServiceError} LOGIN_REQUIRED。 */
  async function localExpired() { throw new TicketServiceError(MESSAGES.loginRequired, { status: 401, code: 'LOGIN_REQUIRED' }); }
  for (const [button, prepare] of [['.approve-button', null], ['.reject-button', null], ['.transfer-button', 'transfer'], ['.approve-button', 'local']]) {
    const services = {
      /** 送達本部門的一張待簽核單。@returns {Promise<object>} 清單。 */
      async loadDepartmentTickets() { return { department: user.department, tickets: [sampleTicket({ ticket_id: 'TK-P' })] }; },
      decideTicket: prepare === 'local' ? localExpired : expired,
      transferTicket: expired,
    };
    const { page, nodes, win, auth } = mountPage(services);
    await page.ready;
    const card = nodes.listPending.children[0];
    if (prepare === 'transfer') {
      card.querySelector('.transfer-department').value = 'dept-it-2';
      await card.querySelector('.transfer-department').dispatch('change');
    }
    await card.querySelector(button).click();
    assert.deepEqual(win.redirects, [PAGE_URLS.login], `${button} 遇到登入失效導回登入頁`);
    assert.deepEqual(auth.calls, ['logout']);
    assert.equal(card.querySelector('.decision-error').textContent, '', '不只在卡片顯示錯誤');
    cleanup();
  }
  const { page, nodes, win, auth } = mountPage({
    /** 我送出、仍在等待的一張單。@returns {Promise<object[]>} 清單。 */
    async loadMyTickets() { return [sampleTicket({ ticket_id: 'TK-M', requester: { user_id: user.userID, username: user.username, department_id: 'dept-x', department_name: '測試部' } })]; },
    /** 沒有送達本部門的單。@returns {Promise<object>} 空清單。 */
    async loadDepartmentTickets() { return { department: user.department, tickets: [] }; },
    cancelTicket: expired,
  });
  await page.ready;
  await nodes.listPending.children[0].querySelector('.cancel-button').click();
  assert.deepEqual(win.redirects, [PAGE_URLS.login], '取消遇到登入失效導回登入頁');
  assert.deepEqual(auth.calls, ['logout']);
  cleanup();
}
test('簽核、退回、轉單與取消遇到登入失效時導回登入頁', actionsRedirectOnExpiredLogin);

/**
 * 驗證取消：提單人在待簽核區可取消自己的單（原因選填）；部門替提單人取消必須填原因；取消後從待簽核消失。
 * @returns {Promise<void>}
 */
async function cancellations() {
  const calls = [];
  const mineList = [mineTicket({ ticket_id: 'TK-M' })];
  const pendingList = [sampleTicket({ ticket_id: 'TK-D' })];
  const { nodes, page } = mountPage({
    /** 回傳我的需求單。@returns {Promise<object[]>} 清單。 */
    async loadMyTickets() { return [...mineList]; },
    /** 回傳部門待簽核。@returns {Promise<object>} 清單。 */
    async loadDepartmentTickets() { return { department: user.department, tickets: [...pendingList] }; },
    /** 記錄取消並更新清單。@param {string} id 單號。@param {string} comment 原因。@returns {Promise<object>} 結果。 */
    async cancelTicket(id, comment) {
      calls.push([id, comment]);
      if (comment === 'boom') throw new TicketServiceError('這張需求單已經取消', { status: 409, code: 'TICKET_ALREADY_DECIDED' });
      if (id === 'TK-M') mineList[0] = mineTicket({ ticket_id: 'TK-M', status: 'CANCELLED', decision: { by_username: 'amy.chen', at: '2026-10-23T02:00:00.000Z', comment, cancelled_by: 'REQUESTER' } });
      else pendingList.length = 0;
      return sampleTicket({ ticket_id: id, status: 'CANCELLED' });
    },
  });
  await page.ready;
  assert.equal(nodes.listPending.children.length, 2);
  let mineCard = nodes.listPending.children[1];
  assert.equal(mineCard.querySelector('.approve-button'), null, '提單人的卡片沒有簽核按鈕');
  assert.equal(mineCard.querySelector('.transfer-department'), null, '提單人的卡片沒有轉單');
  assert.equal(mineCard.querySelector('.cancel-button').textContent, TICKETS_TEXT.cancel);
  mineCard.querySelector('textarea').value = 'boom';
  await mineCard.querySelector('.cancel-button').click();
  assert.equal(nodes.noticeTracking.textContent, '這張需求單已經取消', '409 的提示顯示在表單追蹤上方並重新整理');
  assert.notEqual(nodes.listPending.children[1], mineCard, '重新整理後換成新卡片');
  mineCard = nodes.listPending.children[1];
  const cancelButton = mineCard.querySelector('.cancel-button');
  mineCard.querySelector('textarea').value = '';
  await cancelButton.click();
  assert.deepEqual(calls.at(-1), ['TK-M', ''], '提單人取消原因可為空');
  assert.equal(nodes.noticeTracking.textContent, TICKETS_TEXT.cancelled);
  assert.deepEqual(nodes.listPending.children.map((card) => card.getAttribute('data-ticket-id')), ['TK-D'], '取消後離開待簽核');
  const departmentCard = nodes.listPending.children[0];
  const forRequester = departmentCard.querySelector('.cancel-button');
  assert.equal(forRequester.textContent, TICKETS_TEXT.cancelForRequester);
  await forRequester.click();
  assert.equal(departmentCard.querySelector('.decision-error').textContent, TICKETS_TEXT.cancelReasonRequired, '部門取消必須填原因');
  assert.equal(calls.length, 2);
  departmentCard.querySelector('textarea').value = ' 使用者來電取消 ';
  await forRequester.click();
  assert.deepEqual(calls.at(-1), ['TK-D', ' 使用者來電取消 ']);
  assert.equal(nodes.noticeTracking.textContent, TICKETS_TEXT.cancelled);
  assert.equal(nodes.listPending.children.length, 0);
}
test('提單人與部門的取消流程', cancellations);

/**
 * 驗證「重新提出」：把主題與內容存進 sessionStorage 草稿並前往提出需求單頁；儲存體不可用時仍前往。
 * @returns {Promise<void>}
 */
async function resubmit() {
  const stored = new Map();
  const win = createFakeWindow();
  win.sessionStorage = {
    /** 存草稿。@param {string} key 鍵。@param {string} value 值。@returns {void} */
    setItem(key, value) { stored.set(key, value); },
  };
  const { nodes, page } = mountPage({
    /** 回傳一張被退回的單。@returns {Promise<object[]>} 清單。 */
    async loadMyTickets() { return [mineTicket({ ticket_id: 'TK-R', status: 'REJECTED', subject: '申請 VPN', content: '新人需要 VPN', decision: { by_username: 'cindy.wang', at: '2026-10-23T02:00:00.000Z', comment: '資料不足' } })]; },
  }, win);
  await page.ready;
  await nodes.listRejected.children[0].querySelector('.resubmit-button').click();
  assert.deepEqual(JSON.parse(stored.get(DRAFT_KEY)), { subject: '申請 VPN', content: '新人需要 VPN', userID: user.userID }, '草稿記錄提單人的 userID');
  assert.equal(win.location.href, PAGE_URLS.propose);
  cleanup();
  const broken = createFakeWindow();
  broken.sessionStorage = { /** 模擬儲存體不可用。@returns {never} @throws {Error} 失敗。 */ setItem() { throw new Error('quota'); } };
  const second = mountPage({
    /** 回傳一張被退回的單。@returns {Promise<object[]>} 清單。 */
    async loadMyTickets() { return [mineTicket({ ticket_id: 'TK-R', status: 'REJECTED' })]; },
  }, broken);
  await second.page.ready;
  await second.nodes.listRejected.children[0].querySelector('.resubmit-button').click();
  assert.equal(broken.location.href, PAGE_URLS.propose, '儲存失敗仍前往提出需求單頁');
}
test('重新提出被退回的需求單', resubmit);

/**
 * 建立可由測試控制完成時機的 Promise。
 * @returns {{promise: Promise<unknown>, resolve: Function, reject: Function}} Promise 與完成、失敗函式。
 */
function deferred() {
  const handles = {};
  /**
   * 保存 Promise 的完成與失敗函式，讓測試稍後決定回應時機。
   * @param {Function} resolve 完成函式。
   * @param {Function} reject 失敗函式。
   * @returns {void}
   */
  function capture(resolve, reject) { handles.resolve = resolve; handles.reject = reject; }
  handles.promise = new Promise(capture);
  return handles;
}

/**
 * 等待目前排隊的 microtask 與非同步工作先執行完。
 * @returns {Promise<void>} 下一輪事件迴圈開始時完成。
 */
function flush() {
  /** 排入下一輪事件迴圈後完成。@param {Function} done 完成函式。@returns {void} */
  function schedule(done) { setImmediate(done); }
  return new Promise(schedule);
}

/**
 * 建立一份只含指定單號（已簽核）的已完成查詢結果。
 * @param {...string} ids 單號。
 * @returns {object} 已完成清單回應。
 */
function completedResult(...ids) {
  const tickets = [];
  for (const id of ids) tickets.push(sampleTicket({ ticket_id: id, status: 'APPROVED', decision: { by_username: 'amy.chen', at: '2026-10-23T02:00:00.000Z', comment: '' } }));
  return { department: user.department, total: tickets.length, limit: 100, tickets };
}

/**
 * 讀出清單中卡片的單號。
 * @param {object} list 清單節點。
 * @returns {string[]} 單號。
 */
function cardIds(list) {
  const ids = [];
  for (const card of list.children) ids.push(card.getAttribute('data-ticket-id'));
  return ids;
}

/**
 * 驗證表單追蹤的載入序號：重新整理的回應比動作後的重新載入晚回來時被忽略，已簽核的單不會重新顯示為待簽核。
 * @returns {Promise<void>}
 */
async function trackingIgnoresStaleRefresh() {
  let tickets = [sampleTicket({ ticket_id: 'TK-P' })];
  let holdNext = false;
  let held = null;
  const { nodes, page } = mountPage({
    /**
     * 回傳呼叫當下的部門清單；holdNext 為 true 時（模擬慢的重新整理）等測試放行才回應。
     * @returns {Promise<object>} 呼叫當下的清單快照。
     */
    async loadDepartmentTickets() {
      const snapshot = { department: user.department, tickets: [...tickets] };
      if (holdNext) { holdNext = false; held = deferred(); await held.promise; }
      return snapshot;
    },
    /** 簽核後把單移出待簽核。@param {string} id 單號。@returns {Promise<object>} 已簽核的單。 */
    async decideTicket(id) { tickets = []; return sampleTicket({ ticket_id: id, status: 'APPROVED' }); },
  });
  await page.ready;
  holdNext = true;
  const refreshing = nodes.refresh.click();
  await flush();
  assert.ok(held, '重新整理的請求已送出且尚未回應');
  await nodes.listPending.children[0].querySelector('.approve-button').click();
  assert.equal(nodes.listPending.children.length, 0, '動作後的重新載入已移除已簽核的單');
  held.resolve();
  await refreshing;
  assert.equal(nodes.listPending.children.length, 0, '較舊的重新整理回應不會讓已簽核的單重新出現');
  assert.equal(nodes.noticeTracking.textContent, TICKETS_TEXT.decided);
}
test('表單追蹤忽略被取代的較舊載入結果', trackingIgnoresStaleRefresh);

/**
 * 驗證已完成分頁的查詢序號與進行中旗標：連點分頁只送一次第一次載入；常用區間、清除條件交錯時只繪製最後一次查詢；
 * 較舊的查詢先回來時查詢鈕仍停用；較舊查詢的錯誤也被忽略。
 * @returns {Promise<void>}
 */
async function completedIgnoresStaleResults() {
  const loads = [];
  const { nodes, page } = mountPage({
    /** 每次查詢都等測試決定回應。@param {object} filters 條件。@returns {Promise<object>} 清單。 */
    async loadCompletedTickets(filters) { const gate = deferred(); loads.push({ filters, gate }); return gate.promise; },
  });
  await page.ready;
  await nodes.tabCompleted.click();
  await nodes.tabTracking.click();
  await nodes.tabCompleted.click();
  assert.equal(loads.length, 1, '第一次載入進行中時再點分頁不重複查詢');
  loads[0].gate.resolve(completedResult('TK-FIRST'));
  await page.state.completedRequest;
  assert.deepEqual(cardIds(nodes.listCompleted), ['TK-FIRST']);
  const older = nodes.quick['7'].click();
  const newer = nodes.filterReset.click();
  assert.equal(loads.length, 3);
  loads[2].gate.resolve(completedResult('TK-NEW'));
  await newer;
  assert.deepEqual(cardIds(nodes.listCompleted), ['TK-NEW']);
  assert.equal(nodes.filterSubmit.disabled, false);
  loads[1].gate.resolve(completedResult('TK-OLD'));
  await older;
  assert.deepEqual(cardIds(nodes.listCompleted), ['TK-NEW'], '較舊的查詢晚回來也不覆蓋較新的結果');
  assert.equal(nodes.noticeCompleted.textContent, '');
  const first = nodes.quick['30'].click();
  const second = nodes.quick.today.click();
  loads[3].gate.resolve(completedResult('TK-A'));
  await first;
  assert.equal(nodes.filterSubmit.disabled, true, '最新的查詢尚未完成前查詢鈕維持停用');
  assert.equal(nodes.noticeCompleted.textContent, TICKETS_TEXT.searching);
  assert.deepEqual(cardIds(nodes.listCompleted), ['TK-NEW']);
  loads[4].gate.resolve(completedResult('TK-B'));
  await second;
  assert.deepEqual(cardIds(nodes.listCompleted), ['TK-B']);
  const failing = nodes.quick['7'].click();
  const latest = nodes.quick.all.click();
  loads[6].gate.resolve(completedResult('TK-C'));
  await latest;
  loads[5].gate.reject(new TicketServiceError(MESSAGES.listTimeout, { code: 'TIMEOUT' }));
  await failing;
  assert.equal(nodes.noticeCompleted.textContent, '', '較舊查詢的錯誤不顯示');
  assert.deepEqual(cardIds(nodes.listCompleted), ['TK-C']);
}
test('已完成分頁忽略被取代的查詢並避免重複的第一次載入', completedIgnoresStaleResults);

/**
 * 驗證本人提出且送達本部門的單：不顯示簽核與退回（提單人不能簽核自己的單），取消是提單人取消（文字「取消需求單」、原因選填）。
 * 我的需求單清單沒有這張單時，依提單人的 user_id 辨識。
 * @returns {Promise<void>}
 */
async function ownTicketInOwnDepartment() {
  const calls = [];
  let pending = true;
  const own = sampleTicket({ ticket_id: 'TK-OWN', requester: { user_id: user.userID, username: user.username, department_id: user.department.id, department_name: user.department.name } });
  const { nodes, page } = mountPage({
    /** 回傳本人提出、送到本部門的待簽核單；取消後清空。@returns {Promise<object>} 清單。 */
    async loadDepartmentTickets() { return { department: user.department, tickets: pending ? [own] : [] }; },
    /** 記錄取消並移出清單。@param {string} id 單號。@param {string} comment 原因。@returns {Promise<object>} 已取消的單。 */
    async cancelTicket(id, comment) { calls.push([id, comment]); pending = false; return sampleTicket({ ticket_id: id, status: 'CANCELLED' }); },
  });
  await page.ready;
  const card = nodes.listPending.children[0];
  assert.equal(card.querySelector('.approve-button'), null, '提單人不能簽核自己的單');
  assert.equal(card.querySelector('.reject-button'), null, '也不能退回');
  const cancel = card.querySelector('.cancel-button');
  assert.equal(cancel.textContent, TICKETS_TEXT.cancel, '不是「替提單人取消」');
  assert.match(card.querySelector('.decision-help').textContent, /取消後不能復原/, '只能取消時顯示取消的說明');
  await cancel.click();
  assert.equal(card.querySelector('.decision-error').textContent, '', '不要求填寫原因');
  assert.deepEqual(calls, [['TK-OWN', '']]);
  assert.equal(nodes.noticeTracking.textContent, TICKETS_TEXT.cancelled);
  assert.equal(nodes.listPending.children.length, 0);
}
test('本人提出且送達本部門的單以提單人身分取消', ownTicketInOwnDepartment);

/**
 * 驗證卡片動作遇到 429 非額度錯誤時依 retryAfter 倒數：所有按鈕停用、觸發的按鈕顯示剩餘秒數、換轉單部門不提早解除、
 * 倒數中不送出，到期後恢復；額度用盡、超過 300 秒或沒有秒數時不倒數。
 * @param {import('node:test').TestContext} context 可控制的時間。
 * @returns {Promise<void>}
 */
async function actionCountdown(context) {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  let failure = new TicketServiceError('請求太頻繁，請稍後再試', { status: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfter: 5 });
  let calls = 0;
  const { nodes, page } = mountPage({
    /** 一張送達本部門的待簽核單。@returns {Promise<object>} 清單。 */
    async loadDepartmentTickets() { return { department: user.department, tickets: [sampleTicket({ ticket_id: 'TK-P' })] }; },
    /** 依測試指定的錯誤失敗。@returns {Promise<never>} @throws {TicketServiceError} 指定的錯誤。 */
    async decideTicket() { calls += 1; throw failure; },
  });
  await page.ready;
  const card = nodes.listPending.children[0];
  const approve = card.querySelector('.approve-button');
  await approve.click();
  assert.equal(card.querySelector('.decision-error').textContent, '請求太頻繁，請稍後再試');
  assert.equal(approve.textContent, '請等 5 秒');
  for (const selector of ['.approve-button', '.reject-button', '.cancel-button', '.transfer-button']) assert.equal(card.querySelector(selector).disabled, true, `${selector} 倒數中停用`);
  card.querySelector('.transfer-department').value = 'dept-it-2';
  await card.querySelector('.transfer-department').dispatch('change');
  assert.equal(card.querySelector('.transfer-button').disabled, true, '換部門不會提早解除轉單鈕');
  context.mock.timers.tick(2000);
  assert.equal(approve.textContent, '請等 3 秒');
  await approve.click();
  assert.equal(calls, 1, '倒數中不送出');
  context.mock.timers.tick(3000);
  assert.equal(approve.textContent, TICKETS_TEXT.approve);
  for (const selector of ['.approve-button', '.reject-button', '.cancel-button', '.transfer-button']) assert.equal(card.querySelector(selector).disabled, false, `${selector} 倒數結束後恢復`);
  for (const next of [
    new TicketServiceError(MESSAGES.quota, { status: 429, code: 'DAILY_QUOTA_EXCEEDED', retryAfter: 40 }),
    new TicketServiceError(MESSAGES.busy, { status: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfter: 301 }),
    new TicketServiceError(MESSAGES.busy, { status: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfter: 0 }),
  ]) {
    failure = next;
    await approve.click();
    assert.equal(approve.textContent, TICKETS_TEXT.approve, `${next.code}/${next.retryAfter} 不倒數`);
    assert.equal(approve.disabled, false);
    assert.equal(card.querySelector('.decision-error').textContent, next.message);
  }
}
test('卡片動作遇到 429 依等待秒數倒數', actionCountdown);

/**
 * 驗證動作完成後已完成分頁的同步：沒開過已完成時不查詢；開過之後成功動作與 404 TICKET_NOT_FOUND 都會重新查詢並更新結果；
 * 404 TICKET_NOT_FOUND 的提示顯示在表單追蹤上方並重新整理清單；404 NOT_FOUND（未知路由）仍只顯示在卡片內。
 * @returns {Promise<void>}
 */
async function actionsRefreshCompleted() {
  let pending = ['TK-O', 'TK-P', 'TK-Q', 'TK-R'];
  const approved = [];
  let completedLoads = 0;
  /** 把單號移出待簽核清單。@param {string} id 單號。@returns {void} */
  function settle(id) { pending = pending.filter(/** 保留其他單號。@param {string} item 單號。@returns {boolean} 是否保留。 */ (item) => item !== id); }
  const { nodes, page } = mountPage({
    /** 回傳目前仍待簽核的單。@returns {Promise<object>} 清單。 */
    async loadDepartmentTickets() {
      const tickets = [];
      for (const id of pending) tickets.push(sampleTicket({ ticket_id: id }));
      return { department: user.department, tickets };
    },
    /** 回傳目前已簽核的單並計數。@returns {Promise<object>} 清單。 */
    async loadCompletedTickets() { completedLoads += 1; return completedResult(...approved); },
    /**
     * TK-Q 已被刪除（404 TICKET_NOT_FOUND）、TK-R 遇到未知路由（404 NOT_FOUND），其他單簽核成功。
     * @param {string} id 單號。
     * @returns {Promise<object>} 已簽核的單。
     * @throws {TicketServiceError} 404。
     */
    async decideTicket(id) {
      if (id === 'TK-Q') { settle(id); throw new TicketServiceError('查無這張需求單', { status: 404, code: 'TICKET_NOT_FOUND' }); }
      if (id === 'TK-R') throw new TicketServiceError(MESSAGES.notFound, { status: 404, code: 'NOT_FOUND' });
      settle(id);
      approved.unshift(id);
      return sampleTicket({ ticket_id: id, status: 'APPROVED' });
    },
  });
  await page.ready;
  /** 按下指定單號卡片的簽核鈕。@param {string} id 單號。@returns {Promise<void>} 處理完成。 */
  async function approve(id) {
    const card = nodes.listPending.children[cardIds(nodes.listPending).indexOf(id)];
    await card.querySelector('.approve-button').click();
  }
  await approve('TK-O');
  assert.equal(completedLoads, 0, '沒開過已完成時不額外查詢');
  await nodes.tabCompleted.click();
  await page.state.completedRequest;
  assert.deepEqual(cardIds(nodes.listCompleted), ['TK-O']);
  await nodes.tabTracking.click();
  await approve('TK-P');
  assert.equal(completedLoads, 2, '簽核成功後重新查詢已完成');
  assert.deepEqual(cardIds(nodes.listCompleted), ['TK-P', 'TK-O'], '已完成分頁不再是舊結果');
  await approve('TK-Q');
  assert.equal(nodes.noticeTracking.textContent, '查無這張需求單');
  assert.deepEqual(cardIds(nodes.listPending), ['TK-R'], '查無需求單後重新整理清單');
  assert.equal(completedLoads, 3, '查無需求單時一併重新查詢已完成');
  await approve('TK-R');
  const card = nodes.listPending.children[0];
  assert.equal(card.querySelector('.decision-error').textContent, MESSAGES.notFound, '未知路由的 404 留在卡片內');
  assert.equal(nodes.noticeTracking.textContent, '查無這張需求單');
  assert.equal(completedLoads, 3);
}
test('動作後同步已完成分頁並處理查無需求單', actionsRefreshCompleted);

/**
 * 驗證登出時清除「重新提出」草稿，下一個登入的帳號不會帶入。
 * @returns {Promise<void>}
 */
async function logoutClearsDraft() {
  const stored = new Map([[DRAFT_KEY, JSON.stringify({ subject: '申請 VPN', content: '新人需要 VPN', userID: user.userID })]]);
  const win = createFakeWindow();
  win.sessionStorage = {
    /** 讀取值。@param {string} key 鍵。@returns {string|null} 值。 */
    getItem(key) { return stored.get(key) ?? null; },
    /** 移除值。@param {string} key 鍵。@returns {void} */
    removeItem(key) { stored.delete(key); },
  };
  const { nodes, page, auth } = mountPage({}, win);
  await page.ready;
  await nodes.logout.click();
  assert.deepEqual(auth.calls, ['logout']);
  assert.equal(stored.has(DRAFT_KEY), false, '登出時清除草稿');
  assert.deepEqual(win.redirects, [PAGE_URLS.login]);
}
test('登出時清除重新提出的草稿', logoutClearsDraft);

/**
 * 建立可同時登記多個同名事件處理器、並計算計時器建立次數的視窗替身（帳號選單與頁面都會監聽 pageshow）。
 * @returns {object} 視窗替身，另含 fire(type) 觸發所有同名處理器、intervals 記錄 setInterval 呼叫次數。
 */
function trackingWindow() {
  const win = createFakeWindow();
  const handlers = new Map();
  win.intervals = 0;
  /** 登記事件處理器（同名可多個）。@param {string} type 事件名。@param {Function} handler 處理器。@returns {void} */
  win.addEventListener = function addListener(type, handler) {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(handler);
  };
  /** 依序執行所有同名處理器。@param {string} type 事件名。@returns {void} */
  win.fire = function fire(type) { for (const handler of handlers.get(type) ?? []) handler({ type }); };
  /** 計數後轉交全域計時器。@param {...unknown} args 參數。@returns {unknown} 計時器。 */
  win.setInterval = function countInterval(...args) { win.intervals += 1; return globalThis.setInterval(...args); };
  return win;
}

/**
 * 依單號找出待簽核區的卡片。
 * @param {object} nodes 頁面節點。
 * @param {string} id 單號。
 * @returns {object|undefined} 卡片；不在畫面上時為 undefined。
 */
function pendingCard(nodes, id) { return nodes.listPending.children[cardIds(nodes.listPending).indexOf(id)]; }

/**
 * 驗證 R-F1：另一張卡片動作成功而重新繪製清單時，仍在處理中的卡片在新卡片上維持停用與「處理中…」；
 * 舊請求之後回來的錯誤（逾時）與 429 倒數顯示在新卡片上，而不是寫到已移除的舊表單，且重新整理後仍保留；
 * 清單重新載入後已不在畫面上的卡片，其動作錯誤改顯示在表單追蹤上方。
 * @param {import('node:test').TestContext} context 可控制的時間。
 * @returns {Promise<void>}
 */
async function redrawKeepsInFlightState(context) {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  let pending = ['TK-A', 'TK-B', 'TK-C'];
  const gates = new Map();
  /** 保留 TK-A 以外的單號。@param {string} item 單號。@returns {boolean} 是否保留。 */
  function notA(item) { return item !== 'TK-A'; }
  const { nodes, page } = mountPage({
    /** 回傳目前仍待簽核的單。@returns {Promise<object>} 清單。 */
    async loadDepartmentTickets() {
      const tickets = [];
      for (const id of pending) tickets.push(sampleTicket({ ticket_id: id }));
      return { department: user.department, tickets };
    },
    /**
     * TK-A 立即簽核成功並移出清單；其他單等測試放行。
     * @param {string} id 單號。
     * @returns {Promise<object>} 已簽核的單。
     */
    async decideTicket(id) {
      if (id === 'TK-A') { pending = pending.filter(notA); return sampleTicket({ ticket_id: id, status: 'APPROVED' }); }
      const gate = deferred();
      gates.set(id, gate);
      return gate.promise;
    },
  });
  await page.ready;
  const oldB = pendingCard(nodes, 'TK-B');
  const runningB = oldB.querySelector('.approve-button').click();
  const runningC = pendingCard(nodes, 'TK-C').querySelector('.reject-button').click();
  await flush();
  assert.equal(oldB.querySelector('.approve-button').textContent, TICKETS_TEXT.working);
  await pendingCard(nodes, 'TK-A').querySelector('.approve-button').click();
  assert.deepEqual(cardIds(nodes.listPending), ['TK-B', 'TK-C'], 'TK-A 成功後重新繪製');
  const newB = pendingCard(nodes, 'TK-B');
  assert.notEqual(newB, oldB, 'TK-B 是重新建立的卡片');
  for (const selector of ['.approve-button', '.reject-button', '.cancel-button', '.transfer-button']) {
    assert.equal(newB.querySelector(selector).disabled, true, `重新繪製後 ${selector} 在請求進行中維持停用`);
  }
  assert.equal(newB.querySelector('.approve-button').textContent, TICKETS_TEXT.working, '新卡片顯示處理中');
  assert.equal(newB.querySelector('.reject-button').textContent, TICKETS_TEXT.reject, '其他按鈕保留自己的文字');
  assert.equal(pendingCard(nodes, 'TK-C').querySelector('.reject-button').textContent, TICKETS_TEXT.working);
  gates.get('TK-B').reject(new TicketServiceError(MESSAGES.decisionTimeout, { code: 'TIMEOUT' }));
  await runningB;
  assert.equal(newB.querySelector('.decision-error').textContent, MESSAGES.decisionTimeout, '逾時提示顯示在畫面上的新卡片');
  assert.equal(newB.querySelector('.approve-button').textContent, TICKETS_TEXT.approve);
  assert.equal(newB.querySelector('.approve-button').disabled, false, '請求結束後解除停用');
  gates.get('TK-C').reject(new TicketServiceError('請求太頻繁，請稍後再試', { status: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfter: 3 }));
  await runningC;
  const cardC = pendingCard(nodes, 'TK-C');
  assert.equal(cardC.querySelector('.reject-button').textContent, '請等 3 秒', '429 倒數顯示在新卡片上');
  assert.equal(cardC.querySelector('.decision-error').textContent, '請求太頻繁，請稍後再試');
  await nodes.refresh.click();
  const redrawnC = pendingCard(nodes, 'TK-C');
  assert.notEqual(redrawnC, cardC);
  assert.equal(redrawnC.querySelector('.reject-button').textContent, '請等 3 秒', '重新整理後倒數仍延續');
  assert.equal(redrawnC.querySelector('.approve-button').disabled, true);
  assert.equal(pendingCard(nodes, 'TK-B').querySelector('.decision-error').textContent, MESSAGES.decisionTimeout, '非過期錯誤在重新繪製後仍顯示');
  context.mock.timers.tick(3000);
  assert.equal(redrawnC.querySelector('.reject-button').textContent, TICKETS_TEXT.reject);
  assert.equal(redrawnC.querySelector('.approve-button').disabled, false, '倒數到期後解除');
  const runningAgain = pendingCard(nodes, 'TK-B').querySelector('.approve-button').click();
  await flush();
  pending = ['TK-C'];
  await nodes.refresh.click();
  assert.deepEqual(cardIds(nodes.listPending), ['TK-C'], '同事已處理 TK-B，卡片從清單消失');
  gates.get('TK-B').reject(new TicketServiceError(MESSAGES.decisionTimeout, { code: 'TIMEOUT' }));
  await runningAgain;
  assert.equal(nodes.noticeTracking.textContent, MESSAGES.decisionTimeout, '卡片已不在畫面上時錯誤改顯示在表單追蹤上方');
}
test('清單重新繪製時沿用卡片的處理中、錯誤與倒數狀態', redrawKeepsInFlightState);

/**
 * 驗證 K-F4：倒數只使用頁面層級的一個計時器；重新繪製卡片不會另外建立計時器；pagehide 清除計時器、pageshow 依目前時間恢復，
 * 隱藏期間倒數已到期時恢復後立即解除鎖定。
 * @param {import('node:test').TestContext} context 可控制的時間。
 * @returns {Promise<void>}
 */
async function countdownTimerLifecycle(context) {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  const win = trackingWindow();
  const { nodes, page } = mountPage({
    /** 一張送達本部門的待簽核單。@returns {Promise<object>} 清單。 */
    async loadDepartmentTickets() { return { department: user.department, tickets: [sampleTicket({ ticket_id: 'TK-P' })] }; },
    /** 一律遇到限流。@returns {Promise<never>} @throws {TicketServiceError} 429。 */
    async decideTicket() { throw new TicketServiceError('請求太頻繁，請稍後再試', { status: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfter: 10 }); },
  }, win);
  await page.ready;
  await nodes.listPending.children[0].querySelector('.approve-button').click();
  assert.equal(win.intervals, 1);
  assert.equal(page.actionStates.isTicking(), true);
  await nodes.refresh.click();
  await nodes.refresh.click();
  assert.equal(win.intervals, 1, '重新繪製卡片不會再建立計時器');
  assert.equal(nodes.listPending.children[0].querySelector('.approve-button').textContent, '請等 10 秒');
  win.fire('pagehide');
  assert.equal(page.actionStates.isTicking(), false, 'pagehide 清除計時器');
  context.mock.timers.tick(4000);
  win.fire('pageshow');
  assert.equal(page.actionStates.isTicking(), true, 'pageshow 恢復計時器');
  assert.equal(nodes.listPending.children[0].querySelector('.approve-button').textContent, '請等 6 秒', '恢復後依目前時間推算');
  win.fire('pagehide');
  context.mock.timers.tick(10000);
  win.fire('pageshow');
  const card = nodes.listPending.children[0];
  assert.equal(page.actionStates.isTicking(), false, '已到期時不再啟動計時器');
  assert.equal(card.querySelector('.approve-button').textContent, TICKETS_TEXT.approve);
  assert.equal(card.querySelector('.approve-button').disabled, false);
}
test('卡片倒數計時器在重新繪製、pagehide 與 pageshow 時的生命週期', countdownTimerLifecycle);

/**
 * 驗證 R-F2：同一張卡片請求進行中時換轉單部門不會重新啟用轉單鈕、再按其他按鈕不會送出第二個請求，
 * 請求結束後每個按鈕恢復自己原本的文字。
 * @returns {Promise<void>}
 */
async function actionsBusyGuard() {
  globalThis.document = createFakeDocument();
  const gate = deferred();
  const calls = [];
  const form = buildTicketCard(sampleTicket({ ticket_id: 'TK-G' }), {
    /** 記錄並等待測試放行。@param {...unknown} args 參數。@returns {Promise<unknown>} 結果。 */
    onDecide: (...args) => { calls.push(['decide', ...args]); return gate.promise; },
    /** 記錄轉單。@param {...unknown} args 參數。@returns {Promise<void>} 完成。 */
    onTransfer: async (...args) => { calls.push(['transfer', ...args]); },
    /** 記錄取消。@param {...unknown} args 參數。@returns {Promise<void>} 完成。 */
    onCancel: async (...args) => { calls.push(['cancel', ...args]); },
    departments: departmentList, cancelRequiresComment: true,
  });
  const approve = form.querySelector('.approve-button');
  const reject = form.querySelector('.reject-button');
  const transferButton = form.querySelector('.transfer-button');
  const select = form.querySelector('.transfer-department');
  const running = approve.click();
  assert.equal(approve.textContent, TICKETS_TEXT.working);
  select.value = 'dept-it-2';
  await select.dispatch('change');
  assert.equal(transferButton.disabled, true, '請求進行中換部門不會啟用轉單鈕');
  await reject.click();
  await transferButton.click();
  form.querySelector('textarea').value = '原因';
  await form.querySelector('.cancel-button').click();
  assert.equal(calls.length, 1, '請求進行中不送出第二個動作');
  assert.equal(reject.textContent, TICKETS_TEXT.reject, '其他按鈕不被標成處理中');
  gate.resolve();
  await running;
  assert.equal(approve.textContent, TICKETS_TEXT.approve, '簽核鈕恢復自己的文字');
  assert.equal(reject.textContent, TICKETS_TEXT.reject, '退回鈕恢復自己的文字');
  assert.equal(transferButton.textContent, TICKETS_TEXT.transfer);
  assert.equal(transferButton.disabled, false, '結束後已選部門的轉單鈕恢復可用');
  await transferButton.click();
  assert.deepEqual(calls.at(-1), ['transfer', 'TK-G', 'dept-it-2', '', '原因']);
}
test('同一張卡片請求進行中時鎖定所有動作並恢復各自文字', actionsBusyGuard);

/**
 * 驗證 R-F3：簽核與取消遇到 403（例如同事已把單轉到其他部門）時，把後端訊息顯示在表單追蹤上方並重新整理清單，不導回登入頁。
 * @returns {Promise<void>}
 */
async function forbiddenActionsReload() {
  for (const kind of ['decide', 'cancel']) {
    let loads = 0;
    const message = kind === 'decide' ? '只有送達部門的成員可以簽核這張需求單' : '只有提單人或送達部門的成員可以取消這張需求單';
    /** 模擬後端回 403。@returns {Promise<never>} @throws {TicketServiceError} 403。 */
    async function forbidden() { throw new TicketServiceError(message, { status: 403, code: 'FORBIDDEN' }); }
    const { nodes, page, win } = mountPage({
      /** 第一次有單，之後已被同事轉走。@returns {Promise<object>} 清單。 */
      async loadDepartmentTickets() { loads += 1; return { department: user.department, tickets: loads === 1 ? [sampleTicket({ ticket_id: 'TK-F' })] : [] }; },
      decideTicket: forbidden,
      cancelTicket: forbidden,
    });
    await page.ready;
    const card = nodes.listPending.children[0];
    card.querySelector('textarea').value = '使用者來電取消';
    await card.querySelector(kind === 'decide' ? '.approve-button' : '.cancel-button').click();
    assert.equal(nodes.noticeTracking.textContent, message, `${kind} 的 403 提示顯示在表單追蹤上方`);
    assert.equal(loads, 2, `${kind} 的 403 後重新整理清單`);
    assert.equal(nodes.listPending.children.length, 0, '過期的卡片被移除');
    assert.deepEqual(win.redirects, [], '403 不導回登入頁');
    cleanup();
  }
}
test('簽核與取消遇到 403 時重新整理清單', forbiddenActionsReload);

/**
 * 驗證 R-F5：送達本部門的單只依 requester.user_id 判斷是否本人提出（與後端相同）；
 * user_id 缺漏但 username 相同、且不在我的需求單時，仍是「替提單人取消」並要求原因。
 * @returns {Promise<void>}
 */
async function ownTicketUsesUserIdOnly() {
  const { nodes, page } = mountPage({
    /** 一張 username 與登入者相同但沒有 user_id 的單。@returns {Promise<object>} 清單。 */
    async loadDepartmentTickets() { return { department: user.department, tickets: [sampleTicket({ ticket_id: 'TK-U', requester: { username: user.username, department_name: user.department.name } })] }; },
  });
  await page.ready;
  const card = nodes.listPending.children[0];
  assert.equal(card.querySelector('.cancel-button').textContent, TICKETS_TEXT.cancelForRequester, '不以 username 判定為本人');
  await card.querySelector('.cancel-button').click();
  assert.equal(card.querySelector('.decision-error').textContent, TICKETS_TEXT.cancelReasonRequired);
}
test('本人提出的判斷只比對 requester.user_id', ownTicketUsesUserIdOnly);

/**
 * 驗證需求類型目錄：頁面載入時查詢一次 GET /api/forms，表單追蹤與已完成卡片都以目錄的欄位名稱顯示；
 * 成功後重新整理不再查詢；目錄載入失敗時卡片改以欄位代號顯示、不影響清單，下次重新整理會再試。
 * @returns {Promise<void>}
 */
async function formTypesDirectory() {
  let typeLoads = 0;
  let failNext = false;
  const formTicket = sampleTicket({ ticket_id: 'TK-F', route: 'FORM', handler: null,
    form: { id: 'future-test', version: 1, name: '測試申請', fields: { item: '螢幕', needed_by: '2026-11-20' } } });
  const done = sampleTicket({ ...formTicket, ticket_id: 'TK-D', status: 'APPROVED' });
  const types = [{ id: 'future-test', version: 2, name: '測試申請', department: null, summary: '', computed: [], workflow: { transfer: null, not_requester: null },
    fields: [{ key: 'item', label: '品項', type: 'text' }, { key: 'needed_by', label: '需要日期', type: 'date' }] }];
  const { nodes, page } = mountPage({
    /** 我的需求單含一張類型表單單。@returns {Promise<object[]>} 清單。 */
    async loadMyTickets() { return [formTicket]; },
    /** 已完成含一張類型表單單。@returns {Promise<object>} 清單。 */
    async loadCompletedTickets() { return { department: user.department, total: 1, limit: 100, tickets: [done] }; },
    /**
     * 目錄替身：記錄次數，failNext 為 true 時模擬失敗。
     * @returns {Promise<object[]>} 需求類型。
     * @throws {TicketServiceError} 模擬的失敗。
     */
    async loadRequestTypes() {
      typeLoads += 1;
      if (failNext) { failNext = false; throw new TicketServiceError('系統暫時忙碌，請稍後再試', { status: 503 }); }
      return types;
    },
  });
  await page.ready;
  /**
   * 取出卡片表單表格每列的標題。
   * @param {object} card 卡片元素。
   * @returns {string[]} 欄位名稱。
   */
  function labelsOf(card) {
    /**
     * 取出儲存格文字。
     * @param {object} cell 表格標題儲存格。
     * @returns {string} 文字。
     */
    function cellText(cell) { return cell.textContent; }
    return card.querySelector('.form-table').querySelectorAll('th').map(cellText);
  }
  assert.deepEqual(labelsOf(nodes.listPending.children[0]), ['品項', '需要日期']);
  page.selectTab('completed');
  await page.state.completedRequest;
  assert.deepEqual(labelsOf(nodes.listCompleted.children[0]), ['品項', '需要日期']);
  await page.refresh();
  assert.equal(typeLoads, 1, '成功載入後不再查詢');
  cleanup();
  failNext = true;
  const second = mountPage({
    /** 我的需求單含一張類型表單單。@returns {Promise<object[]>} 清單。 */
    async loadMyTickets() { return [formTicket]; },
    /**
     * 第一次失敗、之後成功的目錄替身。
     * @returns {Promise<object[]>} 需求類型。
     * @throws {TicketServiceError} 模擬的失敗。
     */
    async loadRequestTypes() {
      typeLoads += 1;
      if (failNext) { failNext = false; throw new TicketServiceError('系統暫時忙碌，請稍後再試', { status: 503 }); }
      return types;
    },
  });
  await second.page.ready;
  assert.deepEqual(labelsOf(second.nodes.listPending.children[0]), ['item', 'needed_by'], '目錄失敗時以欄位代號顯示');
  assert.equal(second.nodes.noticeTracking.hidden, true, '目錄失敗不顯示清單錯誤');
  await second.page.refresh();
  assert.deepEqual(labelsOf(second.nodes.listPending.children[0]), ['品項', '需要日期'], '重新整理時再試');
}
test('需求類型目錄只載入一次並用於卡片欄位名稱', formTypesDirectory);
