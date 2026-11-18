import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createFakeWindow, buildProposeDom, fakeAuth } from './helpers/fakeDom.js';
import { initProposePage, PROPOSE_TEXT, describeAttached } from '../src/pages/propose.js';
import { normalizeDraftResponse } from '../src/services/draftService.js';
import { TicketServiceError, FORM_ERROR_MESSAGES, DRAFT_KEY } from '../src/services/ticketService.js';
import { completeLeaveResponse, completeGeneralResponse, generalResponse, tick, RENDERED, IT } from './helpers/draftFixtures.js';

const departments = [
  { id: IT.id, name: IT.name, type: '資訊', duty: '資訊服務', business: ['筆電'], handlers: [{ id: 'u-it-a', name: 'ivan.test' }] },
  { id: 'dept-hr-test', name: '測試人資部', type: '人資', duty: '人事', business: ['請假'], handlers: [{ id: 'u-hr-a', name: 'hana.test' }] },
];
const GENERAL_RENDERED = '[需求說明]: 筆電開機要五分鐘\n[處理部門]: 測試資訊部';

/**
 * 建立已登入的提出需求單頁，草稿、名單與送單服務都使用替身（不連網路）。
 * @param {object} [options={}] 設定。
 * @param {Function} [options.responder] 草稿替身的回應函式 (input) => 後端 JSON。
 * @param {Function} [options.submitTicket] 送單替身。
 * @param {object} [options.win] 視窗替身（可帶 sessionStorage 模擬「重新提出」的草稿），預設為新的視窗替身。
 * @param {Array<object>} [options.types=[]] 需求類型目錄替身（常見需求按鈕用）。
 * @returns {object} doc、win、nodes、page、draftCalls、submitted。
 */
function mountPage({ responder = leaveResponder, submitTicket, win = createFakeWindow(), types = [] } = {}) {
  const doc = createFakeDocument();
  globalThis.document = doc;
  const nodes = buildProposeDom(doc);
  const draftCalls = [];
  const submitted = [];
  /** 名單替身。@returns {Promise<object[]>} 部門。 */
  async function loadDepartments() { return departments; }
  /**
   * 草稿替身：記錄請求並整理回應。
   * @param {object} input 請求。
   * @returns {Promise<object>} 整理後的回應。
   */
  async function requestDraft(input) { draftCalls.push(structuredClone(input)); return normalizeDraftResponse(responder(input)); }
  /**
   * 預設送單替身：記錄送出內容並回 FORM 結果。
   * @param {object} input 送出內容。
   * @returns {Promise<object>} 送單結果。
   */
  async function defaultSubmit(input) { submitted.push(input); return { ticket_id: 'TK-T1', route: 'FORM', department: '測試人資部', basis: '依「請假申請」表單規則送達' }; }
  const auth = fakeAuth({ username: 'tina.test', userID: 'user-tina.test', department: { id: IT.id, name: IT.name } });
  const page = initProposePage(doc, win, { auth, loadDepartments, requestDraft, loadRequestTypes: /** 需求類型目錄替身（不連網路） @returns {Promise<object[]>} 需求類型 */ async () => types, draftDebounceMs: 0,
    submitTicket: submitTicket ? recordInto(submitted, submitTicket) : defaultSubmit });
  return { doc, win, nodes, page, draftCalls, submitted };
}

/**
 * 包裝送單替身，先記錄送出內容再交給原函式。
 * @param {Array<object>} list 記錄陣列。
 * @param {Function} handler 原送單替身。
 * @returns {Function} 包裝後的送單替身。
 */
function recordInto(list, handler) {
  /**
   * 記錄並轉交。
   * @param {object} input 送出內容。
   * @returns {Promise<object>} 原函式的結果。
   */
  async function wrapped(input) { list.push(input); return handler(input); }
  return wrapped;
}

