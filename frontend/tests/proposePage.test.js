import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createFakeWindow, buildProposeDom, pageIds, fakeAuth } from './helpers/fakeDom.js';
import { initProposePage, PROPOSE_TEXT } from '../src/propose.js';
import { DRAFT_KEY } from '../src/services/ticketService.js';

const departments = [
  { id: 'dept-it-1', name: '資訊管理一部', type: '資訊', duty: 'IT資訊服務台', business: ['VPN'], handlers: [{ id: 'h-1', name: 'racky.huang' }, { id: 'h-2', name: 'amy.chen' }] },
  { id: 'dept-ga-1', name: '總務與硬體組', type: '', duty: '報修', business: ['報修'], handlers: [] },
];

/**
 * 建立已登入的頁面環境，名單與送單服務可由測試指定。
 * @param {object} [services={}] loadDepartments 與 submitTicket 替身。
 * @param {object} [win] 視窗替身，可帶 sessionStorage。
 * @returns {object} doc、win、nodes、auth 與頁面控制器。
 */
function mountPage(services = {}, win = createFakeWindow()) {
  const doc = createFakeDocument();
  const nodes = buildProposeDom(doc);
  const auth = fakeAuth({ username: 'amy.chen', userID: 'user-amy.chen', department: { id: 'dept-it-1', name: '資訊管理一部' } });
  globalThis.document = doc;
  /** 預設名單載入成功。@returns {Promise<object[]>} 部門。 */
  async function loadDepartments() { return departments; }
  const page = initProposePage(doc, win, { auth, loadDepartments, ...services });
  return { doc, win, nodes, auth, page };
}
/** 清除全域文件替身。@returns {void} */
function cleanup() { delete globalThis.document; }
test.afterEach(cleanup);

/**
 * 驗證 propose.html 具備頁面腳本依賴的所有節點 id。
 * @returns {void}
 */
function pageStructure() {
  const ids = pageIds(new URL('../propose.html', import.meta.url));
  const required = ['account-avatar', 'account-name', 'account-id', 'logout-button', 'list-notice', 'ticket-form', 'subject', 'subject-count', 'subject-error',
    'content', 'content-count', 'content-error', 'handler', 'handler-picker', 'handler-search', 'handler-clear', 'handler-listbox', 'handler-hint', 'reset-button', 'submit-button', 'submit-error', 'departments-button',
    'departments-dialog', 'departments-close', 'departments-list', 'result-dialog', 'result-subject', 'result-ticket', 'result-target', 'result-method',
    'result-basis-row', 'result-basis', 'result-note', 'result-close', 'result-again'];
  for (const id of required) assert.ok(ids.has(id), `propose.html 缺少 #${id}`);
}
test('提出需求單頁具備腳本需要的節點', pageStructure);

/**
 * 驗證未登入時回到登入頁且不初始化頁面。
 * @returns {void}
 */
function requiresLogin() {
  const doc = createFakeDocument();
  const win = createFakeWindow();
  buildProposeDom(doc);
  const auth = fakeAuth(null);
  const page = initProposePage(doc, win, { auth });
  assert.equal(page, null);
  assert.deepEqual(win.redirects, ['./index.html']);
  assert.equal(doc.body.hidden, true);
  assert.deepEqual(auth.calls, ['logout']);
}
test('未登入直接開啟提出需求單頁會回到登入頁', requiresLogin);

/**
 * 驗證載入中與成功兩種名單狀態、帳號顯示、可搜尋的分組選項與部門視窗內容。
 * @returns {Promise<void>}
 */
