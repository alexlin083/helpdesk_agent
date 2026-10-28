import { PAGE_URLS } from './pageUrls.js';
import { authService } from './services/authService.js';
import { loadMyTickets, loadDepartmentTickets, loadCompletedTickets, decideTicket, transferTicket, cancelTicket, loadDepartments, TicketServiceError, DRAFT_KEY } from './services/ticketService.js';
import { initAccountMenu } from './components/account.js';
import { TICKETS_TEXT } from './components/ticketText.js';
import { renderTicketTracking } from './components/ticketTracking.js';
import { createCompletedTicketsPanel } from './components/completedTickets.js';

const TAB_NAMES = ['tracking', 'completed'];

/**
 * 組裝狀態追蹤頁：驗證登入、注入 API 服務、協調追蹤清單與已完成面板、處理動作成功後的載入與分頁切換。
 * 卡片、操作表單、篩選與顯示格式由獨立元件負責，入口不直接建立卡片內容。
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
    empties: { pending: doc.querySelector('#empty-pending'), rejected: doc.querySelector('#empty-rejected') },
    pendingHint: doc.querySelector('#pending-hint'),
    listPending: doc.querySelector('#list-pending'),
    listRejected: doc.querySelector('#list-rejected'),
  };
  const state = { tab: 'tracking', mine: [], department: null, departments: null, completed: null, completedLoaded: false, completedRequest: null, loading: false };
  nodes.pendingHint.textContent = `你送出且還在等待的需求單，以及送達「${user.department.name}」等你簽核的需求單`;

  const completedPanel = createCompletedTicketsPanel(doc, { user, state, loadTickets: fetchCompleted, setNotice, showError });
  const loadCompleted = completedPanel.load;

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
  function handleCancel(ticketId, comment) {
    /** 送出取消請求，失敗交由卡片表單顯示。@returns {Promise<object>} API 結果。 */
    function cancel() { return sendCancel(ticketId, comment); }
    return act(cancel, TICKETS_TEXT.cancelled);
  }
  /**
   * 簽核或退回。
   * @param {string} ticketId 單號。
   * @param {'APPROVE'|'REJECT'} action 動作。
   * @param {string} comment 備註。
   * @returns {Promise<void>}
   */
  function handleDecide(ticketId, action, comment) {
    /** 送出簽核或退回請求。@returns {Promise<object>} API 結果。 */
    function decide() { return sendDecision(ticketId, action, comment); }
    return act(decide, TICKETS_TEXT.decided);
  }
  /**
   * 轉單到其他部門。
   * @param {string} ticketId 單號。
   * @param {string} departmentId 目標部門。
   * @param {string} handlerId 目標處理人（可空）。
   * @param {string} comment 備註。
   * @returns {Promise<void>}
   */
  function handleTransfer(ticketId, departmentId, handlerId, comment) {
    /** 送出目標部門、處理人與備註。@returns {Promise<object>} API 結果。 */
    function transfer() { return sendTransfer(ticketId, departmentId, handlerId, comment); }
    return act(transfer, TICKETS_TEXT.transferred);
  }

  /**
   * 重新提出被退回的單：把主題與內容存進本分頁的 sessionStorage 草稿，再依站點根目錄前往提出需求單頁帶入，支援追蹤頁子資料夾。
   * @param {object} ticket 被退回的需求單。
   * @returns {void}
   */
  function handleResubmit(ticket) {
    try { win.sessionStorage?.setItem(DRAFT_KEY, JSON.stringify({ subject: ticket.subject, content: ticket.content })); } catch { /* 儲存體不可用時仍前往提出需求單頁，只是不帶入內容 */ }
    win.location.href = PAGE_URLS.propose;
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
    renderTicketTracking(state, nodes, { onDecide: handleDecide, onTransfer: handleTransfer, onCancel: handleCancel, onResubmit: handleResubmit });
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
      /** 先取得轉單目標再繪製追蹤，避免選單以尚未載入的部門建立。@returns {Promise<void>} 載入完成。 */
      async function tracking() { await loadTransferTargets(); await loadTracking(); }
      const jobs = [tracking()];
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
