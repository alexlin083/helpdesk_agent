import { PAGE_URLS } from '../src/pageUrls.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createFakeWindow, buildProposeDom, pageIds, fakeAuth, DRAFT_DIALOG_IDS } from './helpers/fakeDom.js';
import { initProposePage, PROPOSE_TEXT } from '../src/pages/propose.js';
import { DRAFT_KEY } from '../src/services/ticketService.js';
import { fakeRequestDraft, completeGeneralResponse, fillAndApply, openAndApply, deferred, GENERAL_RENDERED, GENERAL_DESCRIPTION, IT } from './helpers/draftFixtures.js';

const departments = [
  { id: 'dept-it-1', name: '資訊管理一部', type: '資訊', duty: 'IT資訊服務台', business: ['VPN'], handlers: [{ id: 'h-1', name: 'racky.huang' }, { id: 'h-2', name: 'amy.chen' }] },
  { id: 'dept-ga-1', name: '總務與硬體組', type: '', duty: '報修', business: ['報修'], handlers: [] },
];

/**
 * 建立已登入的頁面環境，名單、送單與「自動生成」草稿服務可由測試指定。
 * 「自動生成」預設使用一般需求已完成的草稿替身（不連網路、驗證不延遲），讓測試可以先套用草稿再送出。
 * @param {object} [services={}] loadDepartments、submitTicket 與 requestDraft 等替身，會覆寫預設值。
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
  const page = initProposePage(doc, win, { auth, loadDepartments, requestDraft: fakeRequestDraft(), draftDebounceMs: 0, ...services });
  return { doc, win, nodes, auth, page };
}
/** 清除全域文件替身。@returns {void} */
function cleanup() { delete globalThis.document; }
test.afterEach(cleanup);

/**
 * 驗證 propose.html 具備頁面腳本依賴的所有節點 id（含需求內容下方的 #content-hint），
 * 並確認已移除的頁面層級指定處理人選單（#handler 系列）與「移除」按鈕（#form-remove）不再出現；處理人只在「自動生成」視窗內指定。
 * @returns {void}
 */
function pageStructure() {
  const ids = pageIds(new URL('../pages/propose/propose.html', import.meta.url));
  const required = ['account-avatar', 'account-name', 'account-id', 'logout-button', 'list-notice', 'ticket-form', 'subject', 'subject-count', 'subject-error',
    'content', 'content-count', 'content-hint', 'content-error', 'reset-button', 'submit-button', 'submit-error', 'departments-button',
    'departments-dialog', 'departments-close', 'departments-list', 'result-dialog', 'result-subject', 'result-ticket', 'result-target', 'result-method',
    'result-basis-row', 'result-basis', 'result-note', 'result-close', 'result-again',
    'draft-button', 'draft-button-hint', 'form-chip', 'form-chip-text', 'form-notice', ...DRAFT_DIALOG_IDS];
  for (const id of required) assert.ok(ids.has(id), `propose.html 缺少 #${id}`);
  for (const id of ['handler', 'handler-picker', 'handler-search', 'handler-clear', 'handler-listbox', 'handler-hint', 'form-remove']) {
    assert.equal(ids.has(id), false, `propose.html 不應再有 #${id}`);
  }
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
  assert.deepEqual(win.redirects, [PAGE_URLS.login]);
  assert.equal(doc.body.hidden, true);
  assert.deepEqual(auth.calls, ['logout']);
}
test('未登入直接開啟提出需求單頁會回到登入頁', requiresLogin);

