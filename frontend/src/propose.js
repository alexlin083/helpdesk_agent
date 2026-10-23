import { authService } from './services/authService.js';
import { loadDepartments, submitTicket, validateTicketInput, countCodePoints, TICKET_LIMITS, TicketServiceError, QUOTA_CODES, DRAFT_KEY } from './services/ticketService.js';
import { renderDepartmentCards, renderTicketResult } from './components/dialogs.js';
import { initAccountMenu } from './components/account.js';
import { createHandlerPicker } from './components/handlerPicker.js';

export const PROPOSE_TEXT = {
  loading: '載入處理人名單中…',
  ready: '不指定，由 AI 判斷部門',
  failed: '名單無法載入，由 AI 判斷部門',
  notice: '無法載入處理人名單與部門資訊，仍可送出需求單，由 AI 判斷部門',
  submit: '送出需求單',
  submitting: '送出中…',
  unexpected: '發生未預期的錯誤，請稍後再試',
};
const MAX_COUNTDOWN_SECONDS = 300;

/**
 * 依部門分組整理指定處理人選單的選項；顯示帳號名稱；沒有處理人的部門不列出。
 * @param {Array<object>} departments 經 ticketService 正規化的部門陣列。
 * @returns {Array<{label: string, type: string, options: Array<{value: string, label: string, target: string}>}>} 分組選項，type 為部門屬性標籤（供搜尋），target 為「姓名（部門）」。
 */
export function buildHandlerOptions(departments) {
  const groups = [];
  for (const department of departments) {
    if (!department.handlers.length) continue;
    const options = department.handlers.map((handler) => ({
      value: handler.id,
      label: handler.name,
      target: `${handler.name}（${department.name}）`,
    }));
    groups.push({ label: department.name, type: department.type ?? '', options });
  }
  return groups;
}

/**
 * 初始化提出需求單頁：檢查登入、載入名單、綁定表單驗證、送出、倒數、結果視窗與部門視窗。
 * @param {Document} [doc=document] 頁面文件，測試可注入替身。
 * @param {Window} [win=window] 視窗物件，提供導頁、計時器與 pageshow 事件。
 * @param {object} [services={}] 可注入的服務替身。
 * @param {object} [services.auth=authService] 登入服務。
 * @param {Function} [services.loadDepartments=loadDepartments] 名單載入函式。
 * @param {Function} [services.submitTicket=submitTicket] 需求單送出函式。
 * @returns {object|null} 頁面控制器（submit、reset、remainingWait、ready 等），未登入導回登入頁時回傳 null。
 */
