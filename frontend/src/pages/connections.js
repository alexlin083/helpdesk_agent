import { initAccountMenu } from '../components/account.js';
import { createConnectionsView } from '../components/connections/connectionsView.js';
import { authService } from '../services/authService.js';
import { abandonGoogle, completeGoogle, disconnectConnector, listConnectors, startConnect } from '../services/connectorService.js';

// 完成連接的結果代碼對應的固定文字；頁面不顯示後端或提供者的原始訊息，也不寫死提供者或服務名稱
export const RESULT_TEXT = Object.freeze({
  connected: '已連接，助理之後會在你選的權限內讀取資料',
  denied: '你在授權畫面按了拒絕，沒有連接',
  expired: '這次連接已經過期或用過了，請重新按「連接」',
  mismatch: '這個連接不是你的帳號發起的，沒有存進你的帳號；要連接請在自己的帳號重新按「連接」',
  partial: '沒有勾齊需要的權限，所以沒有連接；請重新連接並勾選畫面上列出的權限',
  failed: '連接失敗，請稍後再重新連接',
});
// 完成連接失敗、又沒能作廢這次的授權時顯示：請使用者重新發起，舊的導回網址不要再用
export const CANCELLED_TEXT = '這次連接已取消，請重新發起';

/**
 * 取出授權畫面導回時網址上的 state、code 與 error，並立刻用 history.replaceState 從網址列移掉，在任何其他動作之前做
 * 授權碼不能留在網址列、瀏覽紀錄或被複製轉傳；頁面另有 Referrer-Policy: no-referrer，網址也不會帶到其他網站
 * @param {Window} win 視窗物件
 * @returns {{state: string|null, code: string|null, error: string|null}|null} 有導回參數時回傳，否則 null
 */
export function takeOAuthReturn(win) {
  const params = new URLSearchParams(win.location?.search ?? '');
  const returned = { state: params.get('state'), code: params.get('code'), error: params.get('error') };
  if (!returned.state && !returned.code && !returned.error) return null;
  try { win.history?.replaceState(null, '', win.location.pathname); } catch { /* 不支援 history 時仍繼續；授權碼只能用一次且 5 分鐘失效 */ }
  return returned;
}

/**
 * 組裝「連接帳號」頁
 * 1. 先處理授權畫面的導回：清掉網址上的授權碼；本人已登入（一般帳號）就自動送出完成連接，不等使用者按；沒登入或是管理員就作廢 state，再交給登入守門導頁
 *    完成連接失敗（登入失效、連線失敗）時先盡力作廢 state，作廢也失敗就請使用者重新發起，避免留在瀏覽紀錄的導回網址還能用
 * 2. 列出外部服務與連接狀態，處理連接、更新權限與中斷連接
 * @param {Document} [doc=document] 頁面文件
 * @param {Window} [win=window] 視窗物件
 * @param {object} [services={}] 可替換的服務（測試注入）
 * @param {object} [services.auth] 登入服務
 * @param {object} [services.api] 連接 API（listConnectors、startConnect、completeGoogle、abandonGoogle、disconnectConnector）
 * @returns {Promise<object|null>} 頁面狀態與動作；沒通過登入守門時 null
 */
