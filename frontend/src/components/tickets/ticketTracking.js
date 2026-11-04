import { buildTicketCard, findFormType } from './ticketCard.js';
import { describeFormPolicy, ticketTypeId } from '../../utils/formFormatters.js';
import { TICKETS_TEXT } from './ticketText.js';

/**
 * 判斷需求單是否由目前登入者提出：出現在「我的需求單」清單中（後端以 requester.user_id 篩選），或提單人的 user_id 與登入者的 userID 相同。
 * 規則與後端判定提單人取消（requester.user_id === 登入者 userID）完全相同；user_id 缺漏時視為不是本人，不改用 username 比對，
 * 避免畫面顯示原因選填的「取消需求單」、後端卻判定為部門取消而要求原因。只影響畫面上的取消方式，授權仍由後端決定。
 * @param {object} ticket 正規化的需求單。
 * @param {Set<string>} mineIds 「我的需求單」中的單號。
 * @param {object|null} user 目前登入者（userID）；null 時只依 mineIds 判斷。
 * @returns {boolean} 是否為本人提出的單。
 */
function isOwnTicket(ticket, mineIds, user) {
  if (mineIds.has(ticket.ticket_id)) return true;
  return Boolean(user?.userID) && ticket.requester.user_id === user.userID;
}

/**
 * 繪製表單追蹤面板；先顯示送達本部門的待簽核單，再顯示本人提出且尚未重複列出的待簽核單。
 * 同一張單符合兩種身分（本人提出且送達本部門）時保留簽核、退回與轉單，但取消視為提單人取消：
 * 按鈕顯示「取消需求單」且原因選填，與後端記錄的 REQUESTER 一致；其他部門單的取消為「替提單人取消」且必須填原因。
 * 例外：本人提出、且依需求類型（ticketTypeId 查詢目錄）不能由提單人簽核（describeFormPolicy 的 selfApprovable 為 false：定義檔 approver.not_requester，
 * 預設與沒有需求類型的舊流程單都是不能）的單不顯示簽核與退回，因為後端會以 403 拒絕，需由同部門其他成員簽核；取消仍可使用。
 * 已退回區只列本人提出的單，並提供重新提出。此元件只依資料與動作回呼繪製，不自行查詢 API 或判定後端授權。
 * @param {object} state 頁面資料，包含 mine、department、可轉單的 departments 與需求類型目錄 formTypes（null 代表尚未載入）。
 * @param {object} nodes 追蹤面板節點，包含清單、空狀態與計數。
 * @param {object} actions 頁面提供的有權限操作。
 * @param {Function} actions.onDecide 簽核／退回回呼。
 * @param {Function} actions.onTransfer 轉單回呼。
 * @param {Function} actions.onCancel 取消回呼。
 * @param {Function} actions.onResubmit 將退回單帶入草稿的回呼。
 * @param {Function} [actions.actionStateFor] 依單號取得頁面保存的簽核表單動作狀態（處理中、錯誤、倒數）；省略時每張表單自建狀態。
 * @param {object|null} [user=null] 目前登入者（比對 userID），用來辨識送達本部門的單是否為本人提出。
 * @returns {string[]} 待簽核區目前有操作表單的單號（以新卡片取代清單並同步數量與空狀態後回傳，頁面據此清理不再顯示的動作狀態）。
 */
export function renderTicketTracking(state, nodes, { onDecide, onTransfer, onCancel, onResubmit, actionStateFor = null }, user = null) {
  const pending = [];
  const rejected = [];
  const seen = new Set();
  const mineIds = new Set();
  const pendingIds = [];
  /**
   * 取得某張待簽核單的動作狀態並記錄它仍在畫面上。
   * @param {string} ticketId 單號。
   * @returns {object|null} 頁面保存的動作狀態；頁面沒有提供時為 null。
   */
  function stateFor(ticketId) {
    pendingIds.push(ticketId);
    return actionStateFor ? actionStateFor(ticketId) : null;
  }
  const formTypes = state.formTypes ?? null;
  for (const ticket of state.mine) mineIds.add(ticket.ticket_id);
  for (const ticket of state.department?.tickets ?? []) {
    if (ticket.status !== 'PENDING') continue;
    seen.add(ticket.ticket_id);
    const own = isOwnTicket(ticket, mineIds, user);
    const typeId = ticketTypeId(ticket);
    const selfBlocked = own && !describeFormPolicy(ticket, typeId ? findFormType(formTypes, typeId) : null).selfApprovable;
    pending.push(buildTicketCard(ticket, { showRequester: true, tag: TICKETS_TEXT.tagDepartment, onDecide: selfBlocked ? null : onDecide, onTransfer,
      departments: state.departments, onCancel, cancelRequiresComment: !own, actionState: stateFor(ticket.ticket_id), formTypes }));
  }
  for (const ticket of state.mine) {
    if (ticket.status === 'PENDING' && !seen.has(ticket.ticket_id)) pending.push(buildTicketCard(ticket, { tag: TICKETS_TEXT.tagMine, onCancel, actionState: stateFor(ticket.ticket_id), formTypes }));
    if (ticket.status === 'REJECTED') rejected.push(buildTicketCard(ticket, { tag: TICKETS_TEXT.tagMine, onResubmit, formTypes }));
  }
  nodes.listPending.replaceChildren(...pending);
  nodes.empties.pending.hidden = pending.length > 0;
  nodes.counts.pending.textContent = pending.length ? String(pending.length) : '';
  nodes.listRejected.replaceChildren(...rejected);
  nodes.empties.rejected.hidden = rejected.length > 0;
  nodes.counts.rejected.textContent = rejected.length ? String(rejected.length) : '';
  const total = pending.length + rejected.length;
  nodes.counts.tracking.textContent = total ? String(total) : '';
  return pendingIds;
}