/**
 * 請假替身：一律回已完成的請假內容（AI 從主題與訊息整理，intent 是 AI 寫的主題）
 * @returns {object} 後端 JSON。
 */
function leaveResponder() { return completeLeaveResponse({ intent: '12/1 請事假一天' }); }

/**
 * 一般需求替身：回已完成的一般需求；回應帶了指定處理人（模擬舊版後端），視窗也不採用。
 * @returns {object} 後端 JSON。
 */
function generalResponder() {
  return generalResponse({ department: IT, handler: { id: 'u-it-a', name: 'ivan.test' }, handler_options: [{ id: 'u-it-a', name: 'ivan.test' }],
    values: { description: '筆電開機要五分鐘' }, missing: [], complete: true, rendered_content: GENERAL_RENDERED });
}

/**
 * 輸入主題並觸發 input 事件。
 * @param {object} nodes 頁面節點。
 * @param {string} value 主題。
 * @returns {Promise<void>}
 */
async function typeSubject(nodes, value) {
  nodes.subject.value = value;
  await nodes.subject.dispatch('input');
}

/**
 * 還沒開始時把主題欄的文字（空白時用「我要申請」）當第一句話對助理說，等整理完成後按「套用到需求單」。
 * @param {object} mounted mountPage 的結果。
 * @returns {Promise<void>}
 */
async function openAndApply(mounted) {
  const { nodes, page } = mounted;
  if (!page.draftDialog.state.started) await page.draftDialog.start(nodes.subject.value.trim() || '我要申請');
  await tick();
  await page.draftDialog.settled();
  await nodes.draftNodes.apply.click();
}

/** 清除全域文件替身。@returns {void} */
function cleanup() { delete globalThis.document; }
test.afterEach(cleanup);

/**
 * 驗證對話優先的流程：一打開就能對助理說話、確認並送出先收起；第一句話只帶主題呼叫草稿服務；
 * 套用後主題帶入 AI 整理的主題、打開確認並送出；送出中不能重新開始；關閉結果視窗後收起確認並送出、助理重新問候
 * @returns {Promise<void>}
 */
async function chatFirstFlow() {
  let release;
  /**
   * 可控制完成時機的送單。
   * @returns {Promise<object>} 結果。
   */
  function submitTicket() {
    /**
     * 保存完成函式，讓測試決定送單何時完成。
     * @param {Function} resolve 完成函式。
     * @returns {void}
     */
    function hold(resolve) { release = resolve; }
    return new Promise(hold);
  }
  const mounted = mountPage({ submitTicket });
  const { nodes, page, draftCalls } = mounted;
  await page.ready;
  assert.equal(nodes.draftNodes.send.disabled, false, '一打開就可以對助理說話');
  assert.equal(nodes.confirmDialog.open, false, '確認並送出視窗先關著');
  assert.deepEqual(draftCalls, [], '還沒說話前不呼叫草稿服務');
  await page.draftDialog.start('我要請假');
  assert.deepEqual(draftCalls[0], { subject: '我要請假' });
  await page.draftDialog.settled();
  await nodes.draftNodes.apply.click();
  assert.equal(nodes.confirmDialog.open, true, '套用後彈出確認並送出視窗');
  assert.equal(nodes.subject.value, '12/1 請事假一天', '主題帶入 AI 整理的需求摘要，不是第一句話');
  assert.equal(nodes.subjectCount.textContent, '10 / 100');
  assert.equal(nodes.content.value, RENDERED);
  const pending = nodes.form.dispatch('submit');
  await Promise.resolve();
  assert.equal(nodes.reset.disabled, true, '送出中不能重新開始');
  release({ ticket_id: 'TK-1', route: 'DEPARTMENT', department: '測試人資部', basis: '提到請假' });
  await pending;
  await nodes.resultClose.click();
  assert.equal(nodes.confirmDialog.open, false, '送出後確認並送出視窗關著');
  assert.equal(page.draftDialog.state.started, false, '送出後助理重新問候');
}
test('對話優先：先說需求、套用後才確認並送出', chatFirstFlow);

