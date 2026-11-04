import net from 'node:net';

// 已安裝連線追蹤的 HTTP server → 追蹤器；以 WeakMap 保存，server 被回收時一併釋放，不在 server 物件上加私有欄位。
const connectionTrackers = new WeakMap();

/**
 * 為 HTTP server 安裝逐連線的處理中請求計數，供關機時只關閉「真正閒置」的 keep-alive 連線。
 * 不使用 Node 內建 closeIdleConnections()：它在請求本文解析完成後就把連線視為閒置，只檢查 socket._httpMessage 是否已 end()；
 * 同一連線上排隊（pipelining）的下一個請求、或前一個回應已 end() 但尚未寫出（finish 前）時，會把仍有待回應請求的連線直接銷毀。
 * 處理流程：
 * ① 'connection' 事件登記 socket，處理中請求數為 0，並記下目前已讀取位元組數（bytesRead）作為閒置基準；socket 關閉後移除。
 * ② 'request' 事件（解析出完整請求標頭，包含排隊等待回應的請求）把該連線的處理中請求數加 1。
 * ③ 回應 'finish'（已交給作業系統）或 'close'（中途中斷）時只減 1 一次，並更新閒置基準為當下的 bytesRead。
 * ④ sweepIdle() 只銷毀處理中請求數為 0 且 bytesRead 未超過閒置基準（沒有新到、尚在解析的請求資料）的連線。
 * 限制：必須在 server 開始接受連線前安裝（listenServer 會先安裝），否則安裝前已建立的連線不會被清掃，只能等 keep-alive 逾時或關機期限；
 * 重複安裝回傳同一個追蹤器，不重複註冊監聽器。尚在核心緩衝區、程序還沒讀到的位元組無法得知，屬 HTTP keep-alive 本身的競態，用戶端需自行重試冪等請求。
 * @param {import('node:http').Server} server 要追蹤的 HTTP server。
 * @returns {{sweepIdle: Function, size: Function}} sweepIdle 銷毀真正閒置的連線並回傳數量；size 回傳目前追蹤的連線數。
 */
export function trackConnections(server) {
  const existing = connectionTrackers.get(server);
  if (existing) return existing;
  const sockets = new Map();
  /**
   * 登記新連線並在關閉時移除，避免已結束的 socket 留在追蹤表中。
   * @param {import('node:net').Socket} socket 新建立的 TCP 連線。
   * @returns {void}
   */
  function onConnection(socket) {
    sockets.set(socket, { inFlight: 0, idleBytes: socket.bytesRead });
    /** 連線關閉後移出追蹤表。@returns {void} */
    function forget() { sockets.delete(socket); }
    socket.once('close', forget);
  }
  /**
   * 記錄一個尚未完成回應的請求，回應完成或中斷時只扣回一次。
   * @param {import('node:http').IncomingMessage} req 已解析標頭的請求，可能正排隊等待前一個回應。
   * @param {import('node:http').ServerResponse} res 對應的回應。
   * @returns {void}
   */
  function onRequest(req, res) {
    const state = sockets.get(req.socket);
    if (!state) return;
    state.inFlight += 1;
    let settled = false;
    /** 回應寫出或中斷後扣回處理中計數，並以目前讀取量作為新的閒置基準；finish 與 close 只算一次。@returns {void} */
    function settle() {
      if (settled) return;
      settled = true;
      state.inFlight -= 1;
      state.idleBytes = req.socket.bytesRead;
    }
    res.once('finish', settle);
    res.once('close', settle);
  }
  server.on('connection', onConnection);
  server.on('request', onRequest);
  const tracker = {
    /**
     * 銷毀沒有處理中請求、且閒置後未再收到任何位元組的連線；其餘連線保留，等回應帶 Connection: close 後自行關閉。
     * @returns {number} 本次銷毀的連線數。
     */
    sweepIdle() {
      let closed = 0;
      for (const [socket, state] of sockets) {
        if (state.inFlight > 0 || socket.bytesRead !== state.idleBytes) continue;
        socket.destroy();
        closed += 1;
      }
      return closed;
    },
    /** 取得目前追蹤中的連線數，只供測試與診斷。@returns {number} 連線數。 */
    size() { return sockets.size; },
  };
  connectionTrackers.set(server, tracker);
  return tracker;
}

