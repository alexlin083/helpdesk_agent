import { buildTicketCard, findFormType } from './ticketCard.js';
import { describeFormPolicy, ticketTypeId } from '../../utils/formFormatters.js';
import { TICKETS_TEXT } from './ticketText.js';

// 「申請表單」兩個區塊各自包含的狀態：待簽核含被退回的單（還需要本人處理），已完成為已簽核與已取消。
const MINE_PENDING_STATUSES = new Set(['PENDING', 'REJECTED']);
const MINE_DONE_STATUSES = new Set(['APPROVED', 'CANCELLED']);

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
 * 以新節點取代清單並同步空狀態與計數。
 * @param {HTMLElement} list 清單節點。
 * @param {HTMLElement} empty 空狀態節點。
 * @param {HTMLElement|null} count 計數節點；沒有時不更新。
 * @param {HTMLElement[]} cards 卡片。
 * @returns {void}
 */
function fill(list, empty, count, cards) {
  list.replaceChildren(...cards);
  empty.hidden = cards.length > 0;
  if (count) count.textContent = cards.length ? String(cards.length) : '';
}

/**
 * 繪製「申請表單」：只列本人提出的單（GET /api/tickets/mine，依建立時間由新到舊），分成兩個區塊——
 * 待簽核（等待簽核的單可取消，被退回的單附退回原因並可重新提出）與已完成（已簽核、已取消，只能檢視）。
 * 本人提出且送達本部門的單同時也會出現在「待辦表單」，兩邊的卡片各自保存動作狀態。分頁計數為待簽核區的筆數。
 * 此元件只依資料與動作回呼繪製，不自行查詢 API 或判定後端授權。
 * @param {object} state 頁面資料，包含 mine 與需求類型目錄 formTypes（null 代表尚未載入）。
 * @param {object} nodes 申請表單節點：listMinePending、listMineDone、empties（minePending、mineDone）、counts（mine、minePending、mineDone）。
 * @param {object} actions 頁面提供的操作。
 * @param {Function} actions.onCancel 取消回呼（提單人取消，原因選填）。
 * @param {Function} actions.onResubmit 將退回單帶入草稿的回呼。
 * @param {Function} [actions.actionStateFor] 依單號取得頁面保存的取消表單動作狀態；省略時每張表單自建狀態。
 * @returns {string[]} 待簽核區目前有操作表單的單號（頁面據此清理不再顯示的動作狀態）。
 */
export function renderMyTickets(state, nodes, { onCancel, onResubmit, actionStateFor = null }) {
  const formTypes = state.formTypes ?? null;
  const pending = [];
  const done = [];
  const activeIds = [];
  for (const ticket of state.mine) {
    if (MINE_PENDING_STATUSES.has(ticket.status)) {
      if (ticket.status === 'REJECTED') {
        pending.push(buildTicketCard(ticket, { onResubmit, formTypes }));
        continue;
      }
      activeIds.push(ticket.ticket_id);
      pending.push(buildTicketCard(ticket, { onCancel, actionState: actionStateFor ? actionStateFor(ticket.ticket_id) : null, formTypes }));
    } else if (MINE_DONE_STATUSES.has(ticket.status)) {
      done.push(buildTicketCard(ticket, { formTypes }));
    }
  }
  fill(nodes.listMinePending, nodes.empties.minePending, nodes.counts.minePending, pending);
  fill(nodes.listMineDone, nodes.empties.mineDone, nodes.counts.mineDone, done);
  nodes.counts.mine.textContent = pending.length ? String(pending.length) : '';
  return activeIds;
}

/**
 * 繪製「待辦表單」：列出送達本部門、仍在待簽核的單（含本人提出、送到本部門的單），每張卡片有簽核、退回、轉單與取消表單。
 * 本人提出的單（依 isOwnTicket 判斷）標示「我提出的」，取消視為提單人取消（「取消需求單」、原因選填）；
 * 依需求類型（ticketTypeId 查詢目錄）不能由提單人簽核（describeFormPolicy 的 selfApprovable 為 false，預設與沒有需求類型的舊流程單都是不能）時
 * 不顯示簽核與退回，因為後端會以 403 拒絕，需由同部門其他成員簽核；其他人的單標示「待本部門簽核」，取消為「替提單人取消」且必須填原因。
 * @param {object} state 頁面資料，包含 mine、department、可轉單的 departments 與需求類型目錄 formTypes。
 * @param {object} nodes 待辦表單節點：listTodo、empties.todo、counts.todo。
 * @param {object} actions 頁面提供的有權限操作。
 * @param {Function} actions.onDecide 簽核／退回回呼。
 * @param {Function} actions.onTransfer 轉單回呼。
 * @param {Function} actions.onCancel 取消回呼。
 * @param {Function} [actions.actionStateFor] 依單號取得頁面保存的簽核表單動作狀態（處理中、錯誤、倒數）；省略時每張表單自建狀態。
 * @param {object|null} [user=null] 目前登入者（比對 userID），用來辨識本人提出的單。
 * @returns {string[]} 目前有操作表單的單號（頁面據此清理不再顯示的動作狀態）。
 */
export function renderTodoTickets(state, nodes, { onDecide, onTransfer, onCancel, actionStateFor = null }, user = null) {
  const formTypes = state.formTypes ?? null;
  const mineIds = new Set(state.mine.map(/** 取單號。@param {{ticket_id: string}} ticket 需求單。@returns {string} 單號。 */ (ticket) => ticket.ticket_id));
  const cards = [];
  const activeIds = [];
  for (const ticket of state.department?.tickets ?? []) {
    if (ticket.status !== 'PENDING') continue;
    const own = isOwnTicket(ticket, mineIds, user);
    const typeId = ticketTypeId(ticket);
    const selfBlocked = own && !describeFormPolicy(ticket, typeId ? findFormType(formTypes, typeId) : null).selfApprovable;
    activeIds.push(ticket.ticket_id);
    cards.push(buildTicketCard(ticket, { showRequester: true, tag: own ? TICKETS_TEXT.tagMine : TICKETS_TEXT.tagDepartment, onDecide: selfBlocked ? null : onDecide, onTransfer,
      departments: state.departments, onCancel, cancelRequiresComment: !own, actionState: actionStateFor ? actionStateFor(ticket.ticket_id) : null, formTypes }));
  }
  fill(nodes.listTodo, nodes.empties.todo, nodes.counts.todo, cards);
  return activeIds;
}
