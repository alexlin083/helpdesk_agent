import { COMPLETED_DEFAULT_LIMIT } from '../../services/ticketService.js';
import { describeSummary, quickRange } from '../../utils/ticketFormatters.js';
import { buildTicketCard } from './ticketCard.js';
import { TICKETS_TEXT } from './ticketText.js';

/**
 * 建立「已完成表單」面板，集中管理關鍵字／結果／日期條件、快速日期、查詢鎖定與結果摘要；只查詢送達本人所屬部門且已結案的單（scope=department），
 * 本人提出的單在「申請表單」的已完成區塊查看。
 * 頁面提供登入者、共享結果狀態與資料服務；面板不自行取得身分或處理跨分頁載入。
 * 每次查詢取得遞增序號，只有最後一次查詢的結果或錯誤會繪製，避免快速切換條件、清除條件、分頁切換或重新整理時較舊的回應覆蓋較新的結果。
 * @param {Document} doc 頁面文件。
 * @param {object} options 面板依賴。
 * @param {object} options.user 已登入的一般帳號。
 * @param {object} options.state 頁面狀態，更新 completed 與 completedLoaded。
 * @param {Function} options.loadTickets 依篩選條件查詢已完成需求單。
 * @param {Function} options.setNotice 接收分頁名稱與提示文字。
 * @param {Function} options.showError 接收分頁名稱與錯誤，登入失效由頁面處理。
 * @returns {{load: Function, isLoading: Function}} 查詢控制器：load 供分頁切換、動作完成或整頁重新整理呼叫；isLoading 回報是否仍有查詢進行中。
 */
export function createCompletedTicketsPanel(doc, { user, state, loadTickets, setNotice, showError }) {
  // sequence 是最後一次查詢的序號；inFlight 是仍在等待回應的查詢數，供頁面避免重複發出第一次載入。
  const requests = { sequence: 0, inFlight: 0 };
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
  doc.querySelector('#completed-title').textContent = `送達「${user.department.name}」且已結案的需求單（已簽核、已退回、已取消），預設顯示最新 ${COMPLETED_DEFAULT_LIMIT} 筆`;
  /**
   * 讀取篩選表單目前的條件，範圍固定為本部門（scope=department）。
   * @returns {{status: string, q: string, from: string, to: string, scope: 'department'}} 條件。
   */
  function currentFilters() {
    return { status: nodes.filterStatus.value || '', q: nodes.filterKeyword.value || '', from: nodes.filterFrom.value || '', to: nodes.filterTo.value || '', scope: 'department' };
  }

  /**
   * 繪製「已完成」分頁的清單與摘要；卡片的需求類型欄位名稱取自頁面狀態中的需求類型目錄（state.formTypes，尚未載入時為 null，改用記錄本身的資料）。
   * @returns {void}
   */
  function renderCompleted() {
    const result = state.completed;
    const tickets = result?.tickets ?? [];
    const cards = [];
    for (const ticket of tickets) {
      cards.push(buildTicketCard(ticket, { showRequester: true, tag: ticket.requester.username === user.username ? TICKETS_TEXT.tagMine : '', formTypes: state.formTypes ?? null }));
    }
    nodes.listCompleted.replaceChildren(...cards);
    nodes.empty.hidden = !result || tickets.length > 0;
    nodes.summary.textContent = result ? describeSummary(result.total, tickets.length, result.limit) : '';
  }

  /**
   * 依目前條件載入已完成清單；條件無效時顯示提示而不送出，並讓進行中的較舊查詢失效，避免其結果蓋掉提示。
   * 每次送出取得新的序號，回應回來時若已有更新的查詢則忽略其結果與錯誤；查詢按鈕在最後一次查詢結束後才恢復。
   * @returns {Promise<void>} 本次查詢完成（含被較新查詢取代而忽略結果的情況）。
   */
  async function loadCompleted() {
    const filters = currentFilters();
    if (filters.from && filters.to && filters.from > filters.to) {
      requests.sequence += 1;
      nodes.filterSubmit.disabled = false;
      setNotice('completed', '起始日期不可晚於結束日期');
      nodes.filterFrom.focus();
      return;
    }
    requests.sequence += 1;
    const sequence = requests.sequence;
    requests.inFlight += 1;
    setNotice('completed', TICKETS_TEXT.searching);
    nodes.filterSubmit.disabled = true;
    try {
      const result = await loadTickets(filters);
      if (sequence !== requests.sequence) return;
      state.completed = result;
      state.completedLoaded = true;
      setNotice('completed', '');
      renderCompleted();
    } catch (error) { if (sequence === requests.sequence) showError('completed', error); }
    finally {
      requests.inFlight -= 1;
      if (sequence === requests.sequence) nodes.filterSubmit.disabled = false;
    }
  }

  /**
   * 回報是否仍有已完成查詢在等待回應，頁面據此避免重複點分頁時再發出一次第一次載入。
   * @returns {boolean} 是否有查詢進行中。
   */
  function isLoading() { return requests.inFlight > 0; }

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
  return { load: loadCompleted, isLoading };
}
