/**
 * 建立待簽核卡片動作狀態的集中儲存：以單號保存「處理中的動作」「卡片錯誤」與「限流倒數到期時間」，
 * 讓清單重新繪製（例如另一張卡片動作成功後重新載入）時，新卡片能接回進行中的請求、錯誤與倒數。
 * 倒數只用一個共用的 250 ms 計時器，以 Date.now 推算剩餘秒數；沒有卡片在倒數、頁面隱藏（pause）或停止（stop）時清除計時器。
 * @param {object} [options={}] 設定。
 * @param {{setInterval: Function, clearInterval: Function}} [options.timers=globalThis] 計時器來源，頁面傳入視窗物件，測試可注入替身。
 * @param {Function|null} [options.onOrphanError=null] 動作失敗時卡片已不在畫面上（清單已不含這張單）時呼叫，接收錯誤文字，讓頁面改在清單上方顯示。
 * @returns {{get: Function, retain: Function, pause: Function, resume: Function, stop: Function, isTicking: Function}} 狀態儲存控制器。
 */
export function createActionStateStore({ timers = globalThis, onOrphanError = null } = {}) {
  const entries = new Map();
  let timer = null;
  let paused = false;

  /**
   * 計算某張卡片限流倒數的剩餘秒數。
   * @param {object} entry 卡片動作狀態。
   * @returns {number} 向上取整的剩餘秒數，最小為零。
   */
  function remaining(entry) { return Math.max(0, Math.ceil((entry.waitUntil - Date.now()) / 1000)); }

  /**
   * 把狀態套用到目前畫面上的卡片表單；卡片已不在畫面上且有錯誤時改交給 onOrphanError 顯示一次，之後清除錯誤避免重複顯示。
   * @param {object} entry 卡片動作狀態。
   * @returns {void}
   */
  function show(entry) {
    if (entry.render) { entry.render(); return; }
    if (entry.error && onOrphanError) { onOrphanError(entry.error); entry.error = ''; }
  }

  /**
   * 判斷是否還有卡片在倒數。
   * @returns {boolean} 至少一張卡片的倒數尚未到期。
   */
  function anyWaiting() {
    for (const entry of entries.values()) if (entry.waitUntil && remaining(entry) > 0) return true;
    return false;
  }

  /** 清除共用倒數計時器。@returns {void} */
  function clearTimer() {
    if (timer === null) return;
    timers.clearInterval(timer);
    timer = null;
  }

  /**
   * 每 250 ms 更新倒數中的卡片：未到期的重新繪製剩餘秒數，到期的清除倒數並解除鎖定；沒有卡片在倒數時停止計時器。
   * @returns {void}
   */
  function tick() {
    for (const entry of entries.values()) {
      if (!entry.waitUntil) continue;
      if (remaining(entry) === 0) { entry.waitUntil = 0; entry.waitKey = null; }
      show(entry);
    }
    if (!anyWaiting()) clearTimer();
  }

  /** 有卡片在倒數且頁面沒有隱藏時啟動共用計時器（已啟動則不重複）。@returns {void} */
  function ensureTimer() {
    if (paused || timer !== null || !anyWaiting()) return;
    timer = timers.setInterval(tick, 250);
  }

  /**
   * 取得（必要時建立）某張單的動作狀態。同一張單在每次重新繪製都拿到同一個物件；
   * 卡片表單建立時把自己的繪製函式設到 render，舊表單的非同步結果因此會寫到最新的卡片。
   * @param {string} ticketId 單號。
   * @returns {object} 動作狀態：busy（處理中的動作代號或 null）、error（卡片錯誤文字）、waitUntil（倒數到期的毫秒時間，0 表示沒有）、
   *   waitKey（觸發倒數的動作代號）、render（目前卡片的繪製函式或 null），以及 remaining()、beginWait(seconds, key)、show() 三個方法。
   */
  function get(ticketId) {
    let entry = entries.get(ticketId);
    if (entry) return entry;
    entry = {
      busy: null, error: '', waitUntil: 0, waitKey: null, render: null,
      /** 剩餘倒數秒數。@returns {number} 秒數，最小為零。 */
      remaining() { return remaining(entry); },
      /**
       * 開始限流倒數並啟動共用計時器。
       * @param {number} seconds 後端要求的等待秒數（呼叫端已確認 0 < seconds ≤ 300）。
       * @param {string} key 觸發倒數的動作代號，該按鈕會顯示「請等 N 秒」。
       * @returns {void}
       */
      beginWait(seconds, key) { entry.waitUntil = Date.now() + seconds * 1000; entry.waitKey = key; ensureTimer(); },
      /** 把目前狀態套用到畫面上的卡片。@returns {void} */
      show() { show(entry); },
    };
    entries.set(ticketId, entry);
    return entry;
  }

  /**
   * 清單重新繪製後只保留畫面上仍有卡片的單：不在畫面上且沒有請求進行中的狀態直接移除；
   * 請求仍在進行中的保留（結果回來時改由 onOrphanError 顯示錯誤），但解除對舊卡片的繪製參照。
   * @param {Iterable<string>} ticketIds 目前畫面上的待簽核單號。
   * @returns {void}
   */
  function retain(ticketIds) {
    const visible = new Set(ticketIds);
    for (const [ticketId, entry] of entries) {
      if (visible.has(ticketId)) continue;
      if (entry.busy) entry.render = null;
      else entries.delete(ticketId);
    }
    if (!anyWaiting()) clearTimer();
  }

  /** 頁面隱藏（pagehide）時暫停倒數計時器；到期時間保留，恢復時依目前時間重新推算。@returns {void} */
  function pause() { paused = true; clearTimer(); }

  /** 頁面恢復（pageshow）時立即更新倒數中的卡片，仍有倒數時重新啟動計時器。@returns {void} */
  function resume() {
    paused = false;
    tick();
    ensureTimer();
  }

  /** 停止計時器並清除所有狀態。@returns {void} */
  function stop() { clearTimer(); entries.clear(); }

  /** 共用倒數計時器是否正在執行（測試與除錯用）。@returns {boolean} 是否執行中。 */
  function isTicking() { return timer !== null; }

  return { get, retain, pause, resume, stop, isTicking };
}