/**
 * 驗證常見需求按鈕：依需求類型目錄每個類型一顆按鈕（說明放在 title），按下就用類型名稱當第一句話；開始後收起；目錄載入失敗時沒有按鈕、仍可打字。
 * @returns {Promise<void>}
 */
async function starterChips() {
  const mounted = mountPage({ types: [{ id: 'leave', name: '請假', summary: '事假、病假、特休' }, { id: 'vpn', name: 'VPN 申請', summary: '' }] });
  const { nodes, page, draftCalls } = mounted;
  await page.ready;
  const chips = nodes.draftNodes.starters.children;
  assert.deepEqual(chips.map(/** 取文字 @param {object} chip 按鈕 @returns {string} 文字 */ (chip) => chip.textContent), ['請假', 'VPN 申請']);
  assert.equal(chips[0].title, '事假、病假、特休');
  await chips[0].click();
  await page.draftDialog.settled();
  assert.deepEqual(draftCalls[0], { subject: '請假' });
  assert.equal(nodes.draftNodes.starters.hidden, true, '開始後收起常見需求');
  cleanup();
  const doc = createFakeDocument();
  globalThis.document = doc;
  const broken = buildProposeDom(doc);
  const logged = [];
  const originalError = console.error;
  /** 記錄主控台錯誤而不輸出 @param {...unknown} args 參數 @returns {void} */
  console.error = function capture(...args) { logged.push(args); };
  try {
    const failed = initProposePage(doc, createFakeWindow(), { auth: fakeAuth({ username: 'tina.test', userID: 'user-tina.test', department: { id: IT.id, name: IT.name } }),
      loadDepartments: /** 名單替身 @returns {Promise<object[]>} 部門 */ async () => departments,
      loadRequestTypes: /** 目錄載入失敗 @returns {Promise<never>} 失敗 */ async () => { throw new TicketServiceError('無法載入需求類型', { status: 503, code: 'UNAVAILABLE' }); } });
    await failed.ready;
  } finally { console.error = originalError; }
  assert.equal(broken.draftNodes.starters.children.length, 0, '目錄載入失敗時沒有按鈕');
  assert.equal(broken.draftNodes.send.disabled, false, '仍可直接打字');
  assert.equal(logged.length, 0, '已知的服務錯誤不寫主控台');
}
test('常見需求按鈕依需求類型目錄產生，按下就用類型名稱開始', starterChips);

/**
 * 驗證固定部門的類型（模擬請假）套用後：需求內容放入整理好的內容、字數更新、顯示「已由自動生成確認」提示（對話沒有指定處理人時只列部門）；
 * 送出帶 form（部門由類型固定，不帶 departmentId），handlerId 為空字串，結果視窗顯示依表單規則送達；關閉結果後清除提示與對話。
 * @returns {Promise<void>}
 */
async function leaveSubmit() {
  const mounted = mountPage();
  const { nodes, page, submitted } = mounted;
  await page.ready;
  await typeSubject(nodes, '我要請假');
  await openAndApply(mounted);
  assert.equal(nodes.content.value, RENDERED);
  assert.equal(nodes.contentCount.textContent, `${Array.from(RENDERED).length} / 2000`);
  assert.equal(nodes.formChip.hidden, false);
  assert.equal(nodes.formChipText.textContent, '已由服務台助理確認，將送達「測試人資部」');
  assert.equal(describeAttached('測試人資部'), nodes.formChipText.textContent);
  assert.equal(page.state.attached.handler, null, '對話沒有指定處理人');
  await nodes.form.dispatch('submit');
  assert.deepEqual(submitted[0], { subject: '我要請假', content: RENDERED, handlerId: '',
    form: { id: 'leave', version: 2, fields: { leave_type: '事假', start_at: '2026-12-01T09:30', end_at: '2026-12-01T17:30', agent: 'kevin.test', note: '' } } });
  assert.equal(nodes.resultDialog.open, true);
  assert.equal(nodes.resultTarget.textContent, '測試人資部');
  assert.equal(nodes.resultMethod.textContent, '依「請假申請」表單規則送達');
  assert.equal(nodes.resultBasisRow.hidden, true);
  await nodes.resultAgain.click();
  assert.equal(nodes.formChip.hidden, true);
  assert.equal(page.state.attached, null);
  assert.equal(nodes.draftNodes.log.children.length, 1, '送出後清除對話，只剩助理問候');
}
test('套用固定部門的類型後以 form 送出', leaveSubmit);

