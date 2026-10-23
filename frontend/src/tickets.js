import { authService } from './services/authService.js';
import { loadMyTickets, loadDepartmentTickets, loadCompletedTickets, decideTicket, transferTicket, cancelTicket, loadDepartments, countCodePoints, TICKET_LIMITS, TicketServiceError, STATUS_LABELS, COMPLETED_DEFAULT_LIMIT, DRAFT_KEY } from './services/ticketService.js';
import { initAccountMenu } from './components/account.js';
import { element } from './components/dom.js';

export const TICKETS_TEXT = {
  loading: '載入中…',
  unexpected: '發生未預期的錯誤，請稍後再試',
  approve: '簽核',
  reject: '退回',
  working: '處理中…',
  decided: '已更新這張需求單的狀態',
  transfer: '轉單',
  transferred: '已把需求單轉到其他部門',
  transferUnavailable: '無法載入部門名單，暫時不能轉單；請重新整理頁面',
  chooseDepartment: '請選擇要轉到的部門',
  noHandler: '不指定處理人',
  searching: '查詢中…',
  cancel: '取消需求單',
  cancelForRequester: '替提單人取消',
  cancelled: '已取消這張需求單',
  cancelReasonRequired: '替提單人取消時必須填寫原因',
  tagMine: '我提出的',
  tagDepartment: '待本部門簽核',
  resubmit: '重新提出',
  resubmitHelp: '被退回的單不會自動重送；按下後會把主題與內容帶到提出需求單頁，修改後再送出',
};
const TAB_NAMES = ['tracking', 'completed'];

/**
 * 取得台北時間的日期字串，供「今天」「近 N 天」快速條件使用。
 * @param {number} [daysAgo=0] 往前推的天數。
 * @param {number} [now=Date.now()] 基準時間（epoch 毫秒）。
 * @returns {string} YYYY-MM-DD。
 */
export function taipeiDateString(daysAgo = 0, now = Date.now()) {
  return new Date(now + 8 * 3600000 - daysAgo * 86400000).toISOString().slice(0, 10);
}

/**
 * 依常用區間算出日期範圍。
 * @param {'today'|'7'|'30'|'all'} range 區間代號。
 * @param {number} [now=Date.now()] 基準時間。
 * @returns {{from: string, to: string}} 起迄日期；不限日期時兩者為空字串。
 */
export function quickRange(range, now = Date.now()) {
  if (range === 'all') return { from: '', to: '' };
  const days = range === 'today' ? 0 : Number(range) - 1;
  return { from: taipeiDateString(days, now), to: taipeiDateString(0, now) };
}

/**
 * 組出已完成清單的摘要文字。
 * @param {number} total 符合條件的總筆數。
 * @param {number} shown 實際顯示的筆數。
 * @param {number} limit 筆數上限。
 * @returns {string} 例如「符合條件 120 筆，顯示最新 100 筆」。
 */
export function describeSummary(total, shown, limit) {
  if (total === 0) return '符合條件 0 筆';
  return total > shown ? `符合條件 ${total} 筆，顯示最新 ${shown} 筆（上限 ${limit} 筆）` : `符合條件 ${total} 筆`;
}
const ROUTE_LABELS = { HANDLER: '已指定處理人，直接送達', DEPARTMENT: 'AI 依主題與內容判斷部門', FALLBACK: '內容未對應到明確部門，先送預設部門' };
const EVENT_LABELS = { SUBMITTED: '送出需求單', APPROVED: '簽核', REJECTED: '退回', TRANSFERRED: '轉單', CANCELLED: '取消' };

/**
 * 組出歷程一筆的說明文字；轉單事件包含來源、目標部門與處理人。
 * @param {object} item 正規化的歷程項目。
 * @returns {string} 例如「轉單・racky.huang：資訊管理一部 → 資訊管理二部（cindy.wang），AI 判斷錯誤」。
 */
export function describeHistory(item) {
  let text = `${EVENT_LABELS[item.event] ?? item.event}${item.by_username ? `・${item.by_username}` : ''}`;
  if (item.event === 'TRANSFERRED' && item.to_department_name) {
    text += `：${item.from_department_name || '—'} → ${item.to_department_name}${item.to_handler_name ? `（${item.to_handler_name}）` : ''}`;
    if (item.comment) text += `，${item.comment}`;
    return text;
  }
  return item.comment ? `${text}：${item.comment}` : text;
}