export async function initConnectionsPage(doc = document, win = window, services = {}) {
  const auth = services.auth ?? authService;
  const api = { listConnectors, startConnect, completeGoogle, abandonGoogle, disconnectConnector, ...services.api };
  const returned = takeOAuthReturn(win);
  const signedIn = auth.getCurrentUser();
  if (returned && (!signedIn || (signedIn.role ?? 'USER') !== 'USER')) {
    if (returned.state) await api.abandonGoogle(returned.state);
  }
  const { user, leave } = initAccountMenu(doc, win, auth);
  if (!user) return null;

  const status = doc.querySelector('#connections-status');
  const page = { connectors: [], selectedId: null, view: null };
  /** 顯示一行狀態文字 @param {string} text 文字 @param {boolean} [error=false] 是否為錯誤 @returns {void} */
  function say(text, error = false) {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  }
  /**
   * 處理 API 錯誤：登入失效就登出回登入頁，其他顯示後端的固定文字
   * @param {unknown} failure 錯誤
   * @returns {void}
   */
  function fail(failure) {
    if (failure?.status === 401) { leave(); return; }
    say(failure?.message || '操作失敗，請稍後再試', true);
  }
  /**
   * 重新讀清單並重畫；選過的服務保留，沒選過就選第一個可以連接的
   * @param {string|null} [prefer] 想選的連接器
   * @returns {Promise<void>} 完成
   */
  async function refresh(prefer = page.selectedId) {
    try { page.connectors = await api.listConnectors(auth); } catch (failure) { fail(failure); return; }
    const ids = page.connectors.map(/** 取 id @param {{id: string}} item 連接器 @returns {string} id */ (item) => item.id);
    page.selectedId = ids.includes(prefer) ? prefer : (page.connectors.find(/** 第一個可以連接的 @param {{status: string}} item 連接器 @returns {boolean} 是時 true */ (item) => item.status === 'available')?.id ?? ids[0] ?? null);
    page.view.render(page.connectors, page.selectedId);
  }
  page.view = createConnectionsView(doc, {
    /** 選服務 @param {string} id 連接器 id @returns {void} */
    onSelect(id) { page.selectedId = id; page.view.select(id); },
    /**
     * 發起連接：取得授權網址後把整個分頁導過去
     * @param {string} id 連接器 id
     * @param {string} level 權限等級 id
     * @returns {Promise<void>} 完成
     */
    async onConnect(id, level) {
      page.view.setBusy(true);
      say('正在前往授權畫面…');
      try { win.location.assign(await api.startConnect(id, level, auth)); } catch (failure) { page.view.setBusy(false); fail(failure); }
    },
    /**
     * 中斷連接：確認後由後端向提供者撤銷授權並刪除本地資料；提供者沒確認撤銷時，告訴使用者到哪裡自己收回（取自連接器設定）
     * @param {string} id 連接器 id
     * @returns {Promise<void>} 完成
     */
    async onDisconnect(id) {
      if (!win.confirm('中斷連接後，助理就不能再讀這個服務的資料；確定要中斷嗎？')) return;
      const connector = page.connectors.find(/** 找連接器 @param {{id: string}} item 連接器 @returns {boolean} 是時 true */ (item) => item.id === id);
      page.view.setBusy(true);
      try {
        const outcome = await api.disconnectConnector(id, auth);
        say(outcome.revoked || !outcome.disconnected ? '已中斷連接' : `已中斷連接；對方沒有確認收回授權，可以到${connector?.account_page || '服務提供者的帳戶設定'}移除這個應用程式`);
      } catch (failure) { fail(failure); }
      page.view.setBusy(false);
      await refresh(id);
    },
  });
  /**
   * 從授權畫面按上一頁回來時，瀏覽器會直接拿出離開前的畫面，還停在「正在前往授權畫面…」而且按鈕是灰的
   * 這時解除處理中、清掉那行字，再重讀一次連接狀態；已經登出時交給帳號選單的檢查處理
   * @param {{persisted?: boolean}} event 頁面顯示事件
   * @returns {void}
   */
  function handlePageShow(event) {
    if (!event?.persisted || !auth.getCurrentUser()) return;
    page.view.setBusy(false);
    say('');
    refresh();
  }
  win.addEventListener('pageshow', handlePageShow);

  doc.body.hidden = false;
  let connectorFromReturn = null;
  if (returned) {
    if (!returned.state) say(RESULT_TEXT.failed, true);
    else {
      say('正在完成連接…');
      try {
        const outcome = await api.completeGoogle(returned, auth);
        connectorFromReturn = outcome.connector;
        say(RESULT_TEXT[outcome.result], outcome.result !== 'connected');
      } catch (failure) {
        const voided = await api.abandonGoogle(returned.state);
        if (failure?.status === 401) { leave(); return null; }
        say(voided ? RESULT_TEXT.failed : CANCELLED_TEXT, true);
      }
    }
  }
  await refresh(connectorFromReturn);
  return page;
}
if (typeof document !== 'undefined' && typeof document.readyState === 'string') initConnectionsPage();
