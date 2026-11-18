import { authService } from '../services/authService.js';
import { loadDepartments, submitTicket, validateTicketInput, countCodePoints, TICKET_LIMITS, TicketServiceError, QUOTA_CODES, DRAFT_KEY } from '../services/ticketService.js';
import { renderDepartmentCards, renderTicketResult } from '../components/propose/dialogs.js';
import { initAccountMenu } from '../components/account.js';
import { createDraftDialog } from '../components/propose/draftDialog.js';
import { requestDraft, loadRequestTypes } from '../services/draftService.js';
import { PAGE_URLS } from '../pageUrls.js';

export const PROPOSE_TEXT = {
  notice: '無法載入部門資訊，「各部門業務範圍」暫時無法使用；仍可直接跟助理說需求',
  submit: '送出需求單',
  submitting: '送出中…',
  unexpected: '發生未預期的錯誤，請稍後再試',
  attached: '已由服務台助理確認，將送達「{department}」',
  attachedHandler: '已由服務台助理確認，將送達「{department}」的 {handler}',
  contentLocked: '先在左邊跟助理說需求；整理好後按「套用到需求單」，內容會出現在這裡，再做最後編輯',
  needDraft: '請先跟助理確認需求內容與處理部門，按「套用到需求單」後再送出',
  fixedChanged: '需求內容必須保留助理整理的固定格式文字（可以在前後補充說明）；要修改欄位請在需求單面板或跟助理調整後重新套用',
  resubmit: '已帶入被退回需求單的主題與原本內容；按「返回修改」回到對話，主題已放在輸入框，補充說明後送出，助理會重新確認，套用時可選擇取代或附加在原內容後',
  formHint: '可跟助理調整內容後再送出',
  formChanged: '對話與欄位已清除，請重新跟助理確認',
};

/**
 * 組出套用助理整理的內容後顯示在需求內容下方的提示；對話中有指定處理人時一併列出。
 * @param {string} department 確認的處理部門名稱。
 * @param {string} [handler=''] 對話中指定的處理人帳號；空字串代表不指定。
 * @returns {string} 例如「已由服務台助理確認，將送達「人力資源部」」。
 */
export function describeAttached(department, handler = '') {
  const template = handler ? PROPOSE_TEXT.attachedHandler : PROPOSE_TEXT.attached;
  return template.replace('{department}', department).replace('{handler}', handler);
}
const MAX_COUNTDOWN_SECONDS = 300;

/**
 * 初始化提出需求單頁：檢查登入、載入部門資訊（業務範圍視窗用）與常見需求按鈕（需求類型目錄）、綁定表單驗證、送出、倒數、結果視窗、部門視窗與助理對話區。
 * 頁面一打開就是助理對話：助理先問想申請什麼，使用者的第一句話當主題交給後端判斷需求類型（見 draftDialog.js），之後的流程不變；
 * 需求內容只由對話區帶入：套用前唯讀，按「套用到需求單」後保存 attached（需求類型表單、對話確認的部門、處理人與後端整理的內容），
 * 彈出「確認並送出」視窗，主題沒填或沒改過時帶入 AI 整理的主題（AI 沒寫過時是第一句話），開放最後編輯；送出時一定帶對話確認的部門（部門由類型固定時改帶 form），頁面不提供指定處理人
 * 需求內容必須保留整理好的固定格式文字（所有需求類型都帶 form 送出，後端同樣檢查），可以在前後補充說明；改掉固定文字時提示並阻止送出，不會改用其他方式送出。
 * @param {Document} [doc=document] 頁面文件，測試可注入替身。
 * @param {Window} [win=window] 視窗物件，提供導頁、計時器、confirm 與 pageshow 事件。
 * @param {object} [services={}] 可注入的服務替身。
 * @param {object} [services.auth=authService] 登入服務。
 * @param {Function} [services.loadDepartments=loadDepartments] 部門資訊載入函式。
 * @param {Function} [services.submitTicket=submitTicket] 需求單送出函式。
 * @param {Function} [services.requestDraft=requestDraft] 草稿函式（POST /api/tickets/draft）。
 * @param {Function} [services.loadRequestTypes=loadRequestTypes] 需求類型目錄（GET /api/forms），用來產生常見需求按鈕。
 * @param {number} [services.draftDebounceMs=400] 面板手動修改後送出驗證前的等待毫秒數（測試可設為 0）。
 * @returns {object|null} 頁面控制器（submit、reset、remainingWait、ready、draftDialog 等），未登入導回登入頁時回傳 null。
 */