/**
 * 以 Express app 建立 HTTP server，先安裝連線追蹤再開始監聽，並只在真正監聽成功（'listening' 事件）時呼叫 onListening。
 * 不把回呼傳給 app.listen：Express 5 會以 once() 包裝該回呼並同時掛在 'error' 事件上，監聽失敗（例如 EADDRINUSE）時仍會被呼叫，
 * 導致啟動成功日誌與失敗日誌同時出現。錯誤一律交給 onError（以 on 註冊，之後的 server 錯誤也會收到）。
 * @param {object} app Express app（具 listen 方法）。
 * @param {number} port 監聽埠。
 * @param {object} handlers 事件處理器。
 * @param {Function} handlers.onListening 監聽成功後呼叫，不接收參數。
 * @param {Function} handlers.onError 監聽失敗或之後的 server 錯誤，接收 Error。
 * @param {string} [host] 監聽位址；省略時與 app.listen(port) 相同，監聽所有介面。
 * @returns {import('node:http').Server} 已安裝連線追蹤的 HTTP server。
 */
export function listenServer(app, port, { onListening, onError }, host) {
  const server = host === undefined ? app.listen(port) : app.listen(port, host);
  trackConnections(server);
  server.once('listening', onListening);
  server.on('error', onError);
  return server;
}

/**
 * 停止接受新對話及 HTTP 連線，同時等待連線結束和對話租約清理。
 * 處理流程：① tasks.stop() 禁止新工作（關機中的回應另由 closeOnShutdown 加上 Connection: close）→ ② server.close() 停止監聽並等待既有連線結束 →
 * ③ tasks.idle() 完成後，每隔 sweepMs 以 trackConnections 的 sweepIdle() 清掃，只銷毀沒有處理中請求、也沒有新到資料的 keep-alive 連線，直到 close 完成或逾時。
 *    第一次清掃延後一個間隔才執行；有處理中或排隊請求的連線不會被清掃，會在帶 Connection: close 的回應寫完後自行關閉。
 * 超過期限時由呼叫端決定如何強制關閉，不在此函式直接結束程序，方便測試。
 * 限制：server 未安裝 trackConnections（例如測試替身或直接 app.listen 建立的 server）時不清掃，只能等連線自行關閉或逾時；
 * 不使用 Node 內建 closeIdleConnections()，它會銷毀仍有排隊請求的連線；因此停止監聽時改呼叫 net.Server.prototype.close，
 * 避開 http.Server.close 在關閉前自動執行的那一次 closeIdleConnections()。
 * @param {import('node:http').Server} server HTTP server。
 * @param {object} tasks 支援 stop 與 idle 的工作追蹤器。
 * @param {number} timeoutMs 最多等待時間，單位毫秒。
 * @param {number} [sweepMs=50] 工作結束後清掃閒置連線的間隔，單位毫秒。
 * @returns {Promise<void>} 所有工作及連線結束。
 * @throws {Error} 逾時（SHUTDOWN_TIMEOUT）或 HTTP server 關閉失敗。
 */