/**
 * 將 ISO 時間轉成台北時間的簡短字串；無法解析時回傳原字串。
 * @param {string} value ISO 8601 時間。
 * @returns {string} 例如 2026/10/23 14:05。
 */
export function formatTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * 組出需求單的送達文字：有處理人時為「姓名（部門）」，否則為部門名稱。
 * @param {object} ticket 正規化的需求單。
 * @returns {string} 送達文字。
 */
export function describeTarget(ticket) {
  return ticket.handler ? `${ticket.handler.name}（${ticket.department_name}）` : ticket.department_name;
}

/**
 * 建立一張需求單卡片（可展開），含摘要列、詳細欄位與歷程；待簽核且可簽核時附簽核表單，已退回且可重新提出時附「重新提出」按鈕。
 * @param {object} ticket 正規化的需求單。
 * @param {object} options 顯示選項。
 * @param {boolean} [options.showRequester=false] 是否顯示提單人（部門待簽核與已完成清單用）。
 * @param {string} [options.tag=''] 摘要列的身分標籤，例如「我提出的」「待本部門簽核」；空字串不顯示。
 * @param {Function|null} [options.onDecide=null] 簽核回呼 (ticketId, action, comment) => Promise；null 表示不可簽核。
 * @param {Function|null} [options.onTransfer=null] 轉單回呼 (ticketId, departmentId, handlerId, comment) => Promise；null 表示不可轉單。
 * @param {Array<object>|null} [options.departments=null] 可轉到的部門名單（含處理人）；null 代表名單尚未載入或載入失敗。
 * @param {Function|null} [options.onCancel=null] 取消回呼 (ticketId, comment) => Promise；null 表示不可取消。
 * @param {boolean} [options.cancelRequiresComment=false] 取消是否必須填原因（部門替提單人取消時為 true）。
 * @param {Function|null} [options.onResubmit=null] 重新提出回呼 (ticket) => void；只有已退回的單會顯示按鈕。
 * @returns {HTMLElement} 卡片元素。
 */
