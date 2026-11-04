import { element } from '../dom.js';
import { STATUS_LABELS } from '../../services/ticketService.js';
import { describeTarget, describeHistory, formatTime } from '../../utils/ticketFormatters.js';
import { TICKETS_TEXT } from './ticketText.js';
import { buildTicketActions } from './ticketActions.js';
import { describeFormFields, describeFormComputed, describeFormPolicy, ticketTypeId } from '../../utils/formFormatters.js';

const ROUTE_LABELS = { HANDLER: '已指定處理人，直接送達', DEPARTMENT: 'AI 依主題與內容判斷部門', FALLBACK: '內容未對應到明確部門，先送預設部門', FORM: '依表單規則送達' };
const DRAFT_ROUTE_LABEL = '依 AI 對話確認部門';

/**
 * 組出需求單「方式」欄的文字：部門由「自動生成」對話確認（judgement.source 為 draft）的 DEPARTMENT 單顯示「依 AI 對話確認部門」，其他依 route 顯示。
 * @param {object} ticket 正規化的需求單。
 * @returns {string} 方式文字。
 */
export function describeRoute(ticket) {
  if (ticket.route === 'DEPARTMENT' && ticket.judgement?.source === 'draft') return DRAFT_ROUTE_LABEL;
  return ROUTE_LABELS[ticket.route];
}

/**
 * 依需求類型 id 在目錄中尋找定義；目錄沒有載入或找不到時回傳 null。
 * @param {Array<{id: string}>|null} formTypes 需求類型目錄（GET /api/forms 整理後的陣列）。
 * @param {string} id 需求類型 id。
 * @returns {object|null} 需求類型定義。
 */
export function findFormType(formTypes, id) {
  for (const type of Array.isArray(formTypes) ? formTypes : []) if (type.id === id) return type;
  return null;
}

/**
 * 建立依需求類型送出的需求單欄位表格（前端不認得任何特定類型）：標題為類型名稱（記錄沒有名稱時用目錄的名稱，再沒有就用 id），
 * 每列為「欄位名稱：值」（名稱與順序見 describeFormFields），最後接後端保存的計算結果（見 describeFormComputed）；
 * 計算結果的列加上 form-table-computed，讓畫面把時數等結果標成重點；標題（caption）就是卡片「申請內容」區塊的標題
 * 舊版本的記錄（例如 version 1 的請假單）只要欄位代號相同，就以目前目錄的名稱顯示。所有文字以 textContent 放入。
 * @param {{id: string, name: string, fields: Record<string, string>, labels: Record<string, string>, computed: Array<object>|Record<string, unknown>|null}} form 正規化的表單資料。
 * @param {object|null} [definition=null] 需求類型目錄中相同 id 的定義；沒有時為 null。
 * @returns {HTMLElement} 表格元素。
 */
export function buildFormTable(form, definition = null) {
  const table = element('table', 'form-table');
  table.append(element('caption', '', `${form.name || definition?.name || form.id}表單`));
  const body = element('tbody');
  /**
   * 加入一列
   * @param {string} label 欄位名稱
   * @param {string} value 內容
   * @param {string} [className=''] 列的 class；計算結果為 form-table-computed
   * @returns {void}
   */
  function addRow(label, value, className = '') {
    const line = element('tr', className);
    const head = element('th', '', label);
    head.setAttribute('scope', 'row');
    line.append(head, element('td', '', value));
    body.append(line);
  }
  for (const item of describeFormFields(form, definition)) addRow(item.label, item.value);
  for (const item of describeFormComputed(form, definition)) addRow(item.label, item.value, 'form-table-computed');
  table.append(body);
  return table;
}

/**
 * 建立一張需求單卡片（可展開）：摘要列為主旨、狀態與一行摘要（身分標籤、提單人、送達、時間、單號）；
 * 展開後分左右兩欄（窄螢幕改上下）：左欄「申請內容」，右欄「處理資訊」（方式、判斷依據、提單人、簽核、轉單）與「歷程」；
 * 待簽核且可簽核時在兩欄下方附簽核表單，已退回且可重新提出時附「重新提出」按鈕；
 * 「方式」欄依 describeRoute 顯示（部門由「自動生成」對話確認的單顯示「依 AI 對話確認部門」）。
 * 依需求類型送出的單（ticket.form）左欄只顯示表單欄位表格（欄位名稱：值，以及後端保存的計算結果），不再重複列出由同一組欄位產生的需求內容文字；
 * 沒有 form 的單左欄顯示需求內容文字；是否顯示轉單依 describeFormPolicy
 * （以 ticketTypeId 查詢目錄定義：記錄或目錄的 workflow.transfer，沒有設定時 route 為 FORM 的單不能轉出定義部門，後端會回 409 FORM_TICKET_LOCKED）。
 * @param {object} ticket 正規化的需求單。
 * @param {object} options 顯示選項。
 * @param {boolean} [options.showRequester=false] 是否顯示提單人（部門待簽核與已完成清單用）。
 * @param {string} [options.tag=''] 摘要列的身分標籤，例如「我提出的」「待本部門簽核」；空字串不顯示。
 * @param {Function|null} [options.onDecide=null] 簽核回呼 (ticketId, action, comment) => Promise；null 表示不可簽核。
 * @param {Function|null} [options.onTransfer=null] 轉單回呼 (ticketId, departmentId, handlerId, comment) => Promise；null 表示不可轉單。
 * @param {Array<object>|null} [options.departments=null] 可轉到的部門名單（含處理人）；null 代表名單尚未載入或載入失敗。
 * @param {Function|null} [options.onCancel=null] 取消回呼 (ticketId, comment) => Promise；null 表示不可取消。
 * @param {boolean} [options.cancelRequiresComment=false] 取消是否必須填原因（部門替提單人取消時為 true，按鈕顯示「替提單人取消」；提單人取消自己的單為 false，按鈕顯示「取消需求單」）。
 * @param {Function|null} [options.onResubmit=null] 重新提出回呼 (ticket) => void；只有已退回的單會顯示按鈕。
 * @param {object|null} [options.actionState=null] 頁面以單號保存的簽核表單動作狀態（處理中、錯誤、限流倒數），重新繪製時傳入同一個物件以接回進行中的請求；null 時表單自建狀態。
 * @param {Array<object>|null} [options.formTypes=null] 需求類型目錄（GET /api/forms），用來顯示欄位名稱與判斷 workflow；null 代表尚未載入或載入失敗。
 * @returns {HTMLElement} 卡片元素。
 */