/**
 * 驗證沒有固定部門的類型（模擬一般需求）套用後：提示列以 describeAttached 只列出部門（不提供指定處理人，回應帶了也不採用）；
 * 送出帶 form、departmentId，handlerId 為空字串；結果視窗顯示「依 AI 對話確認部門」且不顯示判斷依據。
 * @returns {Promise<void>}
 */
async function generalSubmit() {
  /**
   * 回送達部門的 DEPARTMENT 結果。
   * @returns {Promise<object>} 送單結果。
   */
  async function submitTicket() { return { ticket_id: 'TK-T2', route: 'DEPARTMENT', department: IT.name, basis: '依 AI 對話確認送達' }; }
  const mounted = mountPage({ responder: generalResponder, submitTicket });
  const { nodes, page, submitted } = mounted;
  await page.ready;
  await typeSubject(nodes, '電腦很慢');
  await openAndApply(mounted);
  assert.equal(nodes.content.value, GENERAL_RENDERED);
  assert.equal(page.state.attached.handler, null, '不採用回應中的指定處理人');
  assert.equal(nodes.formChipText.textContent, '已由服務台助理確認，將送達「測試資訊部」');
  assert.equal(describeAttached(IT.name), nodes.formChipText.textContent);
  await nodes.form.dispatch('submit');
  assert.deepEqual(submitted[0], { subject: '電腦很慢', content: GENERAL_RENDERED, handlerId: '',
    form: { id: 'general', version: 1, fields: { description: '筆電開機要五分鐘' } }, departmentId: IT.id });
  assert.equal(nodes.resultTarget.textContent, '測試資訊部');
  assert.equal(nodes.resultMethod.textContent, '依 AI 對話確認部門');
  assert.equal(nodes.resultNote.textContent, '需求單已送往「測試資訊部」簽核');
  assert.equal(nodes.resultBasisRow.hidden, true);
}
test('套用沒有固定部門的類型後以 form 與 department_id 送出', generalSubmit);

/**
 * 驗證套用帶需求類型表單的草稿（模擬請假）後修改需求內容：在整理好的固定格式文字前、後補充說明（含 Windows 的 CRLF 換行）都允許且不提示；
 * 改掉固定文字時立即在需求內容下方顯示 PROPOSE_TEXT.fixedChanged 並標示 aria-invalid，但不解除套用（提示列與 attached 保留）；
 * 此時送出被阻止、不呼叫送單並把焦點移到需求內容；改回包含固定文字後清除提示，送出帶 form 與修改後的完整內容。
 * @returns {Promise<void>}
 */
