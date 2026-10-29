import { loadAdminMetrics } from '../services/adminService.js';
import { renderAdminMetrics } from './adminMetrics.js';

/**
 * 初始化管理監測輪詢；單一請求完成後才排下一次，避免慢網路造成重疊。
 * 隱藏分頁／離開／重置時中止請求，保留舊快照；429 尊重 Retry-After，其他錯誤逐步退避。
 * @param {Document} doc 頁面文件。
 * @param {Window} win 視窗與計時器。
 * @param {object} options 登入與可替換依賴。
 * @param {object} options.auth 登入服務。
 * @param {Function} options.leave 登入失效時離開管理頁。
 * @param {Function} [options.load=loadAdminMetrics] 快照讀取服務。
 * @returns {object} ready、refresh、suspend、resume、destroy，供頁面重置與測試使用。
 */
export function initAdminMonitoring(doc, win, { auth, leave, load = loadAdminMetrics }) {
  const root = doc.querySelector('#admin-monitoring');
  // 舊頁面或不含監測區塊的文件不啟動背景請求。
  if (!root) {
    /** 無監測區塊時不執行操作。@returns {void} */
    function noop() {}
    return { ready: Promise.resolve(), refresh: noop, suspend: noop, resume: noop, destroy: noop };
  }
  const status = doc.querySelector('#metrics-status');
  const refreshButton = doc.querySelector('#metrics-refresh');
  const toggle = doc.querySelector('#metrics-toggle');
  let intervalMs = 5000;
  let automatic = true;
  let suspended = false;
  let pageHidden = false;
  let destroyed = false;
  let timer = null;
  let active = null;
  let failures = 0;
  let notBefore = 0;
  /** 清除唯一的排程，不影響正在執行的重置。@returns {void} */
  function clearTimer() { if (timer !== null) { win.clearTimeout(timer); timer = null; } }
  /** 同步按鈕狀態；手動更新不會重新開啟已暫停的自動更新。@returns {void} */
  function buttons() {
    refreshButton.disabled = Boolean(active) || suspended || destroyed;
    toggle.disabled = suspended || destroyed;
    toggle.textContent = automatic ? '暫停自動更新' : '啟用自動更新';
    toggle.setAttribute('aria-pressed', String(automatic));
  }
  /** 清除排程並取消過時請求；active 身分比對可阻止舊回應覆蓋重置後的新資料。@returns {void} */
  function cancel() { clearTimer(); const request = active; active = null; request?.abort(); buttons(); }
  /** 只在可見且允許自動更新時排程；不以 setInterval 累積並行請求。@returns {void} */
  function schedule() {
    clearTimer();
    if (!automatic || suspended || destroyed || pageHidden || doc.hidden || active) return;
    timer = win.setTimeout(tick, Math.max(intervalMs, notBefore - Date.now()));
  }
  /** 計時器觸發後讀取下一個快照。@returns {Promise<void>} 本次更新。 */
  async function tick() { timer = null; await refresh(); }
  /**
   * 執行一個唯讀請求；保留最後成功資料，錯誤時清楚顯示陳舊狀態。
   * @returns {Promise<void>} 更新完成或被暫停；401 登出，403 停止自動更新。
   */
  async function refresh() {
    if (destroyed || suspended || pageHidden || doc.hidden || active) return;
    clearTimer();
    if (Date.now() < notBefore) { status.textContent = `更新暫停，請於 ${Math.ceil((notBefore - Date.now()) / 1000)} 秒後再試；目前顯示上次快照。`; schedule(); return; }
    const request = new AbortController();
    active = request;
    status.textContent = '正在取得監測快照…';
    buttons();
    try {
      const data = await load(auth, { signal: request.signal });
      if (active !== request || destroyed) return;
      renderAdminMetrics(doc, data);
      intervalMs = data.pollSeconds * 1000;
      failures = 0;
      notBefore = 0;
      status.textContent = automatic ? `每 ${data.pollSeconds} 秒更新；資料為取樣快照，非逐筆推播。` : '已手動更新，自動更新仍暫停。';
    } catch (error) {
      if (active !== request || destroyed) return;
      if (error.status === 401) { destroy(); leave(); return; }
      failures += 1;
      if (error.status === 403) automatic = false;
      const delay = error.status === 429 && error.retryAfter ? error.retryAfter * 1000 : Math.min(60000, intervalMs * 2 ** Math.min(failures, 4));
      notBefore = Date.now() + delay;
      status.textContent = `更新失敗：${error.message || '無法連線'}。目前數據不是最新快照。${automatic ? `約 ${Math.ceil(delay / 1000)} 秒後重試。` : '自動更新已暫停。'}`;
    } finally {
      if (active === request) { active = null; buttons(); schedule(); }
    }
  }
  /** 手動更新按鈕，略過瀏覽器事件參數。@returns {Promise<void>} 更新完成。 */
  async function manualRefresh() { await refresh(); }
  /** 切換自動更新，停止時中止在途請求，啟用時立即取樣。@returns {Promise<void>} 必要的首次更新。 */
  async function toggleAutomatic() {
    automatic = !automatic;
    cancel();
    if (automatic) await refresh();
    else status.textContent = '自動更新已暫停；可按立即更新取得快照。';
    buttons();
  }
  /** 重置期間暫停監測，防止畫面顯示清除前的過時回應。@returns {void} */
  function suspend() { suspended = true; cancel(); status.textContent = '資料重置中，監測暫停。'; }
  /** 重置完成後立即重取快照，保留使用者原本的自動更新選擇。@returns {Promise<void>} 更新完成。 */
  async function resume() { suspended = false; await refresh(); }
  /** 可見時恢復取樣；隱藏時停止請求與計時器。@returns {Promise<void>} 恢復時的更新。 */
  async function visibility() {
    if (doc.hidden) { cancel(); status.textContent = '分頁已隱藏，暫停更新。'; }
    else if (automatic) await refresh();
  }
  /** 離開或進入往返快取時中止輪詢。@returns {void} */
  function hidePage() { pageHidden = true; cancel(); }
  /** 從往返快取恢復後重新取樣。@returns {Promise<void>} 更新完成。 */
  async function showPage() { pageHidden = false; if (automatic) await refresh(); }
  /** 永久停止輪詢並移除事件；登入失效後不再發送背景請求。@returns {void} */
  function destroy() {
    destroyed = true;
    cancel();
    doc.removeEventListener?.('visibilitychange', visibility);
    win.removeEventListener?.('pagehide', hidePage);
    win.removeEventListener?.('pageshow', showPage);
    refreshButton.removeEventListener('click', manualRefresh);
    toggle.removeEventListener('click', toggleAutomatic);
  }
  refreshButton.addEventListener('click', manualRefresh);
  toggle.addEventListener('click', toggleAutomatic);
  doc.addEventListener?.('visibilitychange', visibility);
  win.addEventListener('pagehide', hidePage);
  win.addEventListener('pageshow', showPage);
  buttons();
  const ready = refresh();
  return { ready, refresh, suspend, resume, destroy };
}
