import { authService } from '../services/authService.js';
import { loadDepartments, submitTicket, validateTicketInput, countCodePoints, TICKET_LIMITS, TicketServiceError, QUOTA_CODES, DRAFT_KEY } from '../services/ticketService.js';
import { renderDepartmentCards, renderTicketResult } from '../components/propose/dialogs.js';
import { initAccountMenu } from '../components/account.js';
import { createDraftDialog } from '../components/propose/draftDialog.js';
import { requestDraft } from '../services/draftService.js';

export const PROPOSE_TEXT = {
  notice: '無法載入部門資訊，「查看各部門業務範圍」暫時無法使用；仍可按「自動生成」提出需求單',
  submit: '送出需求單',
  submitting: '送出中…',
  unexpected: '發生未預期的錯誤，請稍後再試',
  attached: '已由自動生成確認，將送達「{department}」',
  attachedHandler: '已由自動生成確認，將送達「{department}」的 {handler}',
  contentLocked: '請先填寫主題並按「自動生成」；確認後按 Apply 套用，整理好的內容會出現在這裡，再做最後編輯',
  needDraft: '請先按「自動生成」確認需求內容與處理部門，按 Apply 套用後再送出',
  fixedChanged: '需求內容必須保留「自動生成」整理的固定格式文字（可以在前後補充說明）；要修改欄位請按「自動生成」調整後重新套用',
  resubmit: '已帶入被退回需求單的主題與原本內容；請按「自動生成」重新確認，套用時可選擇取代或附加在原內容後',
  formHint: '可按「自動生成」調整內容後再送出',
  formChanged: '對話與欄位已清除，請重新按「自動生成」確認',
};

/**
 * 組出套用「自動生成」後顯示在需求內容下方的提示；對話中有指定處理人時一併列出。
 * @param {string} department 確認的處理部門名稱。
 * @param {string} [handler=''] 對話中指定的處理人帳號；空字串代表不指定。
 * @returns {string} 例如「已由自動生成確認，將送達「人力資源部」」。
 */
export function describeAttached(department, handler = '') {
  const template = handler ? PROPOSE_TEXT.attachedHandler : PROPOSE_TEXT.attached;
  return template.replace('{department}', department).replace('{handler}', handler);
}
const MAX_COUNTDOWN_SECONDS = 300;