export function initProposePage(doc = document, win = window, services = {}) {
  /**
   * 讀取並清除狀態追蹤頁「重新提出」留下的草稿；不論是否採用，讀到後一律從儲存體移除。
   * 草稿記錄的 userID 必須等於目前登入者，否則（含沒有記錄 userID 的舊格式）視為其他帳號留下的內容而捨棄。
   * 儲存體不可用或內容不是物件時視為沒有草稿。
   * @param {string} ownerID 目前登入者的 userID。
   * @returns {{subject: string, content: string}|null} 屬於目前登入者的草稿，沒有時為 null。
   */
  function takeDraft(ownerID) {
    try {
      const raw = win.sessionStorage?.getItem(DRAFT_KEY);
      if (!raw) return null;
      win.sessionStorage.removeItem(DRAFT_KEY);
      const draft = JSON.parse(raw);
      if (!draft || typeof draft !== 'object' || draft.userID !== ownerID) return null;
      return { subject: typeof draft.subject === 'string' ? draft.subject : '', content: typeof draft.content === 'string' ? draft.content : '' };
    } catch { return null; }
  }
  const auth = services.auth ?? authService;
  const fetchDepartments = services.loadDepartments ?? loadDepartments;
  const sendTicket = services.submitTicket ?? submitTicket;
  const fetchDraft = services.requestDraft ?? requestDraft;
  const fetchTypes = services.loadRequestTypes ?? loadRequestTypes;
  const { user, leave, checkSession } = initAccountMenu(doc, win, auth);
  if (!user) return null;

  const nodes = {
    notice: doc.querySelector('#list-notice'), form: doc.querySelector('#ticket-form'), confirmDialog: doc.querySelector('#confirm-dialog'),
    confirmClose: doc.querySelector('#confirm-close'), confirmBack: doc.querySelector('#confirm-back'),
    subject: doc.querySelector('#subject'), subjectCount: doc.querySelector('#subject-count'), subjectError: doc.querySelector('#subject-error'),
    content: doc.querySelector('#content'), contentCount: doc.querySelector('#content-count'), contentError: doc.querySelector('#content-error'),
    reset: doc.querySelector('#reset-button'), submit: doc.querySelector('#submit-button'), submitError: doc.querySelector('#submit-error'),
    starters: doc.querySelector('#draft-starters'), formChip: doc.querySelector('#form-chip'), formChipText: doc.querySelector('#form-chip-text'),
    formNotice: doc.querySelector('#form-notice'),
    departmentsButton: doc.querySelector('#departments-button'), departmentsDialog: doc.querySelector('#departments-dialog'),
    departmentsClose: doc.querySelector('#departments-close'), departmentsList: doc.querySelector('#departments-list'),
    resultDialog: doc.querySelector('#result-dialog'), resultClose: doc.querySelector('#result-close'), resultAgain: doc.querySelector('#result-again'),
    result: { subject: doc.querySelector('#result-subject'), ticket: doc.querySelector('#result-ticket'), target: doc.querySelector('#result-target'),
      method: doc.querySelector('#result-method'), basisRow: doc.querySelector('#result-basis-row'), basis: doc.querySelector('#result-basis'), note: doc.querySelector('#result-note') },
  };
  const state = { submitting: false, waitUntil: 0, waitTimer: null, listState: 'loading', departments: [], attached: null, autoSubject: '' };
  /**
   * 依 id 取得對話區的節點。
   * @param {string} id 元素 id（不含 #）。
   * @returns {HTMLElement|null} 節點。
   */
  function byId(id) { return doc.querySelector(`#${id}`); }
  const draftDialog = createDraftDialog({
    log: byId('draft-log'), typing: byId('draft-typing'), chatForm: byId('draft-chat-form'),
    message: byId('draft-message'), messageCount: byId('draft-message-count'), send: byId('draft-send'), departmentField: byId('draft-department-field'),
    departmentSelect: byId('draft-department'), departmentSource: byId('draft-department-source'), departmentStatus: byId('draft-department-status'),
    fieldList: byId('draft-field-list'), computed: byId('draft-computed'), summaries: byId('draft-summaries'), prompt: byId('draft-prompt'), error: byId('draft-error'),
    applyChoice: byId('draft-apply-choice'), replace: byId('draft-replace'), append: byId('draft-append'), choiceCancel: byId('draft-choice-cancel'),
    apply: byId('draft-apply'), starters: nodes.starters, empty: byId('draft-empty'),
  }, {
    user, requestDraft: fetchDraft, win, debounceMs: services.draftDebounceMs ?? 400,
    getContent: readContent, onApply: handleDraftApply, onLoginRequired: leave, connectionsUrl: PAGE_URLS.connections,
  });

  /**
   * 依部門資訊狀態更新「查看各部門業務範圍」按鈕與表單上方提示：載入中與失敗時按鈕停用（失敗另顯示原因），成功時產生部門卡片。
   * 部門資訊只供業務範圍視窗使用；處理部門與處理人都在對話區確認，載入失敗不影響提出需求單。
   * @param {'loading'|'ready'|'failed'} listState 部門資訊狀態。
   * @param {Array<object>|string} [payload] 成功時為部門陣列，失敗時為原因文字。
   * @returns {void}
   */
  function setListState(listState, payload) {
    state.listState = listState;
    if (listState === 'loading') {
      nodes.departmentsButton.disabled = true;
      nodes.notice.hidden = true;
      nodes.notice.textContent = '';
      return;
    }
    if (listState === 'failed') {
      nodes.departmentsButton.disabled = true;
      nodes.notice.textContent = `${PROPOSE_TEXT.notice}原因：${payload}`;
      nodes.notice.hidden = false;
      return;
    }
    state.departments = payload;
    renderDepartmentCards(nodes.departmentsList, payload);
    nodes.departmentsButton.disabled = false;
    nodes.notice.hidden = true;
    nodes.notice.textContent = '';
  }

  /**
   * 載入部門資訊；憑證失效時回登入頁，其他失敗維持業務範圍按鈕停用並在表單上方顯示原因。
   * @returns {Promise<void>}
   */
  async function loadList() {
    setListState('loading');
    try {
      setListState('ready', await fetchDepartments());
    } catch (error) {
      if (error?.status === 401 || error?.code === 'LOGIN_REQUIRED') { leave(); return; }
      if (!(error instanceof TicketServiceError)) console.error(error);
      setListState('failed', error instanceof TicketServiceError ? error.message : PROPOSE_TEXT.unexpected);
    }
  }

  /**
   * 更新主題或需求內容的字數提示；超過上限時加上警示樣式。
   * @param {'subject'|'content'} field 欄位名稱。
   * @returns {void}
   */
  function updateCount(field) {
    const count = countCodePoints(nodes[field].value);
    const counter = nodes[`${field}Count`];
    counter.textContent = `${count} / ${TICKET_LIMITS[field]}`;
    counter.classList.toggle('over-limit', count > TICKET_LIMITS[field]);
  }

  /**
   * 需求內容是否仍保留套用的固定格式文字；所有需求類型（含一般需求）都要保留，只有完全沒有需求類型的套用結果（理論上不會發生）不檢查。
   * @returns {boolean} 可以送出時 true。
   */
  function keepsFixedText() {
    if (!state.attached?.form) return true;
    return nodes.content.value.replace(/\r\n?/gu, '\n').includes(state.attached.rendered);
  }

  /**
   * 依目前狀態決定需求內容是否可編輯：送出中或尚未套用助理整理的內容時唯讀，並顯示說明文字。
   * @returns {void}
   */
  function syncContentLock() {
    const locked = state.submitting || !state.attached;
    nodes.content.readOnly = locked;
    nodes.content.placeholder = state.attached ? '' : PROPOSE_TEXT.contentLocked;
    nodes.content.classList.toggle('is-locked', !state.attached);
  }

  /**
   * 輸入時更新字數並清掉該欄與送出區的錯誤提示；需求內容改到不再包含固定格式文字時立即提示（不解除套用，送出時阻止）。
   * @param {'subject'|'content'} field 欄位名稱。
   * @returns {void}
   */
  function handleInput(field) {
    updateCount(field);
    nodes[`${field}Error`].textContent = '';
    nodes[field].removeAttribute('aria-invalid');
    nodes.submitError.textContent = '';
    if (field === 'content' && !keepsFixedText()) {
      nodes.contentError.textContent = PROPOSE_TEXT.fixedChanged;
      nodes.content.setAttribute('aria-invalid', 'true');
    }
  }

  /** 取得頁面上的需求內容（供對話區判斷取代或附加）。@returns {string} 需求內容。 */
  function readContent() { return nodes.content.value; }

  /**
   * 依目前套用狀態顯示或隱藏需求內容下方的「已由服務台助理確認」提示列，並顯示（或清除）通知；同時更新需求內容是否可編輯。
   * 「確認並送出」視窗的開關見 openConfirm、closeConfirm
   * @param {string} [notice=''] 要顯示的通知；空字串代表隱藏。
   * @returns {void}
   */
  function renderAttached(notice = '') {
    nodes.formChipText.textContent = state.attached ? describeAttached(state.attached.department.name, state.attached.handler?.name ?? '') : '';
    nodes.formChip.hidden = !state.attached;
    nodes.formNotice.textContent = notice;
    nodes.formNotice.hidden = !notice;
    syncContentLock();
  }

  /**
   * 解除套用的結果（表單規則更新時使用）：需求內容保留但回到唯讀，需重新跟助理確認並套用後才能送出。
   * 沒有套用中的結果時不改變畫面。
   * @param {string} [notice=''] 解除後要顯示的通知；空字串代表不顯示。
   * @returns {void}
   */
  function detachDraft(notice = '') {
    if (!state.attached) return;
    state.attached = null;
    renderAttached(notice);
  }

  /**
   * 對話區按下「套用到需求單」：把整理好的內容放進需求內容（已處理取代或附加在後）、更新字數、保存送單設定（含對話中指定的處理人），
   * 主題還沒填、或還是上次自動帶入的值（使用者沒改過）時帶入這次整理的主題，使用者改過就保留；彈出「確認並送出」視窗並把焦點移到主題
   * @param {{content: string, draft: {subject: string, form: object|null, formName: string, department: {id: string, name: string}, departmentFixed: boolean, handler: {id: string, name: string}|null, rendered: string}}} applied 套用結果。
   * @returns {void}
   */
  function handleDraftApply({ content, draft: applied }) {
    nodes.content.value = content;
    updateCount('content');
    nodes.contentError.textContent = '';
    nodes.content.removeAttribute('aria-invalid');
    nodes.submitError.textContent = '';
    const untouched = !nodes.subject.value.trim() || (state.autoSubject !== '' && nodes.subject.value === state.autoSubject);
    if (untouched && applied.subject) {
      nodes.subject.value = applied.subject;
      state.autoSubject = applied.subject;
      updateCount('subject');
      nodes.subjectError.textContent = '';
      nodes.subject.removeAttribute('aria-invalid');
    }
    state.attached = applied;
    renderAttached();
    openConfirm();
    nodes.subject.focus();
  }

  /** 彈出「確認並送出」視窗（已開著時不重開）@returns {void} */
  function openConfirm() { if (!nodes.confirmDialog.open) nodes.confirmDialog.showModal(); }

  /** 關閉「確認並送出」視窗；主題、內容與套用結果都保留，可回對話調整後再套用 @returns {void} */
  function closeConfirm() { if (nodes.confirmDialog.open) nodes.confirmDialog.close(); }

  /**
   * 送出中不讓 Esc 關閉「確認並送出」視窗
   * @param {Event} event cancel 事件
   * @returns {void}
   */
  function handleConfirmCancel(event) { if (state.submitting) event.preventDefault(); }

  /**
   * 鎖定或解除送出中的狀態：送出鈕、主題與內容唯讀、重新開始鎖住；解除後需求內容依套用狀態決定是否可編輯。
   * @param {boolean} submitting 是否送出中。
   * @returns {void}
   */
  function setSubmitting(submitting) {
    state.submitting = submitting;
    nodes.subject.readOnly = submitting;
    syncContentLock();
    nodes.reset.disabled = submitting;
    nodes.confirmClose.disabled = submitting;
    nodes.confirmBack.disabled = submitting;
    nodes.form.setAttribute('aria-busy', String(submitting));
    updateSubmitButton();
  }

  /**
   * 計算後端要求的剩餘等待秒數，從目前時間推算，避免背景分頁計時器節流累積誤差。
   * @returns {number} 向上取整的剩餘秒數，最小為零。
   */
  function remainingWait() { return Math.max(0, Math.ceil((state.waitUntil - Date.now()) / 1000)); }

  /**
   * 合併送出中與等待倒數決定送出鈕的文字與可用狀態。
   * @returns {void}
   */
  function updateSubmitButton() {
    const remaining = remainingWait();
    nodes.submit.disabled = state.submitting || remaining > 0;
    nodes.submit.textContent = state.submitting ? PROPOSE_TEXT.submitting : remaining > 0 ? `請等 ${remaining} 秒` : PROPOSE_TEXT.submit;
  }

  /**
   * 倒數每次更新按鈕文字，到期後移除計時器並恢復送出鈕。
   * @returns {void}
   */
  function tickWait() {
    if (state.waitTimer !== null && remainingWait() === 0) {
      win.clearInterval(state.waitTimer);
      state.waitTimer = null;
    }
    updateSubmitButton();
  }

  /**
   * 依後端的等待秒數開始倒數；超過 300 秒或沒有秒數時不倒數，只顯示提示。
   * @param {number} seconds 後端要求的等待秒數。
   * @returns {void}
   */
  function startWait(seconds) {
    if (!(seconds > 0) || seconds > MAX_COUNTDOWN_SECONDS) return;
    if (state.waitTimer !== null) win.clearInterval(state.waitTimer);
    state.waitUntil = Date.now() + seconds * 1000;
    state.waitTimer = win.setInterval(tickWait, 250);
    updateSubmitButton();
  }

  /**
   * 重新開始：清空表單、字數、錯誤、套用結果與對話（需求內容回到唯讀、「確認並送出」視窗關閉），助理重新問候，焦點放回對話輸入框
   * @returns {void}
   */
  function resetForm() {
    closeConfirm();
    nodes.subject.value = '';
    nodes.content.value = '';
    state.attached = null;
    state.autoSubject = '';
    renderAttached();
    draftDialog.reset();
    for (const field of ['subject', 'content']) {
      updateCount(field);
      nodes[`${field}Error`].textContent = '';
      nodes[field].removeAttribute('aria-invalid');
    }
    nodes.submitError.textContent = '';
    draftDialog.focus();
  }

  /**
   * 顯示欄位錯誤並把焦點移到第一個有錯的欄位。
   * @param {{subject: string, content: string}} errors validateTicketInput 的結果。
   * @returns {boolean} 是否有任何錯誤。
   */
  function showFieldErrors(errors) {
    let first = null;
    for (const field of ['subject', 'content']) {
      nodes[`${field}Error`].textContent = errors[field];
      if (errors[field]) {
        nodes[field].setAttribute('aria-invalid', 'true');
        first ??= nodes[field];
      } else nodes[field].removeAttribute('aria-invalid');
    }
    if (first) first.focus();
    return Boolean(first);
  }

  /**
   * 處理送出失敗：憑證失效回登入頁；429 非額度錯誤依秒數倒數；其餘顯示提示；非預期錯誤只寫入主控台。
   * 帶需求類型表單送出時的其他 409（定義檔的檢查未通過，錯誤代碼與訊息由後端定義檔提供，前端不認得特定代碼）另提示可跟助理調整；
   * FORM_VERSION_CHANGED（表單規則已更新）解除套用並清除對話，請使用者重新確認。
   * @param {unknown} error 送出時拋出的錯誤。
   * @param {boolean} [withForm=false] 這次送出是否帶需求類型表單。
   * @returns {void}
   */
  function handleFailure(error, withForm = false) {
    if (error?.status === 401 || error?.code === 'LOGIN_REQUIRED') { leave(); return; }
    if (!(error instanceof TicketServiceError)) {
      console.error(error);
      nodes.submitError.textContent = PROPOSE_TEXT.unexpected;
      return;
    }
    if (error.code === 'FORM_VERSION_CHANGED') {
      nodes.submitError.textContent = `${error.message}\n${PROPOSE_TEXT.formChanged}`;
      detachDraft();
      draftDialog.reset();
      return;
    }
    nodes.submitError.textContent = withForm && error.status === 409 ? `${error.message}\n${PROPOSE_TEXT.formHint}` : error.message;
    if (error.status === 429 && !QUOTA_CODES.includes(error.code)) startWait(error.retryAfter);
  }

  /**
   * 送出需求單：先檢查登入、是否已套用助理整理的內容、兩個欄位與固定格式文字，送出中鎖住表單；成功開啟結果視窗，失敗交給 handleFailure。
   * 有需求類型表單時帶 form（{ id, version, fields }），部門不是由類型固定時帶 departmentId；處理人為對話中指定者（沒有時不指定）。
   * @param {SubmitEvent} event 表單提交事件。
   * @returns {Promise<void>}
   */
  async function handleSubmit(event) {
    event.preventDefault();
    if (state.submitting || remainingWait() > 0) return;
    const current = auth.getCurrentUser();
    if (!current || current.userID !== user.userID) { leave(); return; }
    nodes.submitError.textContent = '';
    const input = { subject: nodes.subject.value, content: nodes.content.value };
    const errors = validateTicketInput(input);
    // 尚未套用時需求內容一定是空的（唯讀），改以下方的「請先跟助理確認」提示說明，不標示需求內容欄位錯誤。
    if (!state.attached) errors.content = '';
    if (showFieldErrors(errors)) return;
    const attached = state.attached;
    if (!attached) {
      nodes.submitError.textContent = PROPOSE_TEXT.needDraft;
      // 視窗開著時提示留在視窗裡，焦點不移到被遮住的對話區
      if (!nodes.confirmDialog.open) draftDialog.focus();
      return;
    }
    if (!keepsFixedText()) {
      nodes.contentError.textContent = PROPOSE_TEXT.fixedChanged;
      nodes.content.setAttribute('aria-invalid', 'true');
      nodes.content.focus();
      return;
    }
    const payload = { ...input, handlerId: attached.handler?.id ?? '' };
    if (attached.form) payload.form = attached.form;
    if (!attached.departmentFixed) payload.departmentId = attached.department.id;
    setSubmitting(true);
    try {
      const result = await sendTicket(payload);
      renderTicketResult(nodes.result, input.subject.trim(), result, { fromDraft: true });
      closeConfirm();
      nodes.resultDialog.showModal();
    } catch (error) {
      handleFailure(error, Boolean(payload.form));
    } finally {
      setSubmitting(false);
    }
  }

  /** 以任何方式關閉結果視窗後清空表單，避免同一張單重複送出。@returns {void} */
  function handleResultClosed() { resetForm(); }
  /** 關閉結果視窗（「關閉」與「再提一張」行為相同）。@returns {void} */
  function closeResult() { nodes.resultDialog.close(); }
  /** 開啟各部門業務範圍視窗。@returns {void} */
  function openDepartments() { if (!nodes.departmentsButton.disabled) nodes.departmentsDialog.showModal(); }
  /** 關閉各部門業務範圍視窗。@returns {void} */
  function closeDepartments() { nodes.departmentsDialog.close(); }
  /** 主題輸入事件。@returns {void} */
  function handleSubjectInput() { handleInput('subject'); }
  /** 需求內容輸入事件。@returns {void} */
  function handleContentInput() { handleInput('content'); }

  nodes.form.addEventListener('submit', handleSubmit);
  nodes.subject.addEventListener('input', handleSubjectInput);
  nodes.content.addEventListener('input', handleContentInput);
  nodes.reset.addEventListener('click', resetForm);
  nodes.departmentsButton.addEventListener('click', openDepartments);
  nodes.departmentsClose.addEventListener('click', closeDepartments);
  nodes.resultClose.addEventListener('click', closeResult);
  nodes.resultAgain.addEventListener('click', closeResult);
  nodes.resultDialog.addEventListener('close', handleResultClosed);
  nodes.confirmClose.addEventListener('click', closeConfirm);
  nodes.confirmBack.addEventListener('click', closeConfirm);
  nodes.confirmDialog.addEventListener('cancel', handleConfirmCancel);

  /**
   * 依需求類型目錄產生常見需求按鈕（按下就把類型名稱當第一句話送給助理）；載入失敗時不顯示按鈕，仍可直接打字，登入失效時回登入頁。
   * @returns {Promise<void>}
   */
  async function loadStarters() {
    let types = [];
    try { types = await fetchTypes(); } catch (error) {
      if (error?.status === 401 || error?.code === 'LOGIN_REQUIRED') { leave(); return; }
      if (!(error instanceof TicketServiceError)) console.error(error);
    }
    nodes.starters.replaceChildren(...types.map(/** 一個類型一顆按鈕 @param {{name: string, summary: string}} type 需求類型 @returns {HTMLElement} 按鈕 */ (type) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'starter-chip';
      button.textContent = type.name;
      if (type.summary) button.title = type.summary;
      button.addEventListener('click', /** 用這個類型開始 @returns {Promise<boolean>} 是否送出 */ () => draftDialog.start(type.name));
      return button;
    }));
  }

  const draft = takeDraft(user.userID);
  if (draft) {
    nodes.subject.value = draft.subject;
    nodes.content.value = draft.content;
    draftDialog.prefill(draft.subject);
  }
  updateCount('subject');
  updateCount('content');
  renderAttached(draft ? PROPOSE_TEXT.resubmit : '');
  doc.body.hidden = false;
  draftDialog.focus();
  // 重新提出帶回主題與原本內容時，先彈出視窗給使用者看，按「返回修改」回到對話
  if (draft) openConfirm();
  const ready = Promise.all([loadList(), loadStarters()]);
  return { submit: handleSubmit, reset: resetForm, remainingWait, ready, checkSession, leave, state, draftDialog };
}

// 真實瀏覽器載入時自動初始化；測試以替身文件明確呼叫 initProposePage。
if (typeof document !== 'undefined' && typeof document.readyState === 'string') initProposePage();
