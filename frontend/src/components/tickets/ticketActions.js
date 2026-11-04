import { element } from '../dom.js';
import { countCodePoints, TICKET_LIMITS, TicketServiceError, QUOTA_CODES } from '../../services/ticketService.js';
import { TICKETS_TEXT } from './ticketText.js';
import { createActionStateStore } from './ticketActionState.js';

const MAX_COUNTDOWN_SECONDS = 300;

/**
 * 依操作組合決定備註欄下方的說明文字。
 * @param {boolean} canDecide 是否可簽核／退回。
 * @param {boolean} cancelRequiresComment 取消是否必須填原因（部門替提單人取消）。
 * @returns {string} 說明文字。
 */
function helpText(canDecide, cancelRequiresComment) {
  if (!canDecide) return `最多 ${TICKET_LIMITS.comment} 字；取消後不能復原，需要時請再提一張`;
  return cancelRequiresComment ? `最多 ${TICKET_LIMITS.comment} 字；退回或替提單人取消時請說明原因` : `最多 ${TICKET_LIMITS.comment} 字；退回時請說明原因，取消自己的單原因選填`;
}

/**
 * 建立待簽核需求單的操作表單，管理備註驗證、部門／處理人選擇、按鈕鎖定、限流倒數與卡片內錯誤。
 * 元件不直接呼叫 API；由頁面注入有權限的動作，成功後頁面負責重新載入清單。
 * 取消按鈕的文字依 cancelRequiresComment 決定：必須填原因時是部門「替提單人取消」，否則是提單人「取消需求單」。
 * 處理中、錯誤與倒數保存在 actionState（頁面以單號保存，重新繪製時沿用同一個物件）：
 * 請求進行中時所有按鈕停用（換轉單部門也不會解除），處理中的按鈕顯示「處理中…」，同一張卡片不會同時送出第二個動作；
 * 舊表單的請求在清單重新繪製後才回來時，結果（錯誤、倒數）會顯示在新卡片上。
 * 動作遇到 429 非額度錯誤且 0 < retryAfter ≤ 300 時，卡片內所有按鈕停用，觸發的按鈕顯示「請等 N 秒」；
 * 倒數由狀態儲存的共用計時器每 250 ms 依 Date.now 更新，到期自動解除。按鈕結束處理或倒數後一律恢復各自原本的文字。
 * @param {object} ticket 正規化的待簽核需求單。
 * @param {object} options 可用動作；卡片只在至少可簽核或取消時建立此表單。
 * @param {Function|null} options.onDecide 簽核／退回回呼，接收單號、動作與備註。
 * @param {Function|null} options.onTransfer 轉單回呼，接收單號、部門、處理人與備註。
 * @param {Array<object>|null} options.departments 可轉到的部門；null 時停用轉單。
 * @param {Function|null} options.onCancel 取消回呼，接收單號與原因。
 * @param {boolean} options.cancelRequiresComment 是否強制填寫取消原因（部門替提單人取消時為 true；提單人取消自己的單為 false）。
 * @param {object|null} [options.actionState=null] 頁面以單號保存的動作狀態（createActionStateStore().get 的結果）；省略時建立只屬於這張表單的狀態。
 * @returns {HTMLFormElement} 已綁定事件的表單；重複繪製應建立新表單取代舊節點，並傳入同一個 actionState。
 */