export async function drainServer(server, tasks, timeoutMs, sweepMs = 50) {
  tasks.stop();
  const connections = connectionTrackers.get(server);
  let timer;
  let sweeper;
  let closing = true;
  /** 開始關閉 HTTP server。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function closeServer(resolve, reject) {
    /** 處理 HTTP 關閉結果，並標記不再需要清掃。@param {Error} [error] 關閉錯誤。@returns {void} */
    function closed(error) { closing = false; if (error) reject(error); else resolve(); }
    // 真正的 server 直接呼叫 net.Server 的 close：http.Server.close 會先執行一次內建 closeIdleConnections()，
    // 把「回應已 end() 但尚未 finish、且已有排隊請求」的連線當成閒置銷毀；停止監聽只需要 net 層的 close。
    // 測試替身不是 net.Server，沿用它自己的 close。
    if (server instanceof net.Server) net.Server.prototype.close.call(server, closed);
    else server.close(closed);
  }
  /** 關閉沒有處理中請求且沒有新到資料的連線；未安裝追蹤器時略過。@returns {void} */
  function sweepIdle() { if (closing) connections?.sweepIdle(); }
  /**
   * 等待所有工作與租約清理完成後開始定期清掃閒置連線（第一次在 sweepMs 後），處理回應完畢但仍保持 keep-alive 的連線。
   * @returns {Promise<void>} 工作全部結束。
   */
  async function idleThenSweep() {
    await tasks.idle();
    if (closing && connections) sweeper = setInterval(sweepIdle, sweepMs);
  }
  /** 建立關機總期限。@param {Function} resolve 成功，此處不使用。@param {Function} reject 逾時。@returns {void} */
  function deadline(resolve, reject) {
    /** 以固定錯誤通知呼叫端強制關閉。@returns {void} */
    function expire() { reject(new Error('SHUTDOWN_TIMEOUT')); }
    timer = setTimeout(expire, timeoutMs);
  }
  try { await Promise.race([Promise.all([new Promise(closeServer), idleThenSweep()]), new Promise(deadline)]); }
  finally { closing = false; clearTimeout(timer); clearInterval(sweeper); }
}

/**
 * 以 target.on（不是 once）註冊關機訊號：第一次收到任一訊號時呼叫 onFirst 開始優雅關機；
 * 第一次訊號後 repeatWindowMs 內再收到的訊號視為同一次操作的重複送達（例如 npm start／npm run dev 下按一次 Ctrl+C，
 * 終端機送給整個程序群組的 SIGINT 加上 npm 轉送的 SIGINT 會在數毫秒內抵達兩次），只呼叫 onIgnored，不強制結束；
 * 超過該時間窗後再收到的訊號才呼叫 onRepeat（通常是強制結束）。
 * 使用 on 是為了讓後續訊號仍由程式處理，不會因監聽器已移除而落回 Node 預設行為直接終止程序、略過資料庫關閉。
 * @param {object} options 註冊選項。
 * @param {Function} options.onFirst 第一次訊號的處理器，接收訊號名稱；可回傳 Promise，此處不等待。
 * @param {Function} options.onRepeat 時間窗之後再收到訊號的處理器，接收訊號名稱。
 * @param {Function} [options.onIgnored] 時間窗內重複訊號的處理器（例如記錄日誌），接收訊號名稱；省略時不做任何事。
 * @param {import('node:events').EventEmitter} [options.target=process] 發出訊號事件的對象，測試可注入 EventEmitter。
 * @param {string[]} [options.signals=['SIGINT', 'SIGTERM']] 要監聽的訊號。
 * @param {number} [options.repeatWindowMs=1000] 第一次訊號後忽略重複訊號的時間窗，單位毫秒；0 表示不去抖動。
 * @param {Function} [options.now=Date.now] 取得目前時間（毫秒）的函式，測試可注入假時鐘。
 * @returns {Function} 已註冊的訊號處理器，供測試或移除監聽使用。
 */
export function installSignalHandlers({ onFirst, onRepeat, onIgnored, target = process, signals = ['SIGINT', 'SIGTERM'], repeatWindowMs = 1000, now = Date.now }) {
  let firstAt = null;
  /**
   * 依是否已收過訊號及距第一次訊號的時間，分派給 onFirst、onIgnored 或 onRepeat。
   * @param {string} signal 收到的訊號名稱。
   * @returns {void}
   */
  function handleSignal(signal) {
    if (firstAt === null) { firstAt = now(); onFirst(signal); return; }
    if (now() - firstAt < repeatWindowMs) { onIgnored?.(signal); return; }
    onRepeat(signal);
  }
  for (const signal of signals) target.on(signal, handleSignal);
  return handleSignal;
}

