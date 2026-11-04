import { PAGE_URLS } from '../pageUrls.js';
import { authService } from '../services/authService.js';
import { loadMyTickets, loadDepartmentTickets, loadCompletedTickets, decideTicket, transferTicket, cancelTicket, loadDepartments, TicketServiceError, DRAFT_KEY } from '../services/ticketService.js';
import { initAccountMenu } from '../components/account.js';
import { TICKETS_TEXT } from '../components/tickets/ticketText.js';
import { renderTicketTracking } from '../components/tickets/ticketTracking.js';
import { createCompletedTicketsPanel } from '../components/tickets/completedTickets.js';
import { createActionStateStore } from '../components/tickets/ticketActionState.js';
import { loadRequestTypes } from '../services/draftService.js';

const TAB_NAMES = ['tracking', 'completed'];

/**
 * 組裝狀態追蹤頁：驗證登入、注入 API 服務、協調追蹤清單與已完成面板、處理動作成功後的載入與分頁切換。
 * 卡片、操作表單、篩選與顯示格式由獨立元件負責，入口不直接建立卡片內容。
 * @param {Document} [doc=document] 頁面文件，測試可注入替身。
 * 待簽核卡片的處理中、錯誤與限流倒數以單號保存在頁面層級，清單重新繪製時沿用；倒數計時器在 pagehide 暫停、pageshow 恢復。
 * @param {Window} [win=window] 視窗物件，提供 hash、sessionStorage、導頁、計時器與 pagehide／pageshow 事件。
 * @param {object} [services={}] 可注入的服務替身（auth、loadMyTickets、loadDepartmentTickets、loadCompletedTickets、decideTicket、transferTicket、cancelTicket、loadDepartments、loadRequestTypes）。
 * 需求類型目錄（GET /api/forms）只用來把需求單保存的欄位顯示成「欄位名稱：值」與判斷 workflow，載入失敗時卡片改用記錄本身的資料，不影響其他功能。
 * @returns {object|null} 頁面控制器（ready、refresh、selectTab、loadCompleted、state、leave、actionStates），未登入時回傳 null。
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
  const fetchFormTypes = services.loadRequestTypes ?? loadRequestTypes;
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
  const state = { tab: 'tracking', mine: [], department: null, departments: null, completed: null, completedLoaded: false, completedRequest: null, completedQueued: false, loading: false, formTypes: null };
  // 需求類型目錄的載入中 Promise；成功後保留結果不再重新查詢，失敗時下次重新整理再試。
  let formTypesRequest = null;
  nodes.pendingHint.textContent = `你送出且還在等待的需求單，以及送達「${user.department.name}」等你簽核的需求單`;

  const completedPanel = createCompletedTicketsPanel(doc, { user, state, loadTickets: fetchCompleted, setNotice, showError });
  const loadCompleted = completedPanel.load;
  // 表單追蹤每次載入的遞增序號；只有最後一次載入的結果會寫回 state 並繪製。
  let trackingSequence = 0;
  /**
   * 卡片動作失敗時卡片已不在畫面上（清單重新載入後不再列出這張單），改在表單追蹤上方顯示錯誤。
   * @param {string} message 錯誤文字。
   * @returns {void}
   */
  function showOrphanError(message) { setNotice('tracking', message); }
  // 以單號保存待簽核卡片的處理中、錯誤與倒數，重新繪製時新卡片接回這些狀態。
  const actionStates = createActionStateStore({ timers: win, onOrphanError: showOrphanError });
  /**
   * 取得某張單的卡片動作狀態，交給表單追蹤繪製時使用。
   * @param {string} ticketId 單號。
   * @returns {object} 動作狀態。
   */
  function actionStateFor(ticketId) { return actionStates.get(ticketId); }

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
   * 判斷動作錯誤是否代表清單已過期：409（需求單已簽核、退回或取消）、403（例如同事已把單轉到其他部門，本部門不再有權限）
   * 或 404 TICKET_NOT_FOUND（查無需求單）。404 NOT_FOUND（未知路由或後端版本不符）不算，仍交由卡片顯示。
   * @param {unknown} error 動作拋出的錯誤。
   * @returns {boolean} 是否需要重新整理清單。
   */
  function isStaleTicketError(error) {
    return error instanceof TicketServiceError && (error.status === 409 || error.status === 403 || (error.status === 404 && error.code === 'TICKET_NOT_FOUND'));
  }

  /**
   * 重新載入表單追蹤；已完成分頁看過或正在第一次載入時一併重新查詢，避免顯示動作前的結果。
   * @returns {Promise<void>} 兩份清單都載入完成（各自的錯誤已顯示在對應分頁）。
   */
  async function reloadAfterAction() {
    const jobs = [loadTracking(false)];
    if (state.completedLoaded || completedPanel.isLoading()) jobs.push(loadCompleted());
    await Promise.all(jobs);
  }

  /**
   * 執行一個會改變需求單狀態的動作（簽核、退回、轉單、取消），成功後顯示提示並重新載入表單追蹤與已載入的已完成分頁。
   * 登入失效（401 或本機憑證已過期）時清除登入狀態並導回登入頁，不在卡片內顯示錯誤；
   * 409、403 或 404 TICKET_NOT_FOUND 代表清單已過期：把後端訊息顯示在表單追蹤上方並重新整理清單（重新繪製會取代原卡片，所以不在卡片內顯示）；
   * 其他錯誤原樣拋出，交由卡片表單顯示（含 429 倒數）。
   * @param {Function} run 非同步動作。
   * @param {string} message 成功提示。
   * @returns {Promise<void>} 動作完成、已重新整理過期清單或已導回登入頁。
   * @throws {unknown} 登入失效與清單過期以外的動作錯誤。
   */
  async function act(run, message) {
    try { await run(); } catch (error) {
      if (error?.status === 401 || error?.code === 'LOGIN_REQUIRED') { leave(); return; }
      if (!isStaleTicketError(error)) throw error;
      setNotice('tracking', error.message);
      await reloadAfterAction();
      return;
    }
    setNotice('tracking', message);
    await reloadAfterAction();
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
   * 重新提出被退回的單：把主題、內容與目前登入者的 userID 存進本分頁的 sessionStorage 草稿，再依站點根目錄前往提出需求單頁帶入，支援追蹤頁子資料夾。
   * 提出需求單頁只帶入 userID 與登入者相同的草稿，避免換帳號後帶入上一位的內容。
   * @param {object} ticket 被退回的需求單。
   * @returns {void}
   */
  function handleResubmit(ticket) {
    try { win.sessionStorage?.setItem(DRAFT_KEY, JSON.stringify({ subject: ticket.subject, content: ticket.content, userID: user.userID })); } catch { /* 儲存體不可用時仍前往提出需求單頁，只是不帶入內容 */ }
    win.location.href = PAGE_URLS.propose;
  }

  /**
   * 載入表單追蹤需要的兩份清單（我的需求單、送達本部門的需求單）並繪製；任一份失敗時顯示提示，另一份仍照常顯示。
   * 每次載入取得遞增序號；回應回來時若已有較新的載入（例如動作後的重新載入），就忽略本次結果與錯誤，
   * 避免較舊的重新整理回應把已簽核的單重新顯示為待簽核。
   * 繪製後只保留畫面上仍有卡片的動作狀態；進行中的請求、錯誤與倒數由新卡片接回。
   * @param {boolean} [announce=true] 是否先顯示載入中提示（動作後重新載入時保留成功提示）。
   * @returns {Promise<void>} 本次載入完成（含被較新載入取代而忽略結果的情況）。
   */
  async function loadTracking(announce = true) {
    trackingSequence += 1;
    const sequence = trackingSequence;
    if (announce) setNotice('tracking', TICKETS_TEXT.loading);
    const [mine, department] = await Promise.allSettled([fetchMine(), fetchDepartment()]);
    if (sequence !== trackingSequence) return;
    if (mine.status === 'fulfilled') state.mine = mine.value;
    if (department.status === 'fulfilled') state.department = department.value;
    const failure = mine.status === 'rejected' ? mine.reason : department.status === 'rejected' ? department.reason : null;
    if (failure) showError('tracking', failure);
    else if (announce) setNotice('tracking', '');
    const pendingIds = renderTicketTracking(state, nodes, { onDecide: handleDecide, onTransfer: handleTransfer, onCancel: handleCancel, onResubmit: handleResubmit, actionStateFor }, user);
    actionStates.retain(pendingIds);
  }

  /**
   * 切換分頁並更新 aria 狀態；第一次切到「已完成」時才載入清單（先等需求類型目錄載入結束，讓卡片以目錄的欄位名稱顯示）。
   * 已有已完成查詢排隊或進行中（例如連點分頁）時不再發出第二次第一次載入；前一次失敗且沒有查詢進行中時，再切回會重新嘗試。
   * @param {'tracking'|'completed'} tab 分頁。
   * @returns {void}
   */
  function selectTab(tab) {
    state.tab = tab;
    for (const name of TAB_NAMES) {
      nodes.tabs[name].setAttribute('aria-selected', String(name === tab));
      nodes.panels[name].hidden = name !== tab;
    }
    if (tab === 'completed' && !state.completedLoaded && !completedPanel.isLoading() && !state.completedQueued) {
      state.completedQueued = true;
      state.completedRequest = loadFormTypes().then(loadCompleted).finally(releaseCompletedQueue);
    }
  }

  /**
   * 第一次載入已完成清單結束（含失敗）後解除排隊標記，讓之後切換分頁可以再次嘗試。
   * @returns {void}
   */
  function releaseCompletedQueue() { state.completedQueued = false; }

  /**
   * 載入需求類型目錄（GET /api/forms）並保存在 state.formTypes；已載入成功時直接沿用，載入中時共用同一個請求。
   * 失敗時（含未登入以外的任何錯誤）保留 null，卡片改用記錄本身的欄位名稱；登入失效時回登入頁。非預期錯誤只寫入主控台。
   * @returns {Promise<void>} 載入完成（不會拒絕）。
   */
  function loadFormTypes() {
    if (state.formTypes) return Promise.resolve();
    if (formTypesRequest) return formTypesRequest;
    /**
     * 實際查詢目錄並在結束時清除載入中的 Promise。
     * @returns {Promise<void>} 載入完成。
     */
    async function perform() {
      try { state.formTypes = await fetchFormTypes(); } catch (error) {
        if (error?.status === 401 || error?.code === 'LOGIN_REQUIRED') { leave(); return; }
        if (!(error instanceof TicketServiceError)) console.error(error);
        state.formTypes = null;
      } finally { formTypesRequest = null; }
    }
    formTypesRequest = perform();
    return formTypesRequest;
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

  /**
   * 重新載入清單、部門名單與（尚未載入成功時的）需求類型目錄；已完成分頁只在看過之後才一起重新查詢。
   * 追蹤清單與已完成清單都等目錄載入結束後才繪製，讓卡片以目錄的欄位名稱顯示。
   * @returns {Promise<void>}
   */
  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    nodes.refresh.disabled = true;
    try {
      /** 先取得轉單目標與需求類型目錄再繪製追蹤，避免選單以尚未載入的部門建立。@returns {Promise<void>} 載入完成。 */
      async function tracking() { await Promise.all([loadTransferTargets(), loadFormTypes()]); await loadTracking(); }
      /** 等需求類型目錄載入結束後重新查詢已完成清單。@returns {Promise<void>} 載入完成。 */
      async function completed() { await loadFormTypes(); await loadCompleted(); }
      const jobs = [tracking()];
      if (state.completedLoaded) jobs.push(completed());
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
  /** 離開或進入背景快取（pagehide）時暫停卡片倒數計時器。@returns {void} */
  function handlePageHide() { actionStates.pause(); }
  /** 從背景快取恢復（pageshow）時依目前時間更新卡片倒數，仍有倒數時重新啟動計時器。@returns {void} */
  function handlePageShow() { actionStates.resume(); }
  win.addEventListener('pagehide', handlePageHide);
  win.addEventListener('pageshow', handlePageShow);
  selectTab(tabFromHash());
  doc.body.hidden = false;
  const ready = refresh();
  return { ready, refresh, selectTab, loadCompleted, state, leave, actionStates };
}

// 真實瀏覽器載入時自動初始化；測試以替身文件明確呼叫 initTicketsPage。
if (typeof document !== 'undefined' && typeof document.readyState === 'string') initTicketsPage();