async function fixedTextRules() {
  const mounted = mountPage();
  const { doc, nodes, page, submitted } = mounted;
  await page.ready;
  await typeSubject(nodes, '我要請假');
  await openAndApply(mounted);
  const attached = page.state.attached;
  for (const allowed of [`${RENDERED}\n補充：下午可遠端`, `前言：家中有事\n${RENDERED}`, `前言\r\n${RENDERED.replace(/\n/gu, '\r\n')}\r\n補充`]) {
    nodes.content.value = allowed;
    await nodes.content.dispatch('input');
    assert.equal(nodes.contentError.textContent, '', '保留固定格式文字時可在前後補充');
    assert.equal(nodes.content.getAttribute('aria-invalid'), null);
  }
  nodes.content.value = RENDERED.replace('事假', '病假');
  await nodes.content.dispatch('input');
  assert.equal(nodes.contentError.textContent, PROPOSE_TEXT.fixedChanged);
  assert.equal(nodes.content.getAttribute('aria-invalid'), 'true');
  assert.equal(nodes.formChip.hidden, false, '修改內容不解除套用');
  assert.equal(page.state.attached, attached);
  assert.equal(nodes.content.readOnly, false, '仍可繼續編輯');
  nodes.subject.focus();
  await nodes.form.dispatch('submit');
  assert.equal(submitted.length, 0, '改掉固定文字時不送出');
  assert.equal(nodes.contentError.textContent, PROPOSE_TEXT.fixedChanged);
  assert.equal(nodes.submitError.textContent, '');
  assert.equal(doc.activeElement, nodes.content);
  const fixed = `${RENDERED}\n補充：下午可遠端`;
  nodes.content.value = fixed;
  await nodes.content.dispatch('input');
  assert.equal(nodes.contentError.textContent, '');
  assert.equal(nodes.content.getAttribute('aria-invalid'), null);
  await nodes.form.dispatch('submit');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].content, fixed);
  assert.equal(submitted[0].form.id, 'leave');
  assert.equal(Object.hasOwn(submitted[0], 'departmentId'), false, '部門由類型固定時不帶 departmentId');
}
test('套用後保留固定格式文字才能送出', fixedTextRules);

/**
 * 未帶需求類型的一般需求草稿替身：後端回傳 type 為 null（理論上不會發生，模擬沒有需求類型表單的草稿）。
 * @returns {object} 後端 JSON。
 */
function untypedResponder() { return completeGeneralResponse({ type: null }); }

/**
 * 驗證沒有需求類型表單的草稿：套用後需求內容可任意修改（包含整段改寫）而不顯示固定格式提示；
 * 送出不帶 form，仍帶對話確認的 departmentId 與空的 handlerId，結果視窗依「自動生成」顯示「依 AI 對話確認部門」。
 * @returns {Promise<void>}
 */
async function untypedFreeEdit() {
  /** 回送到測試資訊部的 DEPARTMENT 結果。@returns {Promise<object>} 送單結果。 */
  async function submitTicket() { return { ticket_id: 'TK-T3', route: 'DEPARTMENT', department: IT.name, basis: '依 AI 對話確認送達' }; }
  const mounted = mountPage({ responder: untypedResponder, submitTicket });
  const { nodes, page, submitted } = mounted;
  await page.ready;
  await typeSubject(nodes, '電腦很慢');
  await openAndApply(mounted);
  assert.equal(page.state.attached.form, null);
  nodes.content.value = '完全改寫的需求內容';
  await nodes.content.dispatch('input');
  assert.equal(nodes.contentError.textContent, '', '沒有表單時可自由編輯');
  assert.equal(nodes.content.getAttribute('aria-invalid'), null);
  await nodes.form.dispatch('submit');
  assert.deepEqual(submitted[0], { subject: '電腦很慢', content: '完全改寫的需求內容', handlerId: '', departmentId: IT.id });
  assert.equal(nodes.resultMethod.textContent, '依 AI 對話確認部門');
  assert.equal(nodes.resultBasisRow.hidden, true);
}
test('沒有需求類型表單時套用後可自由編輯', untypedFreeEdit);

/**
 * 驗證狀態追蹤頁「重新提出」帶入的草稿：主題與原本內容填入頁面，但需求內容仍唯讀（尚未套用），並在 #form-notice 顯示 PROPOSE_TEXT.resubmit；
 * 主題放進對話輸入框等使用者送出；直接送出被阻止並提示 needDraft；對助理送出後因已有內容先顯示取代／附加選擇，選「附加在後」套用後原內容與整理好的內容並存、
 * 通知清除、需求內容可編輯，送出帶 form 與完整內容。
 * @returns {Promise<void>}
 */
