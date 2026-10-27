import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createFakeWindow, pageIds, fakeAuth } from './helpers/fakeDom.js';
import { initTicketsPage, buildTicketCard, describeTarget, formatTime, TICKETS_TEXT } from '../src/tickets.js';
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
  const ids = pageIds(new URL('../tickets.html', import.meta.url));
  for (const id of ['account-avatar', 'account-name', 'account-id', 'account-department', 'logout-button', 'refresh-button', 'tab-tracking', 'tab-completed', 'count-tracking',
    'panel-tracking', 'notice-tracking', 'count-pending', 'pending-hint', 'empty-pending', 'list-pending', 'count-rejected', 'empty-rejected', 'list-rejected',
    'panel-completed', 'completed-title', 'filter-form', 'filter-q', 'filter-status', 'filter-from', 'filter-to', 'filter-reset', 'filter-submit',
    'completed-summary', 'notice-completed', 'empty-completed', 'list-completed']) {
    assert.ok(ids.has(id), `tickets.html 缺少 #${id}`);
  }
  assert.ok(pageIds(new URL('../propose.html', import.meta.url)).has('account-department'));
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
  assert.equal(pending.querySelectorAll('.ticket-row').length, 3);
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
  assert.ok(pendingCards[1].querySelector('.approve-button'), '送到自己部門的單保留簽核操作');
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
 * 驗證簽核、退回與轉單：呼叫服務、成功後重新載入並顯示提示；備註過長與服務錯誤顯示在卡片內。
 * @param {import('node:test').TestContext} context mock 管理器。
 * @returns {Promise<void>}
 */
async function decisionsAndTransfers(context) {
  const tickets = [sampleTicket({ ticket_id: 'TK-P' })];
  const calls = [];
  const { nodes, page, win, auth } = mountPage({
    /** 回傳目前的部門清單。@returns {Promise<object>} 清單。 */
    async loadDepartmentTickets() { return { department: user.department, tickets: [...tickets] }; },
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
  const card = nodes.listPending.children[0];
  const comment = card.querySelector('textarea');
  comment.value = 'a'.repeat(201);
  await card.querySelector('.approve-button').click();
  assert.match(card.querySelector('.decision-error').textContent, /備註最多 200 字/);
  assert.equal(calls.length, 0);
  comment.value = 'boom';
  await card.querySelector('.approve-button').click();
  assert.equal(card.querySelector('.decision-error').textContent, '這張需求單已經簽核過，請重新整理清單');
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
  await card.querySelector('.transfer-button').click();
  assert.equal(card.querySelector('.decision-error').textContent, '只有送達部門的成員可以轉這張需求單');
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
  assert.deepEqual(expired.win.redirects, ['./index.html']);
  assert.deepEqual(expired.auth.calls, ['logout']);
  cleanup();
  const doc = createFakeDocument();
  const win = createFakeWindow();
  buildTicketsDom(doc);
  assert.equal(initTicketsPage(doc, win, { auth: fakeAuth(null) }), null);
  assert.deepEqual(win.redirects, ['./index.html']);
}
test('清單載入失敗的提示、轉單停用與登入守門', loadFailures);

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
  const mineCard = nodes.listPending.children[1];
  assert.equal(mineCard.querySelector('.approve-button'), null, '提單人的卡片沒有簽核按鈕');
  assert.equal(mineCard.querySelector('.transfer-department'), null, '提單人的卡片沒有轉單');
  const cancelButton = mineCard.querySelector('.cancel-button');
  assert.equal(cancelButton.textContent, TICKETS_TEXT.cancel);
  mineCard.querySelector('textarea').value = 'boom';
  await cancelButton.click();
  assert.equal(mineCard.querySelector('.decision-error').textContent, '這張需求單已經取消');
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
  assert.deepEqual(JSON.parse(stored.get(DRAFT_KEY)), { subject: '申請 VPN', content: '新人需要 VPN' });
  assert.equal(win.location.href, './propose.html');
  cleanup();
  const broken = createFakeWindow();
  broken.sessionStorage = { /** 模擬儲存體不可用。@returns {never} @throws {Error} 失敗。 */ setItem() { throw new Error('quota'); } };
  const second = mountPage({
    /** 回傳一張被退回的單。@returns {Promise<object[]>} 清單。 */
    async loadMyTickets() { return [mineTicket({ ticket_id: 'TK-R', status: 'REJECTED' })]; },
  }, broken);
  await second.page.ready;
  await second.nodes.listRejected.children[0].querySelector('.resubmit-button').click();
  assert.equal(broken.location.href, './propose.html', '儲存失敗仍前往提出需求單頁');
}
test('重新提出被退回的需求單', resubmit);
