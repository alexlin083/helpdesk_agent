import { element } from './dom.js';
import { countCodePoints, TICKET_LIMITS, TicketServiceError } from '../services/ticketService.js';
import { TICKETS_TEXT } from './ticketText.js';

/**
 * 建立待簽核需求單的操作表單，管理備註驗證、部門／處理人選擇、按鈕鎖定與卡片內錯誤。
 * 元件不直接呼叫 API；由頁面注入有權限的動作，成功後頁面負責重新載入清單。
 * @param {object} ticket 正規化的待簽核需求單。
 * @param {object} options 可用動作；卡片只在至少可簽核或取消時建立此表單。
 * @param {Function|null} options.onDecide 簽核／退回回呼，接收單號、動作與備註。
 * @param {Function|null} options.onTransfer 轉單回呼，接收單號、部門、處理人與備註。
 * @param {Array<object>|null} options.departments 可轉到的部門；null 時停用轉單。
 * @param {Function|null} options.onCancel 取消回呼，接收單號與原因。
 * @param {boolean} options.cancelRequiresComment 是否強制填寫取消原因。
 * @returns {HTMLFormElement} 已綁定事件的表單；重複繪製應建立新表單取代舊節點。
 */
export function buildTicketActions(ticket, { onDecide, onTransfer, departments, onCancel, cancelRequiresComment }) {
  const form = element('form', 'decision-form');
  const label = element('label', '', onDecide ? '備註（選填）' : '取消原因（選填）');
  label.setAttribute('for', `comment-${ticket.ticket_id}`);
  const comment = element('textarea');
  comment.setAttribute('id', `comment-${ticket.ticket_id}`);
  comment.setAttribute('rows', '3');
  const help = element('p', 'decision-help', onDecide ? `最多 ${TICKET_LIMITS.comment} 字；退回或替提單人取消時請說明原因` : `最多 ${TICKET_LIMITS.comment} 字；取消後不能復原，需要時請再提一張`);
  const error = element('p', 'decision-error');
  error.setAttribute('role', 'alert');
  const actions = element('div', 'decision-actions');
  const buttons = [];
  let cancel = null;
  if (onCancel) {
    cancel = element('button', 'link-button cancel-button', onDecide ? TICKETS_TEXT.cancelForRequester : TICKETS_TEXT.cancel);
    cancel.setAttribute('type', 'button');
    actions.append(cancel);
    buttons.push(cancel);
  }
  let approve = null;
  let reject = null;
  if (onDecide) {
    reject = element('button', 'secondary-button reject-button', TICKETS_TEXT.reject);
    reject.setAttribute('type', 'button');
    approve = element('button', 'primary-button approve-button', TICKETS_TEXT.approve);
    approve.setAttribute('type', 'button');
    actions.append(reject, approve);
    buttons.push(approve, reject);
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
    const transferButton = element('button', 'secondary-button transfer-button', TICKETS_TEXT.transfer);
    transferButton.setAttribute('type', 'button');
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
      transferButton.disabled = !selected;
    }
    departmentSelect.disabled = !departments || !options.length;
    refreshHandlers();
    departmentSelect.addEventListener('change', refreshHandlers);
    wrapper.append(targetLabel, departmentSelect, handlerSelect, transferButton);
    form.append(wrapper);
    transfer = { departmentSelect, handlerSelect, transferButton };
    buttons.push(transferButton);
  }
  form.append(actions);

  /**
   * 鎖住或解除卡片內所有動作按鈕，處理中的按鈕顯示「處理中…」。
   * @param {HTMLElement|null} active 正在處理的按鈕。
   * @param {string} [original=''] 處理完成後要恢復的文字。
   * @returns {void}
   */
  function setBusy(active, original = '') {
    for (const button of buttons) button.disabled = Boolean(active) || (button === transfer?.transferButton && !transfer.departmentSelect.value);
    if (active) active.textContent = TICKETS_TEXT.working;
    else if (original) for (const button of buttons) if (button.textContent === TICKETS_TEXT.working) button.textContent = original;
  }
  /**
   * 檢查備註長度，超過時顯示提示並把焦點移到備註欄。
   * @returns {boolean} 是否通過。
   */
  function commentValid() {
    const count = countCodePoints(comment.value);
    if (count > TICKET_LIMITS.comment) { error.textContent = `備註最多 ${TICKET_LIMITS.comment} 字，目前 ${count} 字`; comment.focus(); return false; }
    return true;
  }
  /**
   * 執行一個動作並處理錯誤：服務錯誤顯示訊息，非預期錯誤只顯示固定提示。
   * @param {HTMLElement} button 觸發的按鈕。
   * @param {Function} run 要執行的非同步動作。
   * @returns {Promise<void>}
   */
  async function perform(button, run) {
    error.textContent = '';
    if (!commentValid()) return;
    const original = button.textContent;
    setBusy(button);
    try {
      await run();
    } catch (failure) {
      error.textContent = failure instanceof TicketServiceError ? failure.message : TICKETS_TEXT.unexpected;
      if (!(failure instanceof TicketServiceError)) console.error(failure);
    } finally {
      setBusy(null, original);
    }
  }
  /** 簽核按鈕。@returns {Promise<void>} */
  function handleApprove() {
    /** 送出本張單的簽核與目前備註。@returns {Promise<void>} 頁面動作結果。 */
    function decide() { return onDecide(ticket.ticket_id, 'APPROVE', comment.value); }
    return perform(approve, decide);
  }
  /** 退回按鈕。@returns {Promise<void>} */
  function handleReject() {
    /** 送出本張單的退回與目前備註。@returns {Promise<void>} 頁面動作結果。 */
    function decide() { return onDecide(ticket.ticket_id, 'REJECT', comment.value); }
    return perform(reject, decide);
  }
  /** 轉單按鈕：必須先選部門。@returns {Promise<void>} */
  function handleTransfer() {
    if (!transfer.departmentSelect.value) { error.textContent = TICKETS_TEXT.chooseDepartment; transfer.departmentSelect.focus(); return Promise.resolve(); }
    /** 讀取目前目標部門、處理人與備註並送出。@returns {Promise<void>} 頁面動作結果。 */
    function move() { return onTransfer(ticket.ticket_id, transfer.departmentSelect.value, transfer.handlerSelect.value, comment.value); }
    return perform(transfer.transferButton, move);
  }
  /** 取消按鈕：部門替提單人取消時必須填原因。@returns {Promise<void>} */
  function handleCancel() {
    if (cancelRequiresComment && !comment.value.trim()) { error.textContent = TICKETS_TEXT.cancelReasonRequired; comment.focus(); return Promise.resolve(); }
    /** 送出已通過必要原因檢查的取消操作。@returns {Promise<void>} 頁面動作結果。 */
    function cancelTicket() { return onCancel(ticket.ticket_id, comment.value); }
    return perform(cancel, cancelTicket);
  }
  if (approve) approve.addEventListener('click', handleApprove);
  if (reject) reject.addEventListener('click', handleReject);
  if (cancel) cancel.addEventListener('click', handleCancel);
  if (transfer) transfer.transferButton.addEventListener('click', handleTransfer);
  /** 阻止表單原生提交，操作只透過各按鈕執行。@param {SubmitEvent} event 提交事件。@returns {void} */
  function preventSubmit(event) { event.preventDefault(); }
  form.addEventListener('submit', preventSubmit);
  return form;
}