async function resubmitDraft() {
  const stored = new Map([[DRAFT_KEY, JSON.stringify({ subject: '我要請假', content: '原本的請假說明', userID: 'user-tina.test' })]]);
  const win = createFakeWindow();
  win.sessionStorage = {
    /** 讀草稿。@param {string} key 鍵。@returns {string|null} 值。 */
    getItem(key) { return stored.get(key) ?? null; },
    /** 清草稿。@param {string} key 鍵。@returns {void} */
    removeItem(key) { stored.delete(key); },
  };
  const mounted = mountPage({ win });
  const { doc, nodes, page, submitted } = mounted;
  await page.ready;
  assert.equal(nodes.subject.value, '我要請假');
  assert.equal(nodes.content.value, '原本的請假說明');
  assert.equal(stored.has(DRAFT_KEY), false, '帶入後清除草稿');
  assert.equal(nodes.content.readOnly, true, '帶入的內容尚未套用，維持唯讀');
  assert.equal(nodes.content.classList.contains('is-locked'), true);
  assert.equal(nodes.formNotice.hidden, false);
  assert.equal(nodes.formNotice.textContent, PROPOSE_TEXT.resubmit);
  assert.equal(page.state.attached, null);
  assert.equal(nodes.draftNodes.message.value, '我要請假', '主題已放進對話輸入框，可以補充後送出');
  assert.equal(nodes.confirmDialog.open, true, '帶回的主題與內容先彈出視窗');
  nodes.submit.focus();
  await nodes.form.dispatch('submit');
  assert.equal(submitted.length, 0);
  assert.equal(nodes.submitError.textContent, PROPOSE_TEXT.needDraft);
  assert.equal(doc.activeElement, nodes.submit, '視窗開著時提示留在視窗裡，焦點不移到被遮住的對話區');
  await nodes.confirmBack.click();
  assert.equal(nodes.confirmDialog.open, false, '按返回修改回到對話');
  await openAndApply(mounted);
  assert.equal(nodes.draftNodes.applyChoice.hidden, false, '已有內容時先詢問取代或附加');
  assert.equal(page.state.attached, null);
  assert.equal(nodes.confirmDialog.open, false, '選取代或附加之前視窗不開');
  await nodes.draftNodes.append.click();
  assert.equal(nodes.confirmDialog.open, true, '選了附加在後才彈出視窗');
  const combined = `原本的請假說明\n\n${RENDERED}`;
  assert.equal(nodes.content.value, combined);
  assert.equal(nodes.subject.value, '我要請假', '帶回的主題不是自動帶入的，套用時保留');
  assert.equal(nodes.formNotice.hidden, true, '套用後清除重新提出的通知');
  assert.equal(nodes.formNotice.textContent, '');
  assert.equal(nodes.content.readOnly, false);
  assert.equal(nodes.submitError.textContent, '');
  await nodes.form.dispatch('submit');
  assert.equal(submitted[0].content, combined);
  assert.equal(submitted[0].form.id, 'leave');
}
test('重新提出的草稿帶入後仍需跟助理確認並套用', resubmitDraft);

/**
 * 驗證「確認並送出」視窗：返回修改與右上角關閉只關視窗，主題、內容與套用結果保留；再按套用時因已有內容先問取代或附加，選了才再彈出；
 * 送出中返回與關閉停用、Esc 不能關，送出成功後關掉視窗改開結果視窗
 * @returns {Promise<void>}
 */