async function listStates() {
  let resolveList;
  /** 可控制完成時機的名單載入。@returns {Promise<object[]>} 部門。 */
  function loadDepartments() { return new Promise((resolve) => { resolveList = resolve; }); }
  const { doc, nodes, page } = mountPage({ loadDepartments });
  assert.equal(doc.body.hidden, false);
  assert.equal(nodes.accountName.textContent, 'amy.chen');
  assert.equal(nodes.accountId.textContent, 'user-amy.chen');
  assert.equal(nodes.accountAvatar.textContent, 'A');
  assert.equal(nodes.handlerSearch.disabled, true);
  assert.equal(nodes.handlerSearch.placeholder, PROPOSE_TEXT.loading);
  assert.equal(nodes.departmentsButton.disabled, true);
  assert.equal(nodes.subjectCount.textContent, '0 / 100');
  assert.equal(nodes.contentCount.textContent, '0 / 2000');
  resolveList(departments);
  await page.ready;
  assert.equal(nodes.handlerSearch.disabled, false);
  assert.equal(nodes.handlerSearch.placeholder, PROPOSE_TEXT.ready);
  assert.equal(nodes.handler.value, '');
  await nodes.handlerSearch.dispatch('click');
  assert.equal(nodes.handlerListbox.hidden, false);
  assert.deepEqual(nodes.handlerListbox.querySelectorAll('.picker-group').map((group) => group.textContent), ['資訊管理一部']);
  assert.deepEqual(nodes.handlerListbox.querySelectorAll('.picker-option').map((option) => option.textContent), [PROPOSE_TEXT.ready, 'racky.huang', 'amy.chen']);
  assert.equal(nodes.departmentsButton.disabled, false);
  assert.equal(nodes.notice.hidden, true);
  assert.deepEqual(nodes.departmentsList.querySelectorAll('.department-name').map((node) => node.textContent), ['資訊管理一部', '總務與硬體組']);
  nodes.handlerSearch.value = 'AMY';
  await nodes.handlerSearch.dispatch('input');
  assert.deepEqual(nodes.handlerListbox.querySelectorAll('.picker-option').map((option) => option.textContent), ['amy.chen'], '關鍵字即時過濾且不分大小寫');
  await nodes.handlerListbox.querySelector('.picker-option').click();
  assert.equal(nodes.handler.value, 'h-2');
  assert.equal(nodes.handlerSearch.value, 'amy.chen');
  assert.equal(nodes.handlerListbox.hidden, true);
  assert.equal(nodes.handlerClear.hidden, false);
  assert.equal(nodes.handlerHint.hidden, false);
  assert.equal(nodes.handlerHint.textContent, '預計送達：amy.chen（資訊管理一部）');
  await nodes.handlerClear.click();
  assert.equal(nodes.handler.value, '');
  assert.equal(nodes.handlerSearch.value, '');
  assert.equal(nodes.handlerHint.hidden, true);
  await nodes.departmentsButton.click();
  assert.equal(nodes.departmentsDialog.open, true);
  await nodes.departmentsClose.click();
  assert.equal(nodes.departmentsDialog.open, false);
}
test('名單載入中與成功狀態、分組選項與部門視窗', listStates);

/**
 * 驗證送出前的欄位驗證：兩欄同時顯示錯誤、焦點移到第一個錯誤欄位、輸入時清除錯誤與字數警示。
 * @returns {Promise<void>}
 */
async function formValidation() {
  let calls = 0;
  /** 不應被呼叫。@returns {Promise<object>} 結果。 */
  async function submitTicket() { calls += 1; return {}; }
  const { doc, nodes, page } = mountPage({ submitTicket });
  await page.ready;
  await nodes.form.dispatch('submit');
  assert.equal(nodes.subjectError.textContent, '請填寫主題');
  assert.equal(nodes.contentError.textContent, '請填寫需求內容');
  assert.equal(nodes.subject.getAttribute('aria-invalid'), 'true');
  assert.equal(doc.activeElement, nodes.subject);
  assert.equal(calls, 0);
  nodes.subject.value = '申請 VPN 帳號';
  await nodes.subject.dispatch('input');
  assert.equal(nodes.subjectError.textContent, '');
  assert.equal(nodes.subject.getAttribute('aria-invalid'), null);
  assert.equal(nodes.subjectCount.textContent, '9 / 100');
  nodes.content.value = 'a'.repeat(2001);
  await nodes.content.dispatch('input');
  assert.equal(nodes.contentCount.textContent, '2001 / 2000');
  assert.equal(nodes.contentCount.classList.contains('over-limit'), true);
  await nodes.form.dispatch('submit');
  assert.equal(nodes.subjectError.textContent, '');
  assert.equal(nodes.contentError.textContent, '需求內容最多 2000 字，目前 2001 字');
  assert.equal(doc.activeElement, nodes.content);
  assert.equal(calls, 0);
  nodes.content.value = '新進同仁需要 VPN 連線權限';
  await nodes.content.dispatch('input');
  assert.equal(nodes.contentCount.classList.contains('over-limit'), false);
  assert.equal(nodes.contentError.textContent, '');
}
test('送出前的欄位驗證與輸入時清除錯誤', formValidation);