/**
 * 驗證部門資訊載入中與成功兩種狀態：帳號顯示、字數初始值、載入中「查看各部門業務範圍」停用，成功後啟用並產生部門卡片、可開關部門視窗。
 * 頁面已沒有指定處理人選單，部門資訊只供業務範圍視窗使用。
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
  assert.equal(nodes.departmentsButton.disabled, true);
  assert.equal(nodes.notice.hidden, true, '載入中不顯示提示');
  assert.equal(nodes.subjectCount.textContent, '0 / 100');
  assert.equal(nodes.contentCount.textContent, '0 / 2000');
  resolveList(departments);
  await page.ready;
  assert.equal(page.state.listState, 'ready');
  assert.equal(nodes.departmentsButton.disabled, false);
  assert.equal(nodes.notice.hidden, true);
  assert.deepEqual(nodes.departmentsList.querySelectorAll('.department-name').map((node) => node.textContent), ['資訊管理一部', '總務與硬體組']);
  await nodes.departmentsButton.click();
  assert.equal(nodes.departmentsDialog.open, true);
  await nodes.departmentsClose.click();
  assert.equal(nodes.departmentsDialog.open, false);
}
test('部門資訊載入中與成功狀態與部門視窗', listStates);

/**
 * 驗證送出前的欄位驗證：尚未套用「自動生成」時只標示主題錯誤（需求內容唯讀且為空，不標示「請填寫需求內容」，也不先顯示「請先自動生成」），
 * 焦點移到主題；輸入主題時清除錯誤並更新字數。套用後在整理好的內容後補充到超過字數上限時，顯示字數錯誤並把焦點移到需求內容、不送出；
 * 改回正常長度時清除字數警示與錯誤。
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
  assert.equal(nodes.contentError.textContent, '', '尚未套用時不標示需求內容錯誤');
  assert.equal(nodes.content.getAttribute('aria-invalid'), null);
  assert.equal(nodes.subject.getAttribute('aria-invalid'), 'true');
  assert.equal(nodes.submitError.textContent, '', '主題有錯時先修正主題');
  assert.equal(doc.activeElement, nodes.subject);
  assert.equal(calls, 0);
  nodes.subject.value = '申請 VPN 帳號';
  await nodes.subject.dispatch('input');
  assert.equal(nodes.subjectError.textContent, '');
  assert.equal(nodes.subject.getAttribute('aria-invalid'), null);
  assert.equal(nodes.subjectCount.textContent, '9 / 100');
  await openAndApply(nodes, page);
  const filler = 'a'.repeat(2001 - Array.from(GENERAL_RENDERED).length - 1);
  nodes.content.value = `${GENERAL_RENDERED}\n${filler}`;
  await nodes.content.dispatch('input');
  assert.equal(nodes.contentCount.textContent, '2001 / 2000');
  assert.equal(nodes.contentCount.classList.contains('over-limit'), true);
  assert.equal(nodes.contentError.textContent, '', '保留固定格式文字時不提示');
  await nodes.form.dispatch('submit');
  assert.equal(nodes.subjectError.textContent, '');
  assert.equal(nodes.contentError.textContent, '需求內容最多 2000 字，目前 2001 字');
  assert.equal(nodes.content.getAttribute('aria-invalid'), 'true');
  assert.equal(doc.activeElement, nodes.content);
  assert.equal(calls, 0);
  nodes.content.value = `${GENERAL_RENDERED}\n新進同仁需要 VPN 連線權限`;
  await nodes.content.dispatch('input');
  assert.equal(nodes.contentCount.classList.contains('over-limit'), false);
  assert.equal(nodes.contentError.textContent, '');
}
test('送出前的欄位驗證與輸入時清除錯誤', formValidation);

/**
 * 驗證尚未套用「自動生成」就送出：不呼叫送單，在送出區顯示 PROPOSE_TEXT.needDraft 並把焦點移到「自動生成」按鈕；
 * 主題有值但「自動生成」按鈕仍停用時（例如自動填入未觸發 input 事件）改把焦點放在主題；需求內容空白的錯誤不顯示；
 * 主題超過字數上限時照常顯示主題錯誤，且不同時顯示 needDraft；修改主題時清除送出區提示。
 * @returns {Promise<void>}
 */
async function needDraftBeforeSubmit() {
  let calls = 0;
  /** 不應被呼叫。@returns {Promise<object>} 結果。 */
  async function submitTicket() { calls += 1; return {}; }
  const { doc, nodes, page } = mountPage({ submitTicket });
  await page.ready;
  nodes.subject.value = '申請 VPN 帳號';
  await nodes.subject.dispatch('input');
  assert.equal(nodes.draftButton.disabled, false);
  await nodes.form.dispatch('submit');
  assert.equal(calls, 0, '未套用時不送出');
  assert.equal(nodes.submitError.textContent, PROPOSE_TEXT.needDraft);
  assert.equal(nodes.subjectError.textContent, '');
  assert.equal(nodes.contentError.textContent, '', '不標示需求內容空白');
  assert.equal(nodes.content.getAttribute('aria-invalid'), null);
  assert.equal(doc.activeElement, nodes.draftButton);
  nodes.subject.value = '申請 VPN 帳號（修改）';
  await nodes.subject.dispatch('input');
  assert.equal(nodes.submitError.textContent, '', '修改主題時清除送出區提示');
  nodes.subject.value = 'a'.repeat(101);
  await nodes.subject.dispatch('input');
  await nodes.form.dispatch('submit');
  assert.equal(nodes.subjectError.textContent, '主題最多 100 字，目前 101 字');
  assert.equal(nodes.submitError.textContent, '', '主題有錯時先顯示主題錯誤');
  assert.equal(doc.activeElement, nodes.subject);
  assert.equal(calls, 0);
  cleanup();
  const silent = mountPage({ submitTicket });
  await silent.page.ready;
  silent.nodes.subject.value = '申請 VPN 帳號';
  assert.equal(silent.nodes.draftButton.disabled, true, '沒有 input 事件時按鈕仍停用');
  await silent.nodes.form.dispatch('submit');
  assert.equal(calls, 0);
  assert.equal(silent.nodes.submitError.textContent, PROPOSE_TEXT.needDraft);
  assert.equal(silent.doc.activeElement, silent.nodes.subject, '自動生成停用時焦點放在主題');
}
test('尚未套用自動生成時不送出並提示', needDraftBeforeSubmit);

