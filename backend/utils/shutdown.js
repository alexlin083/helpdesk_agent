/**
 * 停止接受新對話及 HTTP 連線，同時等待連線結束和對話租約清理。
 * 超過期限時由呼叫端決定如何強制關閉，不在此函式直接結束程序，方便測試。
 * @param {import('node:http').Server} server HTTP server。
 * @param {object} tasks 支援 stop 與 idle 的工作追蹤器。
 * @param {number} timeoutMs 最多等待時間，單位毫秒。
 * @returns {Promise<void>} 所有工作及連線結束。
 * @throws {Error} 逾時或 HTTP server 關閉失敗。
 */
export async function drainServer(server, tasks, timeoutMs) {
  tasks.stop();
  let timer;
  /** 開始關閉 HTTP server。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function closeServer(resolve, reject) {
    /** 處理 HTTP 關閉結果。@param {Error} [error] 關閉錯誤。@returns {void} */
    function closed(error) { if (error) reject(error); else resolve(); }
    server.close(closed);
  }
  /** 建立關機總期限。@param {Function} resolve 成功，此處不使用。@param {Function} reject 逾時。@returns {void} */
  function deadline(resolve, reject) {
    /** 以固定錯誤通知呼叫端強制關閉。@returns {void} */
    function expire() { reject(new Error('SHUTDOWN_TIMEOUT')); }
    timer = setTimeout(expire, timeoutMs);
  }
  try { await Promise.race([Promise.all([new Promise(closeServer), tasks.idle()]), new Promise(deadline)]); }
  finally { clearTimeout(timer); }
}