export function buildTicketCard(ticket, { showRequester = false, tag = '', onDecide = null, onTransfer = null, departments = null, onCancel = null, cancelRequiresComment = false, onResubmit = null } = {}) {
  const card = element('details', 'ticket-card');
  card.setAttribute('data-ticket-id', ticket.ticket_id);
  const summary = element('summary', 'ticket-summary');
  const head = element('div');
  head.append(element('p', 'ticket-subject', ticket.subject));
  const meta = element('p', 'ticket-meta');
  if (tag) meta.append(element('span', 'ticket-tag', tag));
  meta.append(element('span', 'ticket-id', ticket.ticket_id), element('span', '', `送達：${describeTarget(ticket)}`), element('span', '', formatTime(ticket.created_at)));
  if (showRequester && ticket.requester.username) meta.append(element('span', '', `提單人：${ticket.requester.username}`));
  head.append(meta);
  summary.append(head, element('span', `status status-${ticket.status}`, STATUS_LABELS[ticket.status]));
  card.append(summary);

  const body = element('div', 'ticket-body');
  const fields = element('dl', 'ticket-fields');
  /**
   * 加入一列欄位。
   * @param {string} label 欄位名稱。
   * @param {string} value 內容。
   * @returns {void}
   */
  function row(label, value) {
    const item = element('div', 'ticket-row');
    item.append(element('dt', '', label), element('dd', '', value));
    fields.append(item);
  }
  row('需求內容', ticket.content);
  row('方式', ROUTE_LABELS[ticket.route]);
  if (ticket.judgement?.basis) row('判斷依據', ticket.judgement.basis);
  if (ticket.requester.username) row('提單人', ticket.requester.department_name ? `${ticket.requester.username}（${ticket.requester.department_name}）` : ticket.requester.username);
  if (ticket.decision) {
    const label = ticket.status === 'CANCELLED' ? (ticket.decision.cancelled_by === 'DEPARTMENT' ? '取消（部門）' : '取消（提單人）') : ticket.status === 'REJECTED' ? '退回' : '簽核';
    row(label, `${ticket.decision.by_username || '—'} · ${formatTime(ticket.decision.at)}${ticket.decision.comment ? `\n備註：${ticket.decision.comment}` : ''}`);
  }
  const transfers = ticket.history.filter((item) => item.event === 'TRANSFERRED');
  if (transfers.length) row('轉單', transfers.map((item) => `${item.from_department_name || '—'} → ${item.to_department_name}${item.to_handler_name ? `（${item.to_handler_name}）` : ''} · ${item.by_username || '—'} · ${formatTime(item.at)}`).join('\n'));
  body.append(fields);

  if (ticket.history.length) {
    const history = element('ol', 'ticket-history');
    for (const item of ticket.history) {
      const line = element('li');
      const time = element('time', '', formatTime(item.at));
      time.setAttribute('datetime', item.at);
      line.append(time, element('span', '', describeHistory(item)));
      history.append(line);
    }
    body.append(history);
  }

  if (ticket.status === 'REJECTED' && onResubmit) {
    const wrapper = element('div', 'resubmit-row');
    const button = element('button', 'primary-button resubmit-button', TICKETS_TEXT.resubmit);
    button.setAttribute('type', 'button');
    /** 把這張單的內容帶到提出需求單頁。@returns {void} */
    function handleResubmit() { onResubmit(ticket); }
    button.addEventListener('click', handleResubmit);
    wrapper.append(element('p', 'decision-help', TICKETS_TEXT.resubmitHelp), button);
    body.append(wrapper);
  }

  if (ticket.status === 'PENDING' && (onDecide || onCancel)) {
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
      const options = (departments ?? []).filter((department) => department.id !== ticket.department_id);
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
        const selected = options.find((department) => department.id === departmentSelect.value);
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
    function handleApprove() { return perform(approve, () => onDecide(ticket.ticket_id, 'APPROVE', comment.value)); }
    /** 退回按鈕。@returns {Promise<void>} */
    function handleReject() { return perform(reject, () => onDecide(ticket.ticket_id, 'REJECT', comment.value)); }
    /** 轉單按鈕：必須先選部門。@returns {Promise<void>} */
    function handleTransfer() {
      if (!transfer.departmentSelect.value) { error.textContent = TICKETS_TEXT.chooseDepartment; transfer.departmentSelect.focus(); return Promise.resolve(); }
      return perform(transfer.transferButton, () => onTransfer(ticket.ticket_id, transfer.departmentSelect.value, transfer.handlerSelect.value, comment.value));
    }
    /** 取消按鈕：部門替提單人取消時必須填原因。@returns {Promise<void>} */
    function handleCancel() {
      if (cancelRequiresComment && !comment.value.trim()) { error.textContent = TICKETS_TEXT.cancelReasonRequired; comment.focus(); return Promise.resolve(); }
      return perform(cancel, () => onCancel(ticket.ticket_id, comment.value));
    }
    if (approve) approve.addEventListener('click', handleApprove);
    if (reject) reject.addEventListener('click', handleReject);
    if (cancel) cancel.addEventListener('click', handleCancel);
    if (transfer) transfer.transferButton.addEventListener('click', handleTransfer);
    form.addEventListener('submit', (event) => event.preventDefault());
    body.append(form);
  }
  card.append(body);
  return card;
}

/**
 * 初始化狀態追蹤頁：登入守門、「表單追蹤」（待簽核與已退回）與「已完成」兩個分頁的載入與繪製、簽核／轉單／取消動作、重新提出與重新整理。
 * @param {Document} [doc=document] 頁面文件，測試可注入替身。
 * @param {Window} [win=window] 視窗物件，提供 hash、sessionStorage 與導頁。
 * @param {object} [services={}] 可注入的服務替身（auth、loadMyTickets、loadDepartmentTickets、loadCompletedTickets、decideTicket、transferTicket、cancelTicket、loadDepartments）。
 * @returns {object|null} 頁面控制器（ready、refresh、selectTab、loadCompleted、state、leave），未登入時回傳 null。
 */