export function buildTicketCard(ticket, { showRequester = false, tag = '', onDecide = null, onTransfer = null, departments = null, onCancel = null, cancelRequiresComment = false, onResubmit = null, actionState = null, formTypes = null } = {}) {
  const typeId = ticketTypeId(ticket);
  const definition = typeId ? findFormType(formTypes, typeId) : null;
  const card = element('details', 'ticket-card');
  card.setAttribute('data-ticket-id', ticket.ticket_id);
  const summary = element('summary', 'ticket-summary');
  const head = element('div');
  head.append(element('p', 'ticket-subject', ticket.subject));
  const meta = element('p', 'ticket-meta');
  if (tag) meta.append(element('span', 'ticket-tag', tag));
  if (showRequester && ticket.requester.username) meta.append(element('span', '', `提單人：${ticket.requester.username}`));
  meta.append(element('span', '', `送達：${describeTarget(ticket)}`), element('span', '', formatTime(ticket.created_at)), element('span', 'ticket-id', ticket.ticket_id));
  head.append(meta);
  summary.append(head, element('span', `status status-${ticket.status}`, STATUS_LABELS[ticket.status]));
  card.append(summary);

  const body = element('div', 'ticket-body');
  // 左欄「申請內容」：帶 form 的單只顯示表單欄位（需求內容文字由同一組欄位產生，不重複列出），其他單顯示需求內容文字
  const main = element('section', 'ticket-main');
  if (ticket.form) main.append(buildFormTable(ticket.form, definition));
  else main.append(element('h3', 'ticket-section-title', '需求內容'), element('p', 'ticket-content', ticket.content));
  // 右欄「處理資訊」與「歷程」
  const side = element('aside', 'ticket-side');
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
  row('方式', describeRoute(ticket));
  if (ticket.judgement?.basis) row('判斷依據', ticket.judgement.basis);
  if (ticket.requester.username) row('提單人', ticket.requester.department_name ? `${ticket.requester.username}（${ticket.requester.department_name}）` : ticket.requester.username);
  if (ticket.decision) {
    const label = ticket.status === 'CANCELLED' ? (ticket.decision.cancelled_by === 'DEPARTMENT' ? '取消（部門）' : '取消（提單人）') : ticket.status === 'REJECTED' ? '退回' : '簽核';
    row(label, `${ticket.decision.by_username || '—'} · ${formatTime(ticket.decision.at)}${ticket.decision.comment ? `\n備註：${ticket.decision.comment}` : ''}`);
  }
  const transfers = [];
  for (const item of ticket.history) {
    if (item.event === 'TRANSFERRED') transfers.push(`${item.from_department_name || '—'} → ${item.to_department_name}${item.to_handler_name ? `（${item.to_handler_name}）` : ''} · ${item.by_username || '—'} · ${formatTime(item.at)}`);
  }
  if (transfers.length) row('轉單', transfers.join('\n'));
  side.append(element('h3', 'ticket-section-title', '處理資訊'), fields);

  if (ticket.history.length) {
    const history = element('ol', 'ticket-history');
    for (const item of ticket.history) {
      const line = element('li');
      const time = element('time', '', formatTime(item.at));
      time.setAttribute('datetime', item.at);
      line.append(time, element('span', '', describeHistory(item)));
      history.append(line);
    }
    side.append(element('h3', 'ticket-section-title', '歷程'), history);
  }
  const columns = element('div', 'ticket-columns');
  columns.append(main, side);
  body.append(columns);

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
    body.append(buildTicketActions(ticket, { onDecide, onTransfer: describeFormPolicy(ticket, definition).transferable ? onTransfer : null, departments, onCancel, cancelRequiresComment, actionState }));
  }
  card.append(body);
  return card;
}