export function buildTicketActions(ticket, { onDecide, onTransfer, departments, onCancel, cancelRequiresComment, actionState = null }) {
  const state = actionState ?? createActionStateStore().get(ticket.ticket_id);
  const form = element('form', 'decision-form');
  const label = element('label', '', onDecide ? '備註（選填）' : '取消原因（選填）');
  label.setAttribute('for', `comment-${ticket.ticket_id}`);
  const comment = element('textarea');
  comment.setAttribute('id', `comment-${ticket.ticket_id}`);
  comment.setAttribute('rows', '3');
  const help = element('p', 'decision-help', helpText(Boolean(onDecide), Boolean(cancelRequiresComment)));
  const error = element('p', 'decision-error');
  error.setAttribute('role', 'alert');
  const actions = element('div', 'decision-actions');
  // 動作代號 → { button, label }；label 是按鈕原本的文字，處理中或倒數結束後恢復成這個文字。
  const controls = new Map();
  /**
   * 建立一個動作按鈕並登記它原本的文字。
   * @param {string} key 動作代號（approve、reject、transfer、cancel）。
   * @param {string} className 樣式類別。
   * @param {string} text 按鈕文字。
   * @returns {HTMLButtonElement} 按鈕。
   */
  function addButton(key, className, text) {
    const button = element('button', className, text);
    button.setAttribute('type', 'button');
    controls.set(key, { button, label: text });
    return button;
  }
  let cancel = null;
  if (onCancel) {
    cancel = addButton('cancel', 'link-button cancel-button', cancelRequiresComment ? TICKETS_TEXT.cancelForRequester : TICKETS_TEXT.cancel);
    actions.append(cancel);
  }
  let approve = null;
  let reject = null;
  if (onDecide) {
    reject = addButton('reject', 'secondary-button reject-button', TICKETS_TEXT.reject);
    approve = addButton('approve', 'primary-button approve-button', TICKETS_TEXT.approve);
    actions.append(reject, approve);
  }
  form.append(label, comment, help, error);

  // 轉單：AI 判斷錯誤或指定錯處理人時，接到單的部門可改派到其他部門（可指定該部門的處理人）。
  let transfer = null;
  if (onTransfer && onDecide) {
    const wrapper = element('div', 'transfer-row');
    const targetLabel = element('label', 'transfer-label', '轉單到其他部門');
    targetLabel.setAttribute('for', `transfer-${ticket.ticket_id}`);
    const departmentSelect = element('select', 'transfer-department');
    departmentSelect.setAttribute('id', `transfer-${ticket.ticket_id}`);
    const handlerSelect = element('select', 'transfer-handler');
    handlerSelect.setAttribute('aria-label', '轉單後的處理人');
    const transferButton = addButton('transfer', 'secondary-button transfer-button', TICKETS_TEXT.transfer);
    const options = [];
    for (const department of departments ?? []) if (department.id !== ticket.department_id) options.push(department);
    const placeholder = element('option', '', departments ? TICKETS_TEXT.chooseDepartment : TICKETS_TEXT.transferUnavailable);
    placeholder.value = '';
    departmentSelect.append(placeholder);
    for (const department of options) {
      const option = element('option', '', department.name);
      option.value = department.id;
      departmentSelect.append(option);
    }
    /**
     * 依選到的部門重建處理人選項；沒有選部門或該部門沒有處理人時只有「不指定處理人」。
     * 轉單鈕是否啟用交給 applyState 決定：請求進行中或限流倒數期間維持停用，換部門不會提早解除。
     * @returns {void}
     */
    function refreshHandlers() {
      const none = element('option', '', TICKETS_TEXT.noHandler);
      none.value = '';
      handlerSelect.replaceChildren(none);
      let selected;
      for (const department of options) if (department.id === departmentSelect.value) { selected = department; break; }
      for (const handler of selected?.handlers ?? []) {
        const option = element('option', '', handler.name);
        option.value = handler.id;
        handlerSelect.append(option);
      }
      handlerSelect.value = '';
      handlerSelect.disabled = !selected || !selected.handlers.length;
      applyState();
    }
    departmentSelect.disabled = !departments || !options.length;
    departmentSelect.addEventListener('change', refreshHandlers);
    wrapper.append(targetLabel, departmentSelect, handlerSelect, transferButton);
    form.append(wrapper);
    transfer = { departmentSelect, handlerSelect, transferButton, refreshHandlers };
  }
  form.append(actions);

  /**
   * 把動作狀態套用到這張表單：請求進行中或倒數中時所有按鈕停用，轉單鈕另在未選部門時停用；
   * 處理中的按鈕顯示「處理中…」，觸發倒數的按鈕顯示「請等 N 秒」，其他按鈕恢復各自原本的文字；錯誤區顯示狀態中的錯誤。
   * @returns {void}
   */
  function applyState() {
    const remaining = state.remaining();
    const locked = Boolean(state.busy) || remaining > 0;
    for (const [key, control] of controls) {
      control.button.disabled = locked || (key === 'transfer' && !transfer.departmentSelect.value);
      if (state.busy === key) control.button.textContent = TICKETS_TEXT.working;
      else if (remaining > 0 && state.waitKey === key) control.button.textContent = `請等 ${remaining} 秒`;
      else control.button.textContent = control.label;
    }
    error.textContent = state.error;
  }
  /**
   * 判斷這張單是否暫時不能送出動作（已有請求進行中或限流倒數中）。
   * @returns {boolean} 是否鎖定。
   */
  function locked() { return Boolean(state.busy) || state.remaining() > 0; }
  /**
   * 更新卡片錯誤並重新繪製；錯誤保存在動作狀態中，重新繪製後仍會顯示。
   * @param {string} message 錯誤文字，空字串代表清除。
   * @returns {void}
   */
  function setError(message) {
    state.error = message;
    state.show();
  }
  /**
   * 檢查備註長度，超過時顯示提示並把焦點移到備註欄。
   * @returns {boolean} 是否通過。
   */
  function commentValid() {
    const count = countCodePoints(comment.value);
    if (count > TICKET_LIMITS.comment) { setError(`備註最多 ${TICKET_LIMITS.comment} 字，目前 ${count} 字`); comment.focus(); return false; }
    return true;
  }
  /**
   * 判斷動作錯誤是否需要倒數：429、不是額度用盡，且等待秒數介於 1～300 秒。
   * @param {unknown} failure 動作拋出的錯誤。
   * @returns {number} 要倒數的秒數；不需倒數時為 0。
   */
  function countdownSeconds(failure) {
    if (!(failure instanceof TicketServiceError) || failure.status !== 429 || QUOTA_CODES.includes(failure.code)) return 0;
    return failure.retryAfter > 0 && failure.retryAfter <= MAX_COUNTDOWN_SECONDS ? failure.retryAfter : 0;
  }
  /**
   * 執行一個動作並處理錯誤：同一張單已有請求進行中或在倒數中時直接忽略；
   * 服務錯誤顯示訊息，非預期錯誤只顯示固定提示；429 非額度錯誤依 retryAfter 倒數。
   * 狀態寫入共用的 actionState，並透過 state.show() 繪製到「目前」畫面上的卡片（清單可能已在請求期間重新繪製）；
   * 卡片已不在畫面上時，錯誤由狀態儲存改顯示在清單上方。
   * @param {string} key 觸發的動作代號。
   * @param {Function} run 要執行的非同步動作。
   * @returns {Promise<void>} 動作與狀態更新完成。
   */
  async function perform(key, run) {
    if (locked()) return;
    setError('');
    if (!commentValid()) return;
    let seconds = 0;
    state.busy = key;
    state.show();
    try {
      await run();
    } catch (failure) {
      state.error = failure instanceof TicketServiceError ? failure.message : TICKETS_TEXT.unexpected;
      if (!(failure instanceof TicketServiceError)) console.error(failure);
      seconds = countdownSeconds(failure);
    } finally {
      state.busy = null;
      if (seconds) state.beginWait(seconds, key);
      state.show();
    }
  }
  /** 簽核按鈕。@returns {Promise<void>} */
  function handleApprove() {
    /** 送出本張單的簽核與目前備註。@returns {Promise<void>} 頁面動作結果。 */
    function decide() { return onDecide(ticket.ticket_id, 'APPROVE', comment.value); }
    return perform('approve', decide);
  }
  /** 退回按鈕。@returns {Promise<void>} */
  function handleReject() {
    /** 送出本張單的退回與目前備註。@returns {Promise<void>} 頁面動作結果。 */
    function decide() { return onDecide(ticket.ticket_id, 'REJECT', comment.value); }
    return perform('reject', decide);
  }
  /** 轉單按鈕：請求進行中或倒數中時忽略；必須先選部門。@returns {Promise<void>} */
  function handleTransfer() {
    if (locked()) return Promise.resolve();
    if (!transfer.departmentSelect.value) { setError(TICKETS_TEXT.chooseDepartment); transfer.departmentSelect.focus(); return Promise.resolve(); }
    /** 讀取目前目標部門、處理人與備註並送出。@returns {Promise<void>} 頁面動作結果。 */
    function move() { return onTransfer(ticket.ticket_id, transfer.departmentSelect.value, transfer.handlerSelect.value, comment.value); }
    return perform('transfer', move);
  }
  /** 取消按鈕：請求進行中或倒數中時忽略；部門替提單人取消時必須填原因。@returns {Promise<void>} */
  function handleCancel() {
    if (locked()) return Promise.resolve();
    if (cancelRequiresComment && !comment.value.trim()) { setError(TICKETS_TEXT.cancelReasonRequired); comment.focus(); return Promise.resolve(); }
    /** 送出已通過必要原因檢查的取消操作。@returns {Promise<void>} 頁面動作結果。 */
    function cancelTicket() { return onCancel(ticket.ticket_id, comment.value); }
    return perform('cancel', cancelTicket);
  }
  if (approve) approve.addEventListener('click', handleApprove);
  if (reject) reject.addEventListener('click', handleReject);
  if (cancel) cancel.addEventListener('click', handleCancel);
  if (transfer) transfer.transferButton.addEventListener('click', handleTransfer);
  /** 阻止表單原生提交，操作只透過各按鈕執行。@param {SubmitEvent} event 提交事件。@returns {void} */
  function preventSubmit(event) { event.preventDefault(); }
  form.addEventListener('submit', preventSubmit);
  // 這張表單成為此單號目前的繪製目標；之前建立的舊表單的非同步結果也會寫到這裡。
  state.render = applyState;
  if (transfer) transfer.refreshHandlers();
  else applyState();
  return form;
}