/**
 * 建立程序關機流程：shutdown 優雅關機、forceExit 強制結束；所有外部依賴皆由參數注入，讓測試不必真的結束程序。
 * shutdown：只執行一次 → 記錄 server.stopping → drainServer 排空工作與連線 → 關閉資料庫 → exit(0)；
 *           排空失敗或逾時 → 記錄 server.shutdown.failed → closeAllConnections → 關閉資料庫 → exit(1)。
 * forceExit：記錄 server.shutdown.forced → closeAllConnections → 關閉資料庫（讓 WAL 合併回主檔）→ exit(1)，不等待剩餘工作。
 * @param {object} options 關機依賴。
 * @param {import('node:http').Server} options.server HTTP server，需支援 close、closeAllConnections。
 * @param {object} options.tasks 支援 stop 與 idle 的工作追蹤器。
 * @param {number} options.timeoutMs 優雅關機期限，單位毫秒。
 * @param {Function} options.closeStorage 關閉資料庫的函式，須自行吞下錯誤（只記錄），不得拋出。
 * @param {Function} options.log 日誌函式，簽名同 logger(level, event, fields)。
 * @param {Function} [options.exit=process.exit] 結束程序的函式，接收結束碼。
 * @param {number} [options.sweepMs] 傳給 drainServer 的清掃間隔；省略時使用其預設值。
 * @returns {{shutdown: Function, forceExit: Function}} shutdown(signal) 回傳 Promise<void>；forceExit(signal) 回傳 void。
 */
export function createShutdown({ server, tasks, timeoutMs, closeStorage, log, exit = process.exit, sweepMs }) {
  let stopping = false;
  /**
   * 停止接受新需求單與連線，等待既有工作及租約清理完成後關閉資料庫，再以 0 結束；重複呼叫不啟動第二次關機。
   * 超過期限或關閉失敗時強制關閉全部連線、仍關閉資料庫，並以 1 結束。
   * @param {string} [signal] 觸發關機的訊號名稱，只用於日誌。
   * @returns {Promise<void>} 關機流程結束（實際執行時程序會在 exit 時終止）。
   */
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log('info', 'server.stopping', { signal, timeoutMs });
    try {
      await drainServer(server, tasks, timeoutMs, sweepMs);
      closeStorage();
      log('info', 'server.stopped');
      exit(0);
    } catch {
      log('error', 'server.shutdown.failed', { reason: 'DRAIN_FAILED_OR_TIMEOUT' });
      server.closeAllConnections();
      closeStorage();
      exit(1);
    }
  }
  /**
   * 關機進行中再收到（去抖動時間窗之外的）訊號時強制結束：記錄事件、關閉所有 HTTP 連線並關閉資料庫後以結束碼 1 離開。
   * @param {string} signal 觸發強制結束的訊號名稱。
   * @returns {void}
   */
  function forceExit(signal) {
    log('error', 'server.shutdown.forced', { signal, reason: 'REPEATED_SIGNAL' });
    server.closeAllConnections();
    closeStorage();
    exit(1);
  }
  return { shutdown, forceExit };
}

/**
 * 建立關機流程並註冊到訊號來源：第一次訊號開始優雅關機，去抖動時間窗內的重複訊號只記錄 debug 日誌，之後的訊號強制結束。
 * @param {object} options createShutdown 的全部選項，另可加上下列訊號選項。
 * @param {import('node:events').EventEmitter} [options.target=process] 訊號來源，測試可注入 EventEmitter。
 * @param {number} [options.repeatWindowMs] 重複訊號去抖動時間窗，省略時使用 installSignalHandlers 的預設值。
 * @param {Function} [options.now] 假時鐘，省略時使用 Date.now。
 * @returns {{shutdown: Function, forceExit: Function, handleSignal: Function}} 關機函式與已註冊的訊號處理器。
 */
export function installShutdown({ target, repeatWindowMs, now, ...options }) {
  const { shutdown, forceExit } = createShutdown(options);
  /** 記錄被去抖動忽略的重複訊號，方便排查 npm 轉送的雙重 SIGINT。@param {string} signal 訊號名稱。@returns {void} */
  function onIgnored(signal) { options.log('debug', 'server.signal.ignored', { signal, reason: 'DUPLICATE_SIGNAL' }); }
  const handleSignal = installSignalHandlers({ onFirst: shutdown, onRepeat: forceExit, onIgnored,
    ...(target ? { target } : {}), ...(repeatWindowMs === undefined ? {} : { repeatWindowMs }), ...(now ? { now } : {}) });
  return { shutdown, forceExit, handleSignal };
}