/**
 * 初始化提出需求單頁：檢查登入、載入部門資訊（業務範圍視窗用）、綁定表單驗證、送出、倒數、結果視窗、部門視窗與「自動生成」（ChatBox）視窗。
 * 需求內容只由「自動生成」帶入：套用前唯讀，按 Apply 後保存 attached（需求類型表單、對話確認的部門、處理人與後端整理的內容）並開放最後編輯；
 * 送出時一定帶對話確認的部門（部門由類型固定時改帶 form），處理人只在「自動生成」視窗內指定，頁面不再提供指定處理人。
 * 需求內容必須保留整理好的固定格式文字（所有需求類型都帶 form 送出，後端同樣檢查），可以在前後補充說明；改掉固定文字時提示並阻止送出，不會改用其他方式送出。
 * @param {Document} [doc=document] 頁面文件，測試可注入替身。
 * @param {Window} [win=window] 視窗物件，提供導頁、計時器、confirm 與 pageshow 事件。
 * @param {object} [services={}] 可注入的服務替身。
 * @param {object} [services.auth=authService] 登入服務。
 * @param {Function} [services.loadDepartments=loadDepartments] 部門資訊載入函式。
 * @param {Function} [services.submitTicket=submitTicket] 需求單送出函式。
 * @param {Function} [services.requestDraft=requestDraft] 「自動生成」草稿函式（POST /api/tickets/draft）。
 * @param {number} [services.draftDebounceMs=400] 面板手動修改後送出驗證前的等待毫秒數（測試可設為 0）。
 * @returns {object|null} 頁面控制器（submit、reset、remainingWait、ready、draftDialog、openDraft 等），未登入導回登入頁時回傳 null。
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
  const { user, leave, checkSession } = initAccountMenu(doc, win, auth);
  if (!user) return null;

  const nodes = {
    notice: doc.querySelector('#list-notice'), form: doc.querySelector('#ticket-form'),
    subject: doc.querySelector('#subject'), subjectCount: doc.querySelector('#subject-count'), subjectError: doc.querySelector('#subject-error'),
    content: doc.querySelector('#content'), contentCount: doc.querySelector('#content-count'), contentError: doc.querySelector('#content-error'),
    reset: doc.querySelector('#reset-button'), submit: doc.querySelector('#submit-button'), submitError: doc.querySelector('#submit-error'),
    draftButton: doc.querySelector('#draft-button'), formChip: doc.querySelector('#form-chip'), formChipText: doc.querySelector('#form-chip-text'),
    formNotice: doc.querySelector('#form-notice'),
    departmentsButton: doc.querySelector('#departments-button'), departmentsDialog: doc.querySelector('#departments-dialog'),
    departmentsClose: doc.querySelector('#departments-close'), departmentsList: doc.querySelector('#departments-list'),
    resultDialog: doc.querySelector('#result-dialog'), resultClose: doc.querySelector('#result-close'), resultAgain: doc.querySelector('#result-again'),
    result: { subject: doc.querySelector('#result-subject'), ticket: doc.querySelector('#result-ticket'), target: doc.querySelector('#result-target'),
      method: doc.querySelector('#result-method'), basisRow: doc.querySelector('#result-basis-row'), basis: doc.querySelector('#result-basis'), note: doc.querySelector('#result-note') },
  };
  const state = { submitting: false, waitUntil: 0, waitTimer: null, listState: 'loading', departments: [], attached: null };
  /**
   * 依 id 取得「自動生成」視窗的節點。
   * @param {string} id 元素 id（不含 #）。
   * @returns {HTMLElement|null} 節點。
   */
  function byId(id) { return doc.querySelector(`#${id}`); }
  const draftDialog = createDraftDialog({
    dialog: byId('draft-dialog'), close: byId('draft-close'), log: byId('draft-log'), typing: byId('draft-typing'), chatForm: byId('draft-chat-form'),
    message: byId('draft-message'), messageCount: byId('draft-message-count'), send: byId('draft-send'), departmentField: byId('draft-department-field'),
    departmentSelect: byId('draft-department'), departmentSource: byId('draft-department-source'), departmentStatus: byId('draft-department-status'),
    fieldList: byId('draft-field-list'), computed: byId('draft-computed'), summaries: byId('draft-summaries'), prompt: byId('draft-prompt'), error: byId('draft-error'),
    applyChoice: byId('draft-apply-choice'), replace: byId('draft-replace'), append: byId('draft-append'), choiceCancel: byId('draft-choice-cancel'),
    cancel: byId('draft-cancel'), apply: byId('draft-apply'), trigger: nodes.draftButton,
  }, {
    user, requestDraft: fetchDraft, win, debounceMs: services.draftDebounceMs ?? 400,
    getSubject: readSubject, getContent: readContent, onApply: handleDraftApply, onLoginRequired: leave,
  });

  /**
   * 依部門資訊狀態更新「查看各部門業務範圍」按鈕與表單上方提示：載入中與失敗時按鈕停用（失敗另顯示原因），成功時產生部門卡片。
   * 部門資訊只供業務範圍視窗使用；處理部門與處理人都在「自動生成」視窗內確認，載入失敗不影響提出需求單。
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
   * 依目前狀態決定需求內容是否可編輯：送出中或尚未套用「自動生成」時唯讀，並顯示說明文字。
   * @returns {void}
   */
  function syncContentLock() {
    const locked = state.submitting || !state.attached;
    nodes.content.readOnly = locked;
    nodes.content.placeholder = state.attached ? '' : PROPOSE_TEXT.contentLocked;
    nodes.content.classList.toggle('is-locked', !state.attached);
  }

  /**
   * 輸入時更新字數並清掉該欄與送出區的錯誤提示；主題變動時更新「自動生成」按鈕，
   * 需求內容改到不再包含固定格式文字時立即提示（不解除套用，送出時阻止）。
   * @param {'subject'|'content'} field 欄位名稱。
   * @returns {void}
   */
  function handleInput(field) {
    updateCount(field);
    nodes[`${field}Error`].textContent = '';
    nodes[field].removeAttribute('aria-invalid');
    nodes.submitError.textContent = '';
    if (field === 'subject') updateDraftButton();
    if (field === 'content' && !keepsFixedText()) {
      nodes.contentError.textContent = PROPOSE_TEXT.fixedChanged;
      nodes.content.setAttribute('aria-invalid', 'true');
    }
  }

  /**
   * 「自動生成」按鈕在主題空白或送出中時停用。
   * @returns {void}
   */
  function updateDraftButton() { nodes.draftButton.disabled = state.submitting || countCodePoints(nodes.subject.value) === 0; }

  /** 取得頁面上的主題（供「自動生成」視窗使用）。@returns {string} 主題。 */
  function readSubject() { return nodes.subject.value; }
  /** 取得頁面上的需求內容（供「自動生成」視窗判斷取代或附加）。@returns {string} 需求內容。 */
  function readContent() { return nodes.content.value; }

  /**
   * 依目前套用狀態顯示或隱藏需求內容下方的「已由自動生成確認」提示列，並顯示（或清除）通知；同時更新需求內容是否可編輯。
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
   * 解除套用的「自動生成」結果（表單規則更新時使用）：需求內容保留但回到唯讀，需重新按「自動生成」套用後才能送出。
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
   * 「自動生成」視窗按下 Apply：把整理好的內容放進需求內容（已處理取代或附加在後）、更新字數、保存送單設定（含對話中指定的處理人），
   * 並開放需求內容做最後編輯。
   * @param {{content: string, draft: {form: object|null, formName: string, department: {id: string, name: string}, departmentFixed: boolean, handler: {id: string, name: string}|null, rendered: string}}} applied 套用結果。
   * @returns {void}
   */
  function handleDraftApply({ content, draft: applied }) {
    nodes.content.value = content;
    updateCount('content');
    nodes.contentError.textContent = '';
    nodes.content.removeAttribute('aria-invalid');
    nodes.submitError.textContent = '';
    state.attached = applied;
    renderAttached();
  }

  /**
   * 開啟「自動生成」視窗（主題空白或送出中時不動作）。
   * @returns {Promise<boolean>|null} 視窗送出的第一個請求，沒有時為 null。
   */
  function openDraft() {
    if (nodes.draftButton.disabled) return null;
    return draftDialog.open();
  }

  /**
   * 鎖定或解除送出中的狀態：送出鈕、主題與內容唯讀、清除重填與「自動生成」鎖住；解除後需求內容依套用狀態決定是否可編輯。
   * @param {boolean} submitting 是否送出中。
   * @returns {void}
   */
  function setSubmitting(submitting) {
    state.submitting = submitting;
    nodes.subject.readOnly = submitting;
    syncContentLock();
    nodes.reset.disabled = submitting;
    nodes.form.setAttribute('aria-busy', String(submitting));
    updateSubmitButton();
    updateDraftButton();
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
   * 清空表單、字數、錯誤、套用的「自動生成」結果與對話（需求內容回到唯讀），並把焦點放回主題。
   * @returns {void}
   */
  function resetForm() {
    nodes.subject.value = '';
    nodes.content.value = '';
    state.attached = null;
    renderAttached();
    draftDialog.reset();
    updateDraftButton();
    for (const field of ['subject', 'content']) {
      updateCount(field);
      nodes[`${field}Error`].textContent = '';
      nodes[field].removeAttribute('aria-invalid');
    }
    nodes.submitError.textContent = '';
    nodes.subject.focus();
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
   * 帶需求類型表單送出時的其他 409（定義檔的檢查未通過，錯誤代碼與訊息由後端定義檔提供，前端不認得特定代碼）另提示可回「自動生成」調整；
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
   * 送出需求單：先檢查登入、是否已套用「自動生成」、兩個欄位與固定格式文字，送出中鎖住表單；成功開啟結果視窗，失敗交給 handleFailure。
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
    // 尚未套用時需求內容一定是空的（唯讀），改以下方的「請先自動生成」提示說明，不標示需求內容欄位錯誤。
    if (!state.attached) errors.content = '';
    if (showFieldErrors(errors)) return;
    const attached = state.attached;
    if (!attached) {
      nodes.submitError.textContent = PROPOSE_TEXT.needDraft;
      (nodes.draftButton.disabled ? nodes.subject : nodes.draftButton).focus();
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
  nodes.draftButton.addEventListener('click', openDraft);
  const draft = takeDraft(user.userID);
  if (draft) {
    nodes.subject.value = draft.subject;
    nodes.content.value = draft.content;
  }
  updateCount('subject');
  updateCount('content');
  updateDraftButton();
  renderAttached(draft ? PROPOSE_TEXT.resubmit : '');
  doc.body.hidden = false;
  const ready = loadList();
  return { submit: handleSubmit, reset: resetForm, remainingWait, ready, checkSession, leave, state, draftDialog, openDraft };
}

// 真實瀏覽器載入時自動初始化；測試以替身文件明確呼叫 initProposePage。
if (typeof document !== 'undefined' && typeof document.readyState === 'string') initProposePage();
