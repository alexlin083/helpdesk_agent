import { buildTicketCard } from './ticketCard.js';
import { TICKETS_TEXT } from './ticketText.js';

/**
 * 繪製表單追蹤面板；先顯示送達本部門的待簽核單，再顯示本人提出且尚未重複列出的待簽核單。
 * 同一張單符合兩種身分時保留部門操作；已退回區只列本人提出的單，並提供重新提出。
 * 此元件只依資料與動作回呼繪製，不自行查詢 API 或判定後端授權。
 * @param {object} state 頁面資料，包含 mine、department 與可轉單的 departments。
 * @param {object} nodes 追蹤面板節點，包含清單、空狀態與計數。
 * @param {object} actions 頁面提供的有權限操作。
 * @param {Function} actions.onDecide 簽核／退回回呼。
 * @param {Function} actions.onTransfer 轉單回呼。
 * @param {Function} actions.onCancel 取消回呼。
 * @param {Function} actions.onResubmit 將退回單帶入草稿的回呼。
 * @returns {void} 以新卡片取代清單並同步數量與空狀態。
 */
export function renderTicketTracking(state, nodes, { onDecide, onTransfer, onCancel, onResubmit }) {
  const pending = [];
  const rejected = [];
  const seen = new Set();
  for (const ticket of state.department?.tickets ?? []) {
    if (ticket.status !== 'PENDING') continue;
    seen.add(ticket.ticket_id);
    pending.push(buildTicketCard(ticket, { showRequester: true, tag: TICKETS_TEXT.tagDepartment, onDecide, onTransfer,
      departments: state.departments, onCancel, cancelRequiresComment: true }));
  }
  for (const ticket of state.mine) {
    if (ticket.status === 'PENDING' && !seen.has(ticket.ticket_id)) pending.push(buildTicketCard(ticket, { tag: TICKETS_TEXT.tagMine, onCancel }));
    if (ticket.status === 'REJECTED') rejected.push(buildTicketCard(ticket, { tag: TICKETS_TEXT.tagMine, onResubmit }));
  }
  nodes.listPending.replaceChildren(...pending);
  nodes.empties.pending.hidden = pending.length > 0;
  nodes.counts.pending.textContent = pending.length ? String(pending.length) : '';
  nodes.listRejected.replaceChildren(...rejected);
  nodes.empties.rejected.hidden = rejected.length > 0;
  nodes.counts.rejected.textContent = rejected.length ? String(rejected.length) : '';
  const total = pending.length + rejected.length;
  nodes.counts.tracking.textContent = total ? String(total) : '';
}
