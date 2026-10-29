import { COMPLETED_DEFAULT_LIMIT } from '../services/ticketService.js';
import { describeSummary, quickRange } from '../utils/ticketFormatters.js';
import { buildTicketCard } from './ticketCard.js';
import { TICKETS_TEXT } from './ticketText.js';

/**
 * 建立已完成面板，集中管理關鍵字／結果／日期條件、快速日期、查詢鎖定與結果摘要。
 * 頁面提供登入者、共享結果狀態與資料服務；面板不自行取得身分或處理跨分頁載入。
 * @param {Document} doc 頁面文件。
 * @param {object} options 面板依賴。
 * @param {object} options.user 已登入的一般帳號。
 * @param {object} options.state 頁面狀態，更新 completed 與 completedLoaded。
 * @param {Function} options.loadTickets 依篩選條件查詢已完成需求單。
 * @param {Function} options.setNotice 接收分頁名稱與提示文字。
 * @param {Function} options.showError 接收分頁名稱與錯誤，登入失效由頁面處理。
 * @returns {{load: Function}} 查詢控制器，供分頁切換或整頁重新整理呼叫。
 */
export function createCompletedTicketsPanel(doc, { user, state, loadTickets, setNotice, showError }) {
  const nodes = {
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
    empty: doc.querySelector('#empty-completed'),
  };
  doc.querySelector('#completed-title').textContent = `你提出且已結案的需求單，以及「${user.department.name}」的簽核紀錄（已簽核、已退回、已取消），預設顯示最新 ${COMPLETED_DEFAULT_LIMIT} 筆`;
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
    const cards = [];
    for (const ticket of tickets) cards.push(buildTicketCard(ticket, { showRequester: true, tag: ticket.requester.username === user.username ? TICKETS_TEXT.tagMine : '' }));
    nodes.listCompleted.replaceChildren(...cards);
    nodes.empty.hidden = !result || tickets.length > 0;
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
      state.completed = await loadTickets(filters);
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

  nodes.filterForm.addEventListener('submit', handleFilterSubmit);
  nodes.filterReset.addEventListener('click', handleFilterReset);
  for (const button of nodes.quickButtons) button.addEventListener('click', handleQuickRange);
  return { load: loadCompleted };
}