export function initTicketsPage(doc = document, win = window, services = {}) {
  const auth = services.auth ?? authService;
  const fetchMine = services.loadMyTickets ?? loadMyTickets;
  const fetchDepartment = services.loadDepartmentTickets ?? loadDepartmentTickets;
  const sendDecision = services.decideTicket ?? decideTicket;
  const sendTransfer = services.transferTicket ?? transferTicket;
  const sendCancel = services.cancelTicket ?? cancelTicket;
  const fetchDepartments = services.loadDepartments ?? loadDepartments;
  const fetchCompleted = services.loadCompletedTickets ?? loadCompletedTickets;
  const { user, leave } = initAccountMenu(doc, win, auth);
  if (!user) return null;

  const nodes = {
    refresh: doc.querySelector('#refresh-button'),
    tabs: { tracking: doc.querySelector('#tab-tracking'), completed: doc.querySelector('#tab-completed') },
    panels: { tracking: doc.querySelector('#panel-tracking'), completed: doc.querySelector('#panel-completed') },
    counts: { tracking: doc.querySelector('#count-tracking'), pending: doc.querySelector('#count-pending'), rejected: doc.querySelector('#count-rejected') },
    notices: { tracking: doc.querySelector('#notice-tracking'), completed: doc.querySelector('#notice-completed') },
    empties: { pending: doc.querySelector('#empty-pending'), rejected: doc.querySelector('#empty-rejected'), completed: doc.querySelector('#empty-completed') },
    pendingHint: doc.querySelector('#pending-hint'),
    listPending: doc.querySelector('#list-pending'),
    listRejected: doc.querySelector('#list-rejected'),
    completedTitle: doc.querySelector('#completed-title'),
    filterForm: doc.querySelector('#filter-form'),
    filterKeyword: doc.querySelector('#filter-q'),
    filterStatus: doc.querySelector('#filter-status'),
    filterFrom: doc.querySelector('#filter-from'),
    filterTo: doc.querySelector('#filter-to'),
    filterReset: doc.querySelector('#filter-reset'),
    filterSubmit: doc.querySelector('#filter-submit'),
    quickButtons: doc.querySelectorAll('.chip-button'),
    summary: doc.querySelector('#completed-summary'),
    listCompleted: doc.querySelector('#list-completed'),
  };
  const state = { tab: 'tracking', mine: [], department: null, departments: null, completed: null, completedLoaded: false, completedRequest: null, loading: false };
  nodes.pendingHint.textContent = `你送出且還在等待的需求單，以及送達「${user.department.name}」等你簽核的需求單`;
  nodes.completedTitle.textContent = `你提出且已結案的需求單，以及「${user.department.name}」的簽核紀錄（已簽核、已退回、已取消），預設顯示最新 ${COMPLETED_DEFAULT_LIMIT} 筆`;

  /**
   * 顯示或清除某個分頁上方的提示。
   * @param {'tracking'|'completed'} tab 分頁。
   * @param {string} message 提示文字，空字串代表隱藏。
   * @returns {void}
   */
  function setNotice(tab, message) {
    nodes.notices[tab].textContent = message;
    nodes.notices[tab].hidden = !message;
  }

  /**
   * 把載入或動作的錯誤轉成提示；憑證失效回登入頁。
   * @param {'tracking'|'completed'} tab 分頁。
   * @param {unknown} error 錯誤。
   * @returns {void}
   */
  function showError(tab, error) {
    if (error?.status === 401 || error?.code === 'LOGIN_REQUIRED') { leave(); return; }
    if (!(error instanceof TicketServiceError)) console.error(error);
    setNotice(tab, error instanceof TicketServiceError ? error.message : TICKETS_TEXT.unexpected);
  }

  /**
   * 執行一個會改變需求單狀態的動作，成功後顯示提示並重新載入表單追蹤。
   * @param {Function} run 非同步動作。
   * @param {string} message 成功提示。
   * @returns {Promise<void>}
   */
  async function act(run, message) {
    await run();
    setNotice('tracking', message);
    await loadTracking(false);
  }
  /**
   * 取消需求單（提單人取消自己的單，或部門替提單人取消）。
   * @param {string} ticketId 單號。
   * @param {string} comment 原因。
   * @returns {Promise<void>}
   */
  function handleCancel(ticketId, comment) { return act(() => sendCancel(ticketId, comment), TICKETS_TEXT.cancelled); }
  /**
   * 簽核或退回。
   * @param {string} ticketId 單號。
   * @param {'APPROVE'|'REJECT'} action 動作。
   * @param {string} comment 備註。
   * @returns {Promise<void>}
   */
  function handleDecide(ticketId, action, comment) { return act(() => sendDecision(ticketId, action, comment), TICKETS_TEXT.decided); }
  /**
   * 轉單到其他部門。
   * @param {string} ticketId 單號。
   * @param {string} departmentId 目標部門。
   * @param {string} handlerId 目標處理人（可空）。
   * @param {string} comment 備註。
   * @returns {Promise<void>}
   */
  function handleTransfer(ticketId, departmentId, handlerId, comment) { return act(() => sendTransfer(ticketId, departmentId, handlerId, comment), TICKETS_TEXT.transferred); }

  /**
   * 重新提出被退回的單：把主題與內容存進本分頁的 sessionStorage 草稿，再前往提出需求單頁帶入。
   * @param {object} ticket 被退回的需求單。
   * @returns {void}
   */
  function handleResubmit(ticket) {
    try { win.sessionStorage?.setItem(DRAFT_KEY, JSON.stringify({ subject: ticket.subject, content: ticket.content })); } catch { /* 儲存體不可用時仍前往提出需求單頁，只是不帶入內容 */ }
    win.location.href = './propose.html';
  }

  /**
   * 繪製「表單追蹤」：待簽核區先列送達本部門等我簽核的單（可簽核、轉單、替提單人取消），再列我送出還在等待的單（可取消）；
   * 同一張單同時符合兩者時只列一次並保留簽核操作。已退回區列我被退回的單，可重新提出。
   * @returns {void}
   */
  function renderTracking() {
    const departmentPending = (state.department?.tickets ?? []).filter((ticket) => ticket.status === 'PENDING');
    const seen = new Set(departmentPending.map((ticket) => ticket.ticket_id));
    const minePending = state.mine.filter((ticket) => ticket.status === 'PENDING' && !seen.has(ticket.ticket_id));
    const rejected = state.mine.filter((ticket) => ticket.status === 'REJECTED');
    const pendingCards = [
      ...departmentPending.map((ticket) => buildTicketCard(ticket, { showRequester: true, tag: TICKETS_TEXT.tagDepartment, onDecide: handleDecide, onTransfer: handleTransfer, departments: state.departments, onCancel: handleCancel, cancelRequiresComment: true })),
      ...minePending.map((ticket) => buildTicketCard(ticket, { tag: TICKETS_TEXT.tagMine, onCancel: handleCancel })),
    ];
    nodes.listPending.replaceChildren(...pendingCards);
    nodes.empties.pending.hidden = pendingCards.length > 0;
    nodes.counts.pending.textContent = pendingCards.length ? String(pendingCards.length) : '';
    nodes.listRejected.replaceChildren(...rejected.map((ticket) => buildTicketCard(ticket, { tag: TICKETS_TEXT.tagMine, onResubmit: handleResubmit })));
    nodes.empties.rejected.hidden = rejected.length > 0;
    nodes.counts.rejected.textContent = rejected.length ? String(rejected.length) : '';
    const total = pendingCards.length + rejected.length;
    nodes.counts.tracking.textContent = total ? String(total) : '';
  }

  /**
   * 讀取篩選表單目前的條件。
   * @returns {{status: string, q: string, from: string, to: string}} 條件。
   */
  function currentFilters() {
    return { status: nodes.filterStatus.value || '', q: nodes.filterKeyword.value || '', from: nodes.filterFrom.value || '', to: nodes.filterTo.value || '' };
  }

  /** 繪製「已完成」分頁的清單與摘要。@returns {void} */
  function renderCompleted() {
    const result = state.completed;
    const tickets = result?.tickets ?? [];
    nodes.listCompleted.replaceChildren(...tickets.map((ticket) => buildTicketCard(ticket, { showRequester: true, tag: ticket.requester.username === user.username ? TICKETS_TEXT.tagMine : '' })));
    nodes.empties.completed.hidden = !result || tickets.length > 0;
    nodes.summary.textContent = result ? describeSummary(result.total, tickets.length, result.limit) : '';
  }

  /**
   * 依目前條件載入已完成清單；條件無效時顯示提示而不送出。
   * @returns {Promise<void>}
   */
  async function loadCompleted() {
    const filters = currentFilters();
    if (filters.from && filters.to && filters.from > filters.to) { setNotice('completed', '起始日期不可晚於結束日期'); nodes.filterFrom.focus(); return; }
    setNotice('completed', TICKETS_TEXT.searching);
    nodes.filterSubmit.disabled = true;
    try {
      state.completed = await fetchCompleted(filters);
      state.completedLoaded = true;
      setNotice('completed', '');
      renderCompleted();
    } catch (error) { showError('completed', error); }
    finally { nodes.filterSubmit.disabled = false; }
  }

  /**
   * 處理篩選表單送出。
   * @param {Event} event 表單事件。
   * @returns {Promise<void>}
   */
  function handleFilterSubmit(event) { event.preventDefault(); return loadCompleted(); }

  /** 清除所有條件並重新查詢。@returns {Promise<void>} */
  function handleFilterReset() {
    nodes.filterKeyword.value = '';
    nodes.filterStatus.value = '';
    nodes.filterFrom.value = '';
    nodes.filterTo.value = '';
    return loadCompleted();
  }

  /**
   * 套用常用區間並立即查詢。
   * @param {Event} event 按鈕事件，按鈕的 data-range 為區間代號。
   * @returns {Promise<void>}
   */
  function handleQuickRange(event) {
    const range = quickRange(event.currentTarget.getAttribute('data-range'));
    nodes.filterFrom.value = range.from;
    nodes.filterTo.value = range.to;
    return loadCompleted();
  }

  /**
   * 載入表單追蹤需要的兩份清單（我的需求單、送達本部門的需求單）並繪製；任一份失敗時顯示提示，另一份仍照常顯示。
   * @param {boolean} [announce=true] 是否先顯示載入中提示（動作後重新載入時保留成功提示）。
   * @returns {Promise<void>}
   */
  async function loadTracking(announce = true) {
    if (announce) setNotice('tracking', TICKETS_TEXT.loading);
    const [mine, department] = await Promise.allSettled([fetchMine(), fetchDepartment()]);
    if (mine.status === 'fulfilled') state.mine = mine.value;
    if (department.status === 'fulfilled') state.department = department.value;
    const failure = mine.status === 'rejected' ? mine.reason : department.status === 'rejected' ? department.reason : null;
    if (failure) showError('tracking', failure);
    else if (announce) setNotice('tracking', '');
    renderTracking();
  }

  /**
   * 切換分頁並更新 aria 狀態；第一次切到「已完成」時才載入清單。
   * @param {'tracking'|'completed'} tab 分頁。
   * @returns {void}
   */
  function selectTab(tab) {
    state.tab = tab;
    for (const name of TAB_NAMES) {
      nodes.tabs[name].setAttribute('aria-selected', String(name === tab));
      nodes.panels[name].hidden = name !== tab;
    }
    if (tab === 'completed' && !state.completedLoaded) state.completedRequest = loadCompleted();
  }

  /**
   * 載入可轉單的部門名單；失敗時轉單選單停用，不影響簽核。
   * @returns {Promise<void>}
   */
  async function loadTransferTargets() {
    try { state.departments = await fetchDepartments(); } catch (error) {
      if (error?.status === 401 || error?.code === 'LOGIN_REQUIRED') { leave(); return; }
      if (!(error instanceof TicketServiceError)) console.error(error);
      state.departments = null;
    }
  }

  /** 重新載入清單與部門名單；已完成分頁只在看過之後才一起重新查詢。@returns {Promise<void>} */
  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    nodes.refresh.disabled = true;
    try {
      const jobs = [loadTransferTargets().then(() => loadTracking())];
      if (state.completedLoaded) jobs.push(loadCompleted());
      await Promise.all(jobs);
    } finally { state.loading = false; nodes.refresh.disabled = false; }
  }

  /** 切到表單追蹤。@returns {void} */
  function showTracking() { selectTab('tracking'); }
  /** 切到已完成。@returns {void} */
  function showCompleted() { selectTab('completed'); }
  nodes.tabs.tracking.addEventListener('click', showTracking);
  nodes.tabs.completed.addEventListener('click', showCompleted);
  nodes.refresh.addEventListener('click', refresh);
  nodes.filterForm.addEventListener('submit', handleFilterSubmit);
  nodes.filterReset.addEventListener('click', handleFilterReset);
  for (const button of nodes.quickButtons) button.addEventListener('click', handleQuickRange);
  /**
   * 依網址的 hash 決定分頁：#completed 為已完成，其餘為表單追蹤。
   * @returns {'tracking'|'completed'} 分頁名稱。
   */
  function tabFromHash() { return (win.location?.hash ?? '') === '#completed' ? 'completed' : 'tracking'; }
  /** 同一頁面內 hash 改變時切換分頁。@returns {void} */
  function handleHashChange() { selectTab(tabFromHash()); }
  win.addEventListener('hashchange', handleHashChange);
  selectTab(tabFromHash());
  doc.body.hidden = false;
  const ready = refresh();
  return { ready, refresh, selectTab, loadCompleted, state, leave };
}

// 真實瀏覽器載入時自動初始化；測試以替身文件明確呼叫 initTicketsPage。
if (typeof document !== 'undefined' && typeof document.readyState === 'string') initTicketsPage();
