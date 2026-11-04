import { element } from '../dom.js';

export const RESULT_TEXT = {
  HANDLER: { method: '已指定處理人，直接送達', note: '需求單已送到指定處理人手上' },
  DEPARTMENT: { method: 'AI 依主題與內容判斷部門' },
  FALLBACK: { method: '內容未對應到明確部門' },
  FORM: { method: '依表單規則送達' },
  DRAFT: { method: '依 AI 對話確認部門' },
};

/**
 * 將送出結果整理成結果視窗要顯示的文字；HANDLER、DEPARTMENT、FALLBACK 的文案見開發規格書「送出結果與錯誤處理」。
 * FORM（依固定表單送出，例如請假單）的方式顯示後端的依據文字（例如「依「請假申請」表單規則送達」），沒有時顯示「依表單規則送達」；
 * 依據已放在方式欄，不再重複顯示判斷依據列。
 * 以「自動生成」確認部門送出（fromDraft 且 route 為 DEPARTMENT）時方式顯示「依 AI 對話確認部門」，不再顯示判斷依據列（後端沒有第二次判斷）。
 * FORM 與 DEPARTMENT 有指定該部門內的處理人時，送達顯示「姓名（部門）」。
 * @param {object} result 經 ticketService 整理的回應（route、department、handler、basis、ticket_id）。
 * @param {object} [options={}] 顯示選項。
 * @param {boolean} [options.fromDraft=false] 這張單是否套用了「自動生成」的結果送出。
 * @returns {{target: string, method: string, note: string, basis: string}} 送達、方式、說明與判斷依據（沒有時為空字串）。
 */
export function summarizeTicketResult(result, { fromDraft = false } = {}) {
  if (result.route === 'HANDLER') {
    return { target: `${result.handler.name}（${result.department}）`, method: RESULT_TEXT.HANDLER.method, note: RESULT_TEXT.HANDLER.note, basis: '' };
  }
  const basis = typeof result.basis === 'string' ? result.basis : '';
  const target = result.handler?.name ? `${result.handler.name}（${result.department}）` : result.department;
  const note = result.handler?.name ? `需求單已送到 ${result.handler.name} 簽核` : `需求單已送往「${result.department}」簽核`;
  if (result.route === 'FORM') return { target, method: basis || RESULT_TEXT.FORM.method, note, basis: '' };
  if (result.route === 'DEPARTMENT' && fromDraft) return { target, method: RESULT_TEXT.DRAFT.method, note, basis: '' };
  if (result.route === 'DEPARTMENT') return { target, method: RESULT_TEXT.DEPARTMENT.method, note, basis };
  return { target: result.department, method: RESULT_TEXT.FALLBACK.method, note: `先送「${result.department}」，由人工分派部門`, basis };
}

/**
 * 將結果寫入結果視窗的各個節點；沒有判斷依據時隱藏整列。所有文字以 textContent 放入。
 * @param {object} nodes 結果視窗的節點：subject、ticket、target、method、basisRow、basis、note。
 * @param {string} subject 本次送出的主題（去除首尾空白後）。
 * @param {object} result 經 ticketService 整理的回應。
 * @param {object} [options={}] 顯示選項，傳給 summarizeTicketResult（fromDraft）。
 * @returns {void}
 */
export function renderTicketResult(nodes, subject, result, options = {}) {
  const summary = summarizeTicketResult(result, options);
  nodes.subject.textContent = subject;
  nodes.ticket.textContent = result.ticket_id;
  nodes.target.textContent = summary.target;
  nodes.method.textContent = summary.method;
  nodes.note.textContent = summary.note;
  nodes.basis.textContent = summary.basis;
  nodes.basisRow.hidden = !summary.basis;
}

/**
 * 將部門名單繪製成「各部門業務範圍」視窗的卡片：名稱、屬性標籤（type 為空時不顯示）、業務說明與關鍵字。
 * 沒有處理人的部門仍會列出；名單沒有任何部門時容器沒有內容。
 * @param {HTMLElement} container 卡片容器，既有內容會被清空。
 * @param {Array<object>} departments 經 ticketService 正規化的部門陣列。
 * @returns {void}
 */
export function renderDepartmentCards(container, departments) {
  const cards = [];
  for (const department of departments) {
    const card = element('article', 'department-card');
    const head = element('div', 'department-head');
    head.append(element('h3', 'department-name', department.name));
    if (department.type) head.append(element('span', 'department-type', department.type));
    card.append(head);
    if (department.duty) card.append(element('p', 'department-duty', department.duty));
    if (department.business.length) {
      const keywords = element('ul', 'keyword-list');
      for (const keyword of department.business) keywords.append(element('li', 'keyword', keyword));
      card.append(keywords);
    }
    cards.push(card);
  }
  container.replaceChildren(...cards);
}
