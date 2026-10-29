import { element } from './dom.js';
import { STATUS_LABELS } from '../services/ticketService.js';
import { describeTarget, describeHistory, formatTime } from '../utils/ticketFormatters.js';
import { TICKETS_TEXT } from './ticketText.js';
import { buildTicketActions } from './ticketActions.js';

const ROUTE_LABELS = { HANDLER: '已指定處理人，直接送達', DEPARTMENT: 'AI 依主題與內容判斷部門', FALLBACK: '內容未對應到明確部門，先送預設部門' };

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
  const transfers = [];
  for (const item of ticket.history) {
    if (item.event === 'TRANSFERRED') transfers.push(`${item.from_department_name || '—'} → ${item.to_department_name}${item.to_handler_name ? `（${item.to_handler_name}）` : ''} · ${item.by_username || '—'} · ${formatTime(item.at)}`);
  }
  if (transfers.length) row('轉單', transfers.join('\n'));
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
    body.append(buildTicketActions(ticket, { onDecide, onTransfer, departments, onCancel, cancelRequiresComment }));
  }
  card.append(body);
  return card;
}