/**
 * 驗證成功送出：送出中鎖住表單、結果視窗內容、關閉後清空表單並把焦點放回主題。
 * @returns {Promise<void>}
 */
async function successfulSubmit() {
  let resolveSubmit;
  const received = [];
  /** 可控制完成時機的送單。@param {object} input 表單內容。@returns {Promise<object>} 結果。 */
  function submitTicket(input) { received.push(input); return new Promise((resolve) => { resolveSubmit = resolve; }); }
  const { doc, nodes, page } = mountPage({ submitTicket });
  await page.ready;
  nodes.subject.value = ' 申請 Jira 專案存取權限 ';
  nodes.content.value = ' 需要編輯權限 ';
  nodes.handlerSearch.value = 'h-2 不存在的文字';
  await nodes.handlerSearch.dispatch('input');
  assert.equal(nodes.handlerListbox.querySelector('.picker-empty').textContent, '沒有符合的處理人，換個關鍵字試試');
  nodes.handlerSearch.value = '一部';
  await nodes.handlerSearch.dispatch('input');
  assert.deepEqual(nodes.handlerListbox.querySelectorAll('.picker-option').map((option) => option.textContent), ['racky.huang', 'amy.chen'], '輸入部門名稱列出整個部門');
  await nodes.handlerListbox.querySelectorAll('.picker-option')[1].click();
  assert.equal(nodes.handler.value, 'h-2');
  const pending = nodes.form.dispatch('submit');
  await Promise.resolve();
  assert.equal(nodes.submit.disabled, true);
  assert.equal(nodes.submit.textContent, PROPOSE_TEXT.submitting);
  assert.equal(nodes.subject.readOnly, true);
  assert.equal(nodes.content.readOnly, true);
  assert.equal(nodes.reset.disabled, true);
  assert.equal(nodes.form.getAttribute('aria-busy'), 'true');
  await nodes.form.dispatch('submit');
  assert.equal(received.length, 1, '送出中重複按下不會再送出');
  resolveSubmit({ ticket_id: 'TK-123', route: 'HANDLER', department: '資訊管理一部', handler: { name: 'amy.chen' } });
  await pending;
  assert.deepEqual(received[0], { subject: ' 申請 Jira 專案存取權限 ', content: ' 需要編輯權限 ', handlerId: 'h-2' });
  assert.equal(nodes.resultDialog.open, true);
  assert.equal(nodes.resultSubject.textContent, '申請 Jira 專案存取權限');
  assert.equal(nodes.resultTicket.textContent, 'TK-123');
  assert.equal(nodes.resultTarget.textContent, 'amy.chen（資訊管理一部）');
  assert.equal(nodes.resultMethod.textContent, '已指定處理人，直接送達');
  assert.equal(nodes.resultNote.textContent, '需求單已送到指定處理人手上');
  assert.equal(nodes.resultBasisRow.hidden, true);
  assert.equal(nodes.submit.disabled, false);
  assert.equal(nodes.submit.textContent, PROPOSE_TEXT.submit);
  assert.equal(nodes.subject.readOnly, false);
  assert.equal(nodes.subject.value, '申請 Jira 專案存取權限'.length ? ' 申請 Jira 專案存取權限 ' : '', '關閉視窗前保留內容');
  await nodes.resultAgain.click();
  assert.equal(nodes.resultDialog.open, false);
  assert.equal(nodes.subject.value, '');
  assert.equal(nodes.content.value, '');
  assert.equal(nodes.handler.value, '');
  assert.equal(nodes.handlerSearch.value, '');
  assert.equal(nodes.handlerClear.hidden, true);
  assert.equal(nodes.handlerHint.hidden, true);
  assert.equal(nodes.subjectCount.textContent, '0 / 100');
  assert.equal(doc.activeElement, nodes.subject);
  nodes.subject.value = '申請辦公電腦';
  nodes.content.value = '新進同仁需要一台筆電';
  resolveSubmit = null;
  const second = nodes.form.dispatch('submit');
  await Promise.resolve();
  resolveSubmit({ ticket_id: 'TK-124', route: 'DEPARTMENT', department: '資訊管理二部', basis: '提到 ERP' });
  await second;
  assert.deepEqual(received[1], { subject: '申請辦公電腦', content: '新進同仁需要一台筆電', handlerId: '' });
  assert.equal(nodes.resultBasisRow.hidden, false);
  assert.equal(nodes.resultBasis.textContent, '提到 ERP');
  assert.equal(nodes.resultNote.textContent, '需求單已送往「資訊管理二部」簽核');
  await nodes.resultClose.click();
  assert.equal(nodes.subject.value, '');
}
test('成功送出鎖住表單、顯示結果並在關閉後清空', successfulSubmit);