/**
 * 驗證需求內容的唯讀狀態：初始唯讀、顯示 PROPOSE_TEXT.contentLocked 說明並加上 is-locked 樣式；按 Apply 套用後可編輯、移除樣式與說明；
 * 送出中再次唯讀（仍屬已套用，不加 is-locked）；送出完成後恢復可編輯；關閉結果視窗清空表單後回到唯讀與說明文字。
 * @returns {Promise<void>}
 */
async function contentLock() {
  const submission = deferred();
  /** 可控制完成時機的送單。@returns {Promise<object>} 結果。 */
  function submitTicket() { return submission.promise; }
  const { nodes, page } = mountPage({ submitTicket });
  await page.ready;
  assert.equal(nodes.content.readOnly, true);
  assert.equal(nodes.content.placeholder, PROPOSE_TEXT.contentLocked);
  assert.equal(nodes.content.classList.contains('is-locked'), true);
  await fillAndApply(nodes, page, '電腦很慢');
  assert.equal(nodes.content.value, GENERAL_RENDERED);
  assert.equal(nodes.content.readOnly, false, '套用後可做最後編輯');
  assert.equal(nodes.content.placeholder, '');
  assert.equal(nodes.content.classList.contains('is-locked'), false);
  const pending = nodes.form.dispatch('submit');
  await Promise.resolve();
  assert.equal(nodes.content.readOnly, true, '送出中唯讀');
  assert.equal(nodes.content.classList.contains('is-locked'), false);
  submission.resolve({ ticket_id: 'TK-9', route: 'DEPARTMENT', department: IT.name });
  await pending;
  assert.equal(nodes.content.readOnly, false, '送出完成後恢復可編輯');
  await nodes.resultClose.click();
  assert.equal(nodes.content.value, '');
  assert.equal(nodes.content.readOnly, true, '清空後回到唯讀');
  assert.equal(nodes.content.placeholder, PROPOSE_TEXT.contentLocked);
  assert.equal(nodes.content.classList.contains('is-locked'), true);
}
test('需求內容在套用前與送出中唯讀', contentLock);

/**
 * 以主題決定一般需求草稿是否帶處理人：主題含「Jira」時模擬舊版後端在回應帶了 amy.chen（視窗不採用），其他主題不帶處理人。
 * @param {{subject: string}} input 草稿請求本文。
 * @returns {object} 後端 JSON。
 */
function handlerBySubject(input) {
  if (!input.subject.includes('Jira')) return completeGeneralResponse();
  return completeGeneralResponse({ handler: { id: 'h-2', name: 'amy.chen' }, handler_options: [{ id: 'h-1', name: 'racky.huang' }, { id: 'h-2', name: 'amy.chen' }] });
}

/**
 * 驗證成功送出：套用「自動生成」後提示列只列出部門（回應帶了處理人也不採用）；送出中鎖住表單且重複按下不會再送出；
 * 送出內容一律來自套用的草稿（form、departmentId，handlerId 為空字串）；結果視窗依「自動生成」顯示「依 AI 對話確認部門」且不顯示判斷依據；
 * 關閉後清空表單、解除套用並把焦點放回主題，第二張單同樣送出。
 * @returns {Promise<void>}
 */