async function confirmDialogFlow() {
  let release;
  /** 等測試放行的送單 @returns {Promise<object>} 送單結果 */
  function submitTicket() { return new Promise(/** 保存完成函式 @param {Function} resolve 完成 @returns {void} */ (resolve) => { release = resolve; }); }
  const mounted = mountPage({ submitTicket });
  const { nodes, page } = mounted;
  await page.ready;
  await page.draftDialog.start('我要請假');
  await openAndApply(mounted);
  assert.equal(nodes.confirmDialog.open, true);
  await nodes.confirmBack.click();
  assert.equal(nodes.confirmDialog.open, false, '返回修改關掉視窗');
  assert.deepEqual([nodes.subject.value, nodes.content.value, Boolean(page.state.attached)], ['12/1 請事假一天', RENDERED, true], '主題、內容與套用結果都保留');
  await nodes.draftNodes.apply.click();
  assert.equal(nodes.draftNodes.applyChoice.hidden, false, '已有內容時先問取代或附加');
  assert.equal(nodes.confirmDialog.open, false);
  await nodes.draftNodes.replace.click();
  assert.equal(nodes.confirmDialog.open, true, '選了取代才再彈出');
  await nodes.confirmClose.click();
  assert.equal(nodes.confirmDialog.open, false, '右上角關閉一樣只關視窗');
  await nodes.draftNodes.apply.click();
  await nodes.draftNodes.replace.click();
  let prevented = false;
  /** 記錄 Esc 是否被擋 @returns {void} */
  const preventDefault = () => { prevented = true; };
  await nodes.confirmDialog.dispatch('cancel', { preventDefault });
  assert.equal(prevented, false, '沒在送出時 Esc 可以關');
  const pending = nodes.form.dispatch('submit');
  await Promise.resolve();
  assert.deepEqual([nodes.confirmBack.disabled, nodes.confirmClose.disabled], [true, true], '送出中不能返回或關閉');
  await nodes.confirmDialog.dispatch('cancel', { preventDefault });
  assert.equal(prevented, true, '送出中 Esc 不能關');
  release({ ticket_id: 'TK-T2', route: 'FORM', department: '測試人資部', basis: '依「請假申請」表單規則送達' });
  await pending;
  assert.deepEqual([nodes.confirmDialog.open, nodes.resultDialog.open], [false, true], '送出成功後關掉確認視窗，改開結果視窗');
  assert.deepEqual([nodes.confirmBack.disabled, nodes.confirmClose.disabled], [false, false]);
}
test('確認並送出視窗：返回與關閉只關視窗、資料保留；送出中不能關；成功後改開結果視窗', confirmDialogFlow);

/**
 * AI 依訊息裡的日期寫主題；沒有訊息的回合沿用面板狀態的 intent
 * @param {object} input 請求
 * @returns {object} 後端 JSON
 */
function datedLeaveResponder(input) {
  if (!input.message) return completeLeaveResponse({ intent: input.state?.intent || '12/1 請事假一天' });
  return completeLeaveResponse({ intent: `${input.message.match(/\d+\/\d+/)[0]} 請事假一天` });
}

/**
 * 對助理送出一句話並等整理完成
 * @param {object} mounted mountPage 的結果
 * @param {string} text 訊息
 * @returns {Promise<void>}
 */
async function chat(mounted, text) {
  mounted.nodes.draftNodes.message.value = text;
  await mounted.nodes.draftNodes.chatForm.dispatch('submit');
  await mounted.page.draftDialog.settled();
}

/**
 * 驗證返回修改後再套用的主題：沒改過（還是上次自動帶入的值）就換成這次 AI 整理的主題，使用者改過就保留
 * @returns {Promise<void>}
 */
async function reapplySubject() {
  const mounted = mountPage({ responder: datedLeaveResponder });
  const { nodes, page } = mounted;
  await page.ready;
  await page.draftDialog.start('我要請假');
  await openAndApply(mounted);
  assert.equal(nodes.subject.value, '12/1 請事假一天');
  await nodes.confirmBack.click();
  await chat(mounted, '日期改成 12/2');
  await nodes.draftNodes.apply.click();
  await nodes.draftNodes.replace.click();
  assert.equal(nodes.subject.value, '12/2 請事假一天', '沒改過的主題換成這次整理的主題');
  assert.equal(nodes.subjectCount.textContent, '10 / 100');
  await nodes.confirmBack.click();
  await typeSubject(nodes, '12/2 請假（自己改的）');
  await chat(mounted, '日期改成 12/3');
  await nodes.draftNodes.apply.click();
  await nodes.draftNodes.replace.click();
  assert.equal(nodes.subject.value, '12/2 請假（自己改的）', '使用者改過的主題保留');
}
test('返回修改後再套用：沒改過的主題更新，改過的保留', reapplySubject);