/**
 * 驗證清除重填、登出與 pageshow 的登入檢查。
 * @returns {Promise<void>}
 */
async function resetAndLogout() {
  const { doc, win, nodes, auth, page } = mountPage();
  await page.ready;
  nodes.subject.value = 'x';
  nodes.content.value = 'y';
  nodes.subjectError.textContent = '殘留錯誤';
  nodes.submitError.textContent = '殘留錯誤';
  await nodes.reset.click();
  assert.equal(nodes.subject.value, '');
  assert.equal(nodes.content.value, '');
  assert.equal(nodes.subjectError.textContent, '');
  assert.equal(nodes.submitError.textContent, '');
  assert.equal(doc.activeElement, nodes.subject);
  win.events.get('pageshow')();
  assert.deepEqual(win.redirects, []);
  auth.user = { username: 'brian.lin', userID: 'user-brian.lin', department: { id: 'dept-it-1', name: '資訊管理一部' } };
  win.events.get('pageshow')();
  assert.equal(win.reloads, 1);
  auth.user = { username: 'amy.chen', userID: 'user-amy.chen', department: { id: 'dept-it-1', name: '資訊管理一部' } };
  await nodes.logout.click();
  assert.deepEqual(auth.calls, ['logout']);
  assert.deepEqual(win.redirects, ['./index.html']);
  assert.equal(doc.body.hidden, true);
  win.events.get('pageshow')();
  assert.equal(win.redirects.length, 2);
}
test('清除重填、登出與快取恢復時的登入檢查', resetAndLogout);

/**
 * 驗證從狀態追蹤頁「重新提出」帶入的草稿：填入主題與內容、更新字數並清除草稿；沒有草稿或儲存體不可用時表單為空。
 * @returns {Promise<void>}
 */
async function draftPrefill() {
  const stored = new Map([[DRAFT_KEY, JSON.stringify({ subject: '申請 VPN', content: '新人需要 VPN' })]]);
  const win = createFakeWindow();
  win.sessionStorage = {
    /** 讀草稿。@param {string} key 鍵。@returns {string|null} 值。 */
    getItem(key) { return stored.get(key) ?? null; },
    /** 清草稿。@param {string} key 鍵。@returns {void} */
    removeItem(key) { stored.delete(key); },
  };
  const doc = createFakeDocument();
  const nodes = buildProposeDom(doc);
  globalThis.document = doc;
  const page = initProposePage(doc, win, { auth: fakeAuth({ username: 'amy.chen', userID: 'user-amy.chen', department: { id: 'dept-it-1', name: '資訊管理一部' } }), loadDepartments: async () => departments });
  await page.ready;
  assert.equal(nodes.subject.value, '申請 VPN');
  assert.equal(nodes.content.value, '新人需要 VPN');
  assert.equal(nodes.subjectCount.textContent, '6 / 100');
  assert.equal(stored.has(DRAFT_KEY), false, '帶入後清除草稿');
  cleanup();
  const broken = createFakeWindow();
  broken.sessionStorage = { /** 模擬儲存體不可用。@returns {never} @throws {Error} 失敗。 */ getItem() { throw new Error('blocked'); } };
  const second = mountPage({}, broken);
  await second.page.ready;
  assert.equal(second.nodes.subject.value, '');
}
test('帶入重新提出的草稿', draftPrefill);