async function successfulSubmit() {
  let resolveSubmit;
  const received = [];
  /** 可控制完成時機的送單。@param {object} input 表單內容。@returns {Promise<object>} 結果。 */
  function submitTicket(input) { received.push(input); return new Promise((resolve) => { resolveSubmit = resolve; }); }
  const { doc, nodes, page } = mountPage({ submitTicket, requestDraft: fakeRequestDraft(handlerBySubject) });
  await page.ready;
  await fillAndApply(nodes, page, ' 申請 Jira 專案存取權限 ');
  assert.equal(nodes.formChip.hidden, false);
  assert.equal(nodes.formChipText.textContent, `已由自動生成確認，將送達「${IT.name}」`, '不提供指定處理人');
  nodes.content.value = `${GENERAL_RENDERED}\n 需要編輯權限 `;
  await nodes.content.dispatch('input');
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
  resolveSubmit({ ticket_id: 'TK-123', route: 'DEPARTMENT', department: IT.name, basis: '依 AI 對話確認送達' });
  await pending;
  assert.deepEqual(received[0], { subject: ' 申請 Jira 專案存取權限 ', content: `${GENERAL_RENDERED}\n 需要編輯權限 `, handlerId: '',
    form: { id: 'general', version: 1, fields: { description: GENERAL_DESCRIPTION } }, departmentId: IT.id });
  assert.equal(nodes.resultDialog.open, true);
  assert.equal(nodes.resultSubject.textContent, '申請 Jira 專案存取權限');
  assert.equal(nodes.resultTicket.textContent, 'TK-123');
  assert.equal(nodes.resultTarget.textContent, IT.name);
  assert.equal(nodes.resultMethod.textContent, '依 AI 對話確認部門');
  assert.equal(nodes.resultNote.textContent, `需求單已送往「${IT.name}」簽核`);
  assert.equal(nodes.resultBasisRow.hidden, true);
  assert.equal(nodes.submit.disabled, false);
  assert.equal(nodes.submit.textContent, PROPOSE_TEXT.submit);
  assert.equal(nodes.subject.readOnly, false);
  assert.equal(nodes.subject.value, ' 申請 Jira 專案存取權限 ', '關閉視窗前保留內容');
  await nodes.resultAgain.click();
  assert.equal(nodes.resultDialog.open, false);
  assert.equal(nodes.subject.value, '');
  assert.equal(nodes.content.value, '');
  assert.equal(nodes.formChip.hidden, true);
  assert.equal(page.state.attached, null);
  assert.equal(nodes.subjectCount.textContent, '0 / 100');
  assert.equal(doc.activeElement, nodes.subject);
  await fillAndApply(nodes, page, '申請辦公電腦');
  assert.equal(nodes.formChipText.textContent, `已由自動生成確認，將送達「${IT.name}」`);
  resolveSubmit = null;
  const second = nodes.form.dispatch('submit');
  await Promise.resolve();
  resolveSubmit({ ticket_id: 'TK-124', route: 'DEPARTMENT', department: IT.name, basis: '提到 ERP' });
  await second;
  assert.deepEqual(received[1], { subject: '申請辦公電腦', content: GENERAL_RENDERED, handlerId: '',
    form: { id: 'general', version: 1, fields: { description: GENERAL_DESCRIPTION } }, departmentId: IT.id });
  assert.equal(nodes.resultMethod.textContent, '依 AI 對話確認部門');
  assert.equal(nodes.resultBasisRow.hidden, true, '依自動生成送出不顯示判斷依據');
  assert.equal(nodes.resultNote.textContent, `需求單已送往「${IT.name}」簽核`);
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
  assert.deepEqual(win.redirects, [PAGE_URLS.login]);
  assert.equal(doc.body.hidden, true);
  win.events.get('pageshow')();
  assert.equal(win.redirects.length, 2);
}
test('清除重填、登出與快取恢復時的登入檢查', resetAndLogout);

/**
 * 驗證從狀態追蹤頁「重新提出」帶入的草稿：填入主題與內容、更新字數並清除草稿；沒有草稿或儲存體不可用時表單為空；
 * 草稿的 userID 不是目前登入者（含沒有 userID 的舊格式）時不帶入，且同樣從儲存體移除。
 * @returns {Promise<void>}
 */
async function draftPrefill() {
  const stored = new Map([[DRAFT_KEY, JSON.stringify({ subject: '申請 VPN', content: '新人需要 VPN', userID: 'user-amy.chen' })]]);
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
  cleanup();
  for (const foreign of [{ subject: '別人的單', content: '上一位帳號的內容', userID: 'user-brian.lin' }, { subject: '舊格式', content: '沒有記錄提單人' }]) {
    stored.set(DRAFT_KEY, JSON.stringify(foreign));
    const other = mountPage({}, win);
    await other.page.ready;
    assert.equal(other.nodes.subject.value, '', `${foreign.subject} 不帶入目前帳號的表單`);
    assert.equal(other.nodes.content.value, '');
    assert.equal(stored.has(DRAFT_KEY), false, '不屬於目前帳號的草稿也會清除');
    cleanup();
  }
}
test('帶入重新提出的草稿', draftPrefill);