export function initProposePage(doc = document, win = window, services = {}) {
  /**
   * 讀取並清除狀態追蹤頁「重新提出」留下的草稿；儲存體不可用或內容不是物件時視為沒有草稿。
   * @returns {{subject: string, content: string}|null} 草稿。
   */
  function takeDraft() {
    try {
      const raw = win.sessionStorage?.getItem(DRAFT_KEY);
      if (!raw) return null;
      win.sessionStorage.removeItem(DRAFT_KEY);
      const draft = JSON.parse(raw);
      if (!draft || typeof draft !== 'object') return null;
      return { subject: typeof draft.subject === 'string' ? draft.subject : '', content: typeof draft.content === 'string' ? draft.content : '' };
    } catch { return null; }
  }
  const auth = services.auth ?? authService;
  const fetchDepartments = services.loadDepartments ?? loadDepartments;
  const sendTicket = services.submitTicket ?? submitTicket;
  const { user, leave, checkSession } = initAccountMenu(doc, win, auth);
  if (!user) return null;

  const nodes = {
    notice: doc.querySelector('#list-notice'), form: doc.querySelector('#ticket-form'),
    subject: doc.querySelector('#subject'), subjectCount: doc.querySelector('#subject-count'), subjectError: doc.querySelector('#subject-error'),
    content: doc.querySelector('#content'), contentCount: doc.querySelector('#content-count'), contentError: doc.querySelector('#content-error'),
    handler: doc.querySelector('#handler'), handlerHint: doc.querySelector('#handler-hint'),
    handlerSearch: doc.querySelector('#handler-search'), handlerClear: doc.querySelector('#handler-clear'), handlerListbox: doc.querySelector('#handler-listbox'),
    reset: doc.querySelector('#reset-button'), submit: doc.querySelector('#submit-button'), submitError: doc.querySelector('#submit-error'),
    departmentsButton: doc.querySelector('#departments-button'), departmentsDialog: doc.querySelector('#departments-dialog'),
    departmentsClose: doc.querySelector('#departments-close'), departmentsList: doc.querySelector('#departments-list'),
    resultDialog: doc.querySelector('#result-dialog'), resultClose: doc.querySelector('#result-close'), resultAgain: doc.querySelector('#result-again'),
    result: { subject: doc.querySelector('#result-subject'), ticket: doc.querySelector('#result-ticket'), target: doc.querySelector('#result-target'),
      method: doc.querySelector('#result-method'), basisRow: doc.querySelector('#result-basis-row'), basis: doc.querySelector('#result-basis'), note: doc.querySelector('#result-note') },
  };
  const state = { submitting: false, waitUntil: 0, waitTimer: null, listState: 'loading', departments: [] };
  const picker = createHandlerPicker({ input: nodes.handlerSearch, clear: nodes.handlerClear, listbox: nodes.handlerListbox, hidden: nodes.handler }, { onChange: handleHandlerChange });

  /**
   * 依名單狀態更新處理人選單、按鈕與提示：載入中與失敗時選單停用並顯示對應提示，成功時載入依部門分組的可搜尋名單。
   * @param {'loading'|'ready'|'failed'} listState 名單狀態。
   * @param {Array<object>|string} [payload] 成功時為部門陣列，失敗時為原因文字。
   * @returns {void}
   */
  function setListState(listState, payload) {
    state.listState = listState;
    nodes.handlerHint.hidden = true;
    if (listState === 'loading') {
      picker.setState('loading', PROPOSE_TEXT.loading);
      nodes.departmentsButton.disabled = true;
      nodes.notice.hidden = true;
      nodes.notice.textContent = '';
      return;
    }
    if (listState === 'failed') {
      picker.setState('failed', PROPOSE_TEXT.failed);
      nodes.departmentsButton.disabled = true;
      nodes.notice.textContent = `${PROPOSE_TEXT.notice}原因：${payload}`;
      nodes.notice.hidden = false;
      return;
    }
    state.departments = payload;
    picker.setState('ready', PROPOSE_TEXT.ready, buildHandlerOptions(payload));
    renderDepartmentCards(nodes.departmentsList, payload);
    nodes.departmentsButton.disabled = false;
    nodes.notice.hidden = true;
    nodes.notice.textContent = '';
  }

  /**
   * 載入處理人名單；憑證失效時回登入頁，其他失敗維持停用並在表單上方顯示原因。
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
   * 輸入時更新字數並清掉該欄與送出區的錯誤提示。
   * @param {'subject'|'content'} field 欄位名稱。
   * @returns {void}
   */
  function handleInput(field) {
    updateCount(field);
    nodes[`${field}Error`].textContent = '';
    nodes[field].removeAttribute('aria-invalid');
    nodes.submitError.textContent = '';
  }

  /**
   * 處理人選單選定或清除時顯示預計送達的處理人與部門；不指定時隱藏提示。
   * @param {object|null} option 選定的選項（含 target「帳號（部門）」），null 代表不指定。
   * @returns {void}
   */
  function handleHandlerChange(option) {
    const target = option?.target ?? '';
    nodes.handlerHint.textContent = target ? `預計送達：${target}` : '';
    nodes.handlerHint.hidden = !target;
  }

  /**
   * 鎖定或解除送出中的狀態：送出鈕、主題與內容唯讀、清除重填鎖住。
   * @param {boolean} submitting 是否送出中。
   * @returns {void}
   */
  function setSubmitting(submitting) {
    state.submitting = submitting;
    nodes.subject.readOnly = submitting;
    nodes.content.readOnly = submitting;
    nodes.reset.disabled = submitting;
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
   * 清空表單、字數、錯誤與預計送達提示，並把焦點放回主題；指定處理人的選項保留。
   * @returns {void}
   */
  function resetForm() {
    nodes.subject.value = '';
    nodes.content.value = '';
    picker.clearSelection();
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
   * @param {unknown} error 送出時拋出的錯誤。
   * @returns {void}
   */
  function handleFailure(error) {
    if (error?.status === 401 || error?.code === 'LOGIN_REQUIRED') { leave(); return; }
    if (!(error instanceof TicketServiceError)) {
      console.error(error);
      nodes.submitError.textContent = PROPOSE_TEXT.unexpected;
      return;
    }
    nodes.submitError.textContent = error.message;
    if (error.status === 429 && !QUOTA_CODES.includes(error.code)) startWait(error.retryAfter);
  }

  /**
   * 送出需求單：先檢查登入與兩個欄位，送出中鎖住表單；成功開啟結果視窗，失敗交給 handleFailure。
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
    if (showFieldErrors(validateTicketInput(input))) return;
    setSubmitting(true);
    try {
      const result = await sendTicket({ ...input, handlerId: picker.enabled ? picker.value : '' });
      renderTicketResult(nodes.result, input.subject.trim(), result);
      nodes.resultDialog.showModal();
    } catch (error) {
      handleFailure(error);
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
  const draft = takeDraft();
  if (draft) {
    nodes.subject.value = draft.subject;
    nodes.content.value = draft.content;
  }
  updateCount('subject');
  updateCount('content');
  doc.body.hidden = false;
  const ready = loadList();
  return { submit: handleSubmit, reset: resetForm, remainingWait, ready, checkSession, leave, state, picker };
}

// 真實瀏覽器載入時自動初始化；測試以替身文件明確呼叫 initProposePage。
if (typeof document !== 'undefined' && typeof document.readyState === 'string') initProposePage();