/**
 * 驗證帶類型表單送出的 409：定義檔的檢查錯誤（代碼與訊息由後端提供，前端不認得特定代碼）顯示後端訊息並提示回「自動生成」調整，套用保留；
 * 表單版本變更時解除套用並清除對話，需求內容保留但回到唯讀，必須重新「自動生成」套用後才能再送出。
 * @returns {Promise<void>}
 */
async function leaveConflicts() {
  const failures = [
    new TicketServiceError('這段時間已有請假單', { status: 409, code: 'LEAVE_OVERLAP' }),
    new TicketServiceError('假別剩餘時數不足', { status: 409, code: 'SOME_FUTURE_CHECK' }),
    new TicketServiceError(FORM_ERROR_MESSAGES.FORM_VERSION_CHANGED, { status: 409, code: 'FORM_VERSION_CHANGED' }),
  ];
  /** 依序拋出排定的錯誤。@returns {Promise<never>} @throws {TicketServiceError} 排定的錯誤。 */
  async function submitTicket() { throw failures.shift(); }
  const mounted = mountPage({ submitTicket });
  const { nodes, page } = mounted;
  await page.ready;
  await typeSubject(nodes, '我要請假');
  await openAndApply(mounted);
  await nodes.form.dispatch('submit');
  assert.equal(nodes.submitError.textContent, `這段時間已有請假單\n${PROPOSE_TEXT.formHint}`);
  assert.equal(nodes.formChip.hidden, false);
  await nodes.form.dispatch('submit');
  assert.equal(nodes.submitError.textContent, `假別剩餘時數不足\n${PROPOSE_TEXT.formHint}`);
  await nodes.form.dispatch('submit');
  assert.equal(nodes.submitError.textContent, `${FORM_ERROR_MESSAGES.FORM_VERSION_CHANGED}\n${PROPOSE_TEXT.formChanged}`);
  assert.equal(nodes.formChip.hidden, true);
  assert.equal(page.state.attached, null);
  assert.equal(nodes.draftNodes.log.children.length, 1, '表單規則更新後清除對話，只剩助理問候');
  assert.equal(nodes.content.value, RENDERED, '需求內容保留');
  assert.equal(nodes.content.readOnly, true, '解除套用後回到唯讀');
  await nodes.form.dispatch('submit');
  assert.equal(nodes.submitError.textContent, PROPOSE_TEXT.needDraft, '解除後必須重新套用');
}
test('帶類型表單送出的 409 提示', leaveConflicts);

/**
 * 驗證重新開始會一併解除套用、清空主題與內容、收起確認並送出，對話只剩助理問候，常見需求按鈕重新出現。
 * @returns {Promise<void>}
 */
async function resetClears() {
  const mounted = mountPage();
  const { nodes, page } = mounted;
  await page.ready;
  await typeSubject(nodes, '我要請假');
  await openAndApply(mounted);
  await nodes.reset.click();
  assert.equal(nodes.formChip.hidden, true);
  assert.equal(page.state.attached, null);
  assert.equal(nodes.subject.value, '');
  assert.equal(nodes.confirmDialog.open, false, '確認並送出視窗關閉');
  assert.equal(nodes.draftNodes.log.children.length, 1, '只剩助理問候');
  assert.equal(nodes.draftNodes.starters.hidden, false, '常見需求按鈕重新出現');
}
test('重新開始解除套用並清除對話', resetClears);
