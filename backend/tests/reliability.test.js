import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import express from 'express';
import { setupTestEnv } from './helpers/testEnv.js';

setupTestEnv();
const { createTaskTracker, trackRequest } = await import('../src/services/taskTracker.js');
const { createCloseOnShutdown } = await import('../src/middleware/closeOnShutdown.js');
const { createTicketHandler } = await import('../src/controllers/ticketController.js');
const { createTicketJudge } = await import('../src/services/ai/ticketJudge.js');
const { createDepartmentService } = await import('../src/services/departmentService.js');
const { drainServer, installSignalHandlers, installShutdown, listenServer, trackConnections } = await import('../src/utils/shutdown.js');
const { loadEnv } = await import('../src/config/env.js');
const { createMemoryLimitStore } = await import('../src/services/storage/limitStore.js');
const { createUsageService } = await import('../src/services/usageService.js');

const departments = createDepartmentService({ departments: [
  { id: 'dept-it-1', name: '資訊管理一部', duty: 'IT資訊服務台', business: ['IT資訊服務台'] },
] });
const request = { user: { userID: 'user-racky.huang', username: 'racky.huang', department: { id: 'dept-it-1', name: '資訊管理一部' } }, body: { subject: '申請 VPN 帳號', content: '新進同仁需要 VPN 連線權限' } };

/** 驗證關機等待 HTTP 關閉後仍未完成的清理，並禁止新工作。@returns {Promise<void>} */
async function gracefulDrain() {
  const tasks = createTaskTracker();
  let finish;
  let drained = false;
  /** 保存清理的完成控制。@param {Function} resolve 完成。@returns {void} */
  function pending(resolve) { finish = resolve; }
  const release = new Promise(pending);
  /** 模擬仍在釋放租約的請求。@returns {Promise<void>} 清理。 */
  async function work() { await release; }
  const active = tasks.run(work);
  /** 模擬 HTTP 連線已結束，不代表非同步清理已完成。@param {Function} callback 關閉通知。@returns {void} */
  function close(callback) { callback(); }
  /** 等待整個關機流程，記錄完成狀態。@returns {Promise<void>} 關機。 */
  async function drain() { await drainServer({ close }, tasks, 1000); drained = true; }
  const shutdown = drain();
  await assert.rejects(tasks.run(work), { status: 503, code: 'SERVICE_BUSY' });
  await delay(0);
  assert.equal(drained, false);
  finish();
  await Promise.all([active, shutdown]);
  assert.equal(drained, true);
}
test('關機等待租約清理並拒絕新工作', gracefulDrain);

/** 確認未結束的 HTTP 連線仍受關機期限約束。@returns {Promise<void>} */
async function drainTimeout() {
  /** 模擬連線永不關閉。@returns {void} */
  function close() {}
  await assert.rejects(drainServer({ close }, createTaskTracker(), 20), /SHUTDOWN_TIMEOUT/);
}
test('關機總期限防止無限等待', drainTimeout);

/** 驗證需求單在釋放租約後才回傳成功，避免回應完成但清理未完成；關機中的追蹤器拒絕新需求單。@returns {Promise<void>} */
async function releaseBeforeResponse() {
  const events = [];
  /** 回傳測試配額。@returns {Promise<object>} 租約與用量。 */
  async function reserve() { return { id: 'test', usage: { userRemaining: 1, globalRemaining: 1 } }; }
  /** 完成租約釋放。@returns {Promise<void>} 完成。 */
  async function release() { await delay(0); events.push('released'); }
  /** 模擬判斷結果。@returns {Promise<object>} 分流。 */
  async function judge() { return { route: 'FALLBACK', department: departments.defaultDepartment(), aiDepartment: null, confidence: 10, basis: '', model: 'test' }; }
  /** 記錄保存。@returns {Promise<void>} 完成。 */
  async function insert() { events.push('saved'); }
  /** 接收回應標頭。@returns {void} */
  function set() {}
  /** 記錄回應時機。@param {object} result 結果。@returns {void} */
  function json(result) { assert.equal(result.route, 'FALLBACK'); events.push('responded'); }
  const tasks = createTaskTracker();
  const handler = createTicketHandler({ departments, judge, store: { insert }, usage: { reserve, release }, tasks });
  await handler(request, { set, json });
  assert.deepEqual(events, ['saved', 'released', 'responded']);
  tasks.stop();
  await assert.rejects(handler(request, { set, json }), { status: 503, code: 'SERVICE_BUSY' });
}
test('成功回應等待租約釋放，關機中拒絕新需求單', releaseBeforeResponse);

/** 驗證真實用量服務在判斷逾時後保留扣額並釋放租約。@returns {Promise<void>} */
async function timeoutReleasesQuotaLease() {
  const store = createMemoryLimitStore();
  const usage = createUsageService({ store });
  let signal;
  /** 模擬永不回應的模型，外層期限必須結束等待。@param {object} call SDK 請求。@returns {Promise<never>} 未完成結果。 */
  function generateContent(call) {
    signal = call.config.abortSignal;
    /** 保持未完成，模擬上游沒有回覆。@returns {void} */
    function pending() {}
    return new Promise(pending);
  }
  /** 提供替身 SDK。@returns {object} SDK。 */
  function getAI() { return { models: { generateContent } }; }
  /** 接收回應標頭。@returns {void} */
  function set() {}
  const judge = createTicketJudge({ getAI, departments, timeoutMs: 20 });
  const handler = createTicketHandler({ departments, judge, store: { insert: async () => {} }, usage });
  await assert.rejects(handler(request, { set }), { status: 500, code: 'SERVER_ERROR' });
  assert.equal(signal.aborted, true);
  const state = await store.read();
  assert.deepEqual(state.leases, {});
  assert.equal(state.users['user-racky.huang'], 1);
  assert.equal(state.total, 1);
}
test('判斷逾時仍扣額、取消上游等待並釋放真實記憶體租約', timeoutReleasesQuotaLease);

/** 確認關機預設 75 秒與下限 70 秒，確保 60 秒自動生成回合仍有 10 秒清理緩衝；過短設定在啟動前拒絕。@returns {void} */
function shutdownConfiguration() {
  const options = { environment: { NODE_ENV: 'local', DEMO_PASSWORD: 'test-only-password', ADMIN_PASSWORD: 'test-admin-only-password' }, envFile: '/nonexistent/helpdesk/.env' };
  assert.equal(loadEnv(options).shutdownTimeoutMs, 75000);
  assert.equal(loadEnv({ ...options, environment: { ...options.environment, SHUTDOWN_TIMEOUT_MS: '70000' } }).shutdownTimeoutMs, 70000);
  /** 嘗試低於新下限（自動生成 60 秒＋10 秒緩衝）的期限。@returns {object} 設定。@throws {Error} 不合法的期限。 */
  function belowDraftDeadline() { return loadEnv({ ...options, environment: { ...options.environment, SHUTDOWN_TIMEOUT_MS: '69999' } }); }
  assert.throws(belowDraftDeadline, /70000/);
  /** 嘗試過短的關機緩衝。@returns {object} 設定。@throws {Error} 不合法的期限。 */
  function shortDrain() { return loadEnv({ ...options, environment: { ...options.environment, SHUTDOWN_TIMEOUT_MS: '10000' } }); }
  assert.throws(shortDrain, /SHUTDOWN_TIMEOUT_MS/);
}
test('關機期限設定驗證', shutdownConfiguration);

/**
 * 建立模擬正式環境的測試 server：掛上關機時加 Connection: close 的 middleware，/slow 由工作追蹤器追蹤並等待外部放行，/fast 立即回應。
 * keepAliveTimeout 拉長到 60 秒，模擬反向代理連線池長時間保持連線，避免靠 Node 預設逾時意外關閉而掩蓋問題。
 * 與 index.js 相同，在接受連線前安裝 trackConnections，drainServer 才會清掃真正閒置的連線。
 * @param {object} tasks 工作追蹤器。
 * @returns {Promise<{server: import('node:http').Server, port: number, release: Function, slowStarted: Promise<void>, fastSeen: Promise<void>}>} server 與控制點。
 */
async function keepAliveServer(tasks) {
  let release;
  let markSlow;
  let markFast;
  /** 保存放行 /slow 的控制。@param {Function} resolve 放行。@returns {void} */
  function holdRelease(resolve) { release = resolve; }
  const gate = new Promise(holdRelease);
  /** 保存 /slow 開始處理的通知。@param {Function} resolve 通知。@returns {void} */
  function holdSlow(resolve) { markSlow = resolve; }
  const slowStarted = new Promise(holdSlow);
  /** 保存 /fast 已處理的通知。@param {Function} resolve 通知。@returns {void} */
  function holdFast(resolve) { markFast = resolve; }
  const fastSeen = new Promise(holdFast);
  /** 模擬需要等待清理的請求。@param {object} req 請求。@param {object} res 回應。@returns {Promise<void>} 放行後回應。 */
  async function slow(req, res) { markSlow(); await gate; res.json({ ok: 'slow' }); }
  /** 立即回應的請求。@param {object} req 請求。@param {object} res 回應。@returns {void} */
  function fast(req, res) { markFast(); res.json({ ok: 'fast' }); }
  const application = express();
  application.use(createCloseOnShutdown(tasks));
  application.get('/slow', trackRequest(slow, tasks));
  application.get('/fast', fast);
  const server = application.listen(0, '127.0.0.1');
  trackConnections(server);
  server.keepAliveTimeout = 60000;
  /** 等待監聽成功。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function listening(resolve, reject) { server.once('listening', resolve); server.once('error', reject); }
  await new Promise(listening);
  return { server, port: server.address().port, release, slowStarted, fastSeen };
}

/**
 * 以指定 agent 發出 GET 並讀完本文。
 * @param {http.Agent} agent keep-alive agent。
 * @param {number} port 測試埠。
 * @param {string} path 路徑。
 * @returns {Promise<{headers: object, body: string}>} 回應標頭與本文。
 */
function getWithAgent(agent, port, path) {
  /** 發出請求並收集回應。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function send(resolve, reject) {
    /** 收集回應本文。@param {http.IncomingMessage} response 回應。@returns {void} */
    function onResponse(response) {
      let body = '';
      /** 累加本文片段。@param {Buffer} chunk 片段。@returns {void} */
      function onData(chunk) { body += chunk; }
      /** 本文讀完後回傳。@returns {void} */
      function onEnd() { resolve({ headers: response.headers, body }); }
      response.on('data', onData);
      response.on('end', onEnd);
    }
    http.get({ host: '127.0.0.1', port, path, agent }, onResponse).on('error', reject);
  }
  return new Promise(send);
}

/**
 * 驗證 keep-alive 連線不會讓優雅關機拖到強制逾時：關機前已開始處理的請求回應仍是 keep-alive，
 * 工作結束後 drainServer 會清掃閒置連線，使 server.close() 遠早於期限完成。
 * @returns {Promise<void>}
 */
async function keepAliveDrain() {
  const tasks = createTaskTracker();
  const { server, port, release, slowStarted } = await keepAliveServer(tasks);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const warm = await getWithAgent(agent, port, '/fast');
    assert.equal(warm.headers.connection, 'keep-alive', '一般情況下維持 keep-alive');
    const pending = getWithAgent(agent, port, '/slow');
    await slowStarted;
    const started = Date.now();
    const drained = drainServer(server, tasks, 3000);
    await delay(20);
    release();
    const slowResponse = await pending;
    assert.equal(slowResponse.body, '{"ok":"slow"}');
    await drained;
    assert.ok(Date.now() - started < 1000, `關機應遠早於 3 秒期限完成，實際 ${Date.now() - started} ms`);
  } finally {
    agent.destroy();
    server.closeAllConnections();
  }
}
test('keep-alive 連線不讓優雅關機落入強制逾時', keepAliveDrain);

/**
 * 驗證關機中才收到的請求（同一條持久連線上的下一個請求）回應帶 Connection: close，回應後連線關閉，關機很快完成。
 * 使用原始 TCP 連線依序送出兩個請求，模擬代理沿用既有連線繼續轉送。
 * @returns {Promise<void>}
 */
async function connectionCloseWhileStopping() {
  const tasks = createTaskTracker();
  const { server, port, release, slowStarted, fastSeen } = await keepAliveServer(tasks);
  const socket = net.connect(port, '127.0.0.1');
  let raw = '';
  /** 累加原始回應。@param {Buffer} chunk 片段。@returns {void} */
  function onData(chunk) { raw += chunk; }
  socket.on('data', onData);
  /** 等待伺服器結束連線。@param {Function} resolve 結束。@returns {void} */
  function waitEnd(resolve) { socket.once('close', resolve); }
  const ended = new Promise(waitEnd);
  try {
    socket.write('GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await slowStarted;
    const started = Date.now();
    const drained = drainServer(server, tasks, 3000);
    socket.write('GET /fast HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await fastSeen;
    release();
    await Promise.all([drained, ended]);
    assert.ok(Date.now() - started < 1000, `關機應遠早於期限完成，實際 ${Date.now() - started} ms`);
    const responses = raw.split('HTTP/1.1 ').filter(Boolean);
    assert.equal(responses.length, 2);
    assert.match(responses[1], /\r\nconnection: close\r\n/i, '關機中才處理的請求要求關閉連線');
    assert.ok(responses[1].includes('{"ok":"fast"}'));
  } finally {
    socket.destroy();
    server.closeAllConnections();
  }
}
test('關機中的回應帶 Connection: close 並關閉持久連線', connectionCloseWhileStopping);

/**
 * 建立可控制時間的假時鐘，供訊號去抖動測試使用。
 * @param {number} [start=0] 起始毫秒。
 * @returns {{now: Function, advance: Function}} now 回傳目前毫秒；advance(ms) 將時間往前推進。
 */
function fakeClock(start = 0) {
  let current = start;
  return {
    /** 取得假時鐘目前時間。@returns {number} 毫秒。 */
    now() { return current; },
    /** 推進假時鐘。@param {number} ms 推進毫秒數。@returns {void} */
    advance(ms) { current += ms; },
  };
}

/**
 * 驗證訊號處理器持續監聽：第一次訊號只觸發優雅關機；去抖動時間窗（預設 1 秒）內的重複訊號只交給 onIgnored；
 * 時間窗之後的訊號改走強制結束，而不是落回預設的直接終止。
 * @returns {void}
 */
function repeatedSignals() {
  const target = new EventEmitter();
  const clock = fakeClock(1000);
  const calls = [];
  /** 記錄第一次訊號。@param {string} signal 訊號。@returns {void} */
  function onFirst(signal) { calls.push(['first', signal]); }
  /** 記錄後續訊號。@param {string} signal 訊號。@returns {void} */
  function onRepeat(signal) { calls.push(['repeat', signal]); }
  /** 記錄被去抖動忽略的訊號。@param {string} signal 訊號。@returns {void} */
  function onIgnored(signal) { calls.push(['ignored', signal]); }
  installSignalHandlers({ target, onFirst, onRepeat, onIgnored, now: clock.now });
  target.emit('SIGTERM', 'SIGTERM');
  clock.advance(1500);
  target.emit('SIGINT', 'SIGINT');
  target.emit('SIGTERM', 'SIGTERM');
  assert.deepEqual(calls, [['first', 'SIGTERM'], ['repeat', 'SIGINT'], ['repeat', 'SIGTERM']]);
  assert.equal(target.listenerCount('SIGTERM'), 1, '仍保留監聽器');
}
test('重複關機訊號改走強制結束且不移除監聽器', repeatedSignals);

/**
 * 驗證 npm start／npm run dev 下一次 Ctrl+C 造成的雙重 SIGINT（數毫秒內抵達）不會強制結束：
 * 第一次訊號後 1 秒內的訊號都被忽略，恰好滿 1 秒後的訊號才強制結束；未提供 onIgnored 也不會拋錯。
 * 修正前任何第二次訊號都會立即呼叫 onRepeat。
 * @returns {void}
 */
function debouncedDuplicateSignal() {
  const target = new EventEmitter();
  const clock = fakeClock();
  const calls = [];
  /** 記錄第一次訊號。@param {string} signal 訊號。@returns {void} */
  function onFirst(signal) { calls.push(['first', signal]); }
  /** 記錄強制結束。@param {string} signal 訊號。@returns {void} */
  function onRepeat(signal) { calls.push(['repeat', signal]); }
  installSignalHandlers({ target, onFirst, onRepeat, now: clock.now });
  target.emit('SIGINT', 'SIGINT');
  clock.advance(3);
  target.emit('SIGINT', 'SIGINT');
  clock.advance(996);
  target.emit('SIGTERM', 'SIGTERM');
  assert.deepEqual(calls, [['first', 'SIGINT']], '時間窗內的重複訊號不強制結束');
  clock.advance(1);
  target.emit('SIGINT', 'SIGINT');
  assert.deepEqual(calls, [['first', 'SIGINT'], ['repeat', 'SIGINT']]);
}
test('時間窗內的重複訊號被去抖動，之後的訊號才強制結束', debouncedDuplicateSignal);

/**
 * 建立記錄呼叫順序的關機依賴替身：server 的 close 回呼由測試決定何時完成，closeAllConnections、closeStorage、exit 與 log 只記錄。
 * @returns {{events: Array, logs: Array, server: object, closeStorage: Function, exit: Function, log: Function, finishClose: Function}} 替身與完成 close 的控制函式。
 */
function shutdownDoubles() {
  const events = [];
  const logs = [];
  let closeCallback;
  const server = {
    /** 記錄 close 並保存回呼，模擬仍有連線未結束。@param {Function} callback 關閉完成通知。@returns {void} */
    close(callback) { events.push('close'); closeCallback = callback; },
    /** 記錄強制關閉所有連線。@returns {void} */
    closeAllConnections() { events.push('closeAllConnections'); },
  };
  /** 記錄關閉資料庫。@returns {void} */
  function closeStorage() { events.push('closeStorage'); }
  /** 記錄結束碼，不真的結束測試程序。@param {number} code 結束碼。@returns {void} */
  function exit(code) { events.push(`exit:${code}`); }
  /** 記錄日誌事件名稱。@param {string} level 等級。@param {string} event 事件。@returns {void} */
  function log(level, event) { logs.push(event); }
  /** 讓 server.close 完成。@returns {void} */
  function finishClose() { closeCallback(); }
  return { events, logs, server, closeStorage, exit, log, finishClose };
}

/**
 * 驗證 index.js 使用的 installShutdown 接線：第一次訊號開始優雅關機（停止新工作、server.close），重複送達的訊號被忽略；
 * 連線結束後關閉資料庫並以 0 結束。
 * @returns {Promise<void>}
 */
async function gracefulSignalWiring() {
  const target = new EventEmitter();
  const clock = fakeClock();
  const tasks = createTaskTracker();
  const doubles = shutdownDoubles();
  installShutdown({ target, now: clock.now, server: doubles.server, tasks, timeoutMs: 1000,
    closeStorage: doubles.closeStorage, exit: doubles.exit, log: doubles.log });
  target.emit('SIGINT', 'SIGINT');
  clock.advance(5);
  target.emit('SIGINT', 'SIGINT');
  assert.equal(tasks.status().stopping, true, '第一次訊號停止接受新工作');
  assert.deepEqual(doubles.events, ['close']);
  assert.deepEqual(doubles.logs, ['server.stopping', 'server.signal.ignored']);
  doubles.finishClose();
  await delay(0);
  assert.deepEqual(doubles.events, ['close', 'closeStorage', 'exit:0']);
  assert.deepEqual(doubles.logs, ['server.stopping', 'server.signal.ignored', 'server.stopped']);
}
test('第一次訊號經 installShutdown 啟動優雅關機並以 0 結束', gracefulSignalWiring);

/**
 * 驗證時間窗之後的第二次訊號由 forceExit 處理：關閉所有連線、關閉資料庫並 exit(1)，不等待仍在進行的優雅關機。
 * @returns {Promise<void>}
 */
async function forcedSignalWiring() {
  const target = new EventEmitter();
  const clock = fakeClock();
  const doubles = shutdownDoubles();
  installShutdown({ target, now: clock.now, server: doubles.server, tasks: createTaskTracker(), timeoutMs: 60000,
    closeStorage: doubles.closeStorage, exit: doubles.exit, log: doubles.log });
  target.emit('SIGTERM', 'SIGTERM');
  clock.advance(2000);
  target.emit('SIGINT', 'SIGINT');
  assert.deepEqual(doubles.events, ['close', 'closeAllConnections', 'closeStorage', 'exit:1']);
  assert.deepEqual(doubles.logs, ['server.stopping', 'server.shutdown.forced']);
  doubles.finishClose();
  await delay(0);
}
test('時間窗之後的第二次訊號強制關閉連線、資料庫並以 1 結束', forcedSignalWiring);

/**
 * 驗證優雅關機逾時時強制關閉所有連線、仍關閉資料庫並以 1 結束。
 * @returns {Promise<void>}
 */
async function shutdownTimeoutWiring() {
  const doubles = shutdownDoubles();
  const { shutdown } = installShutdown({ target: new EventEmitter(), server: doubles.server, tasks: createTaskTracker(), timeoutMs: 20,
    closeStorage: doubles.closeStorage, exit: doubles.exit, log: doubles.log });
  await shutdown('SIGTERM');
  assert.deepEqual(doubles.events, ['close', 'closeAllConnections', 'closeStorage', 'exit:1']);
  assert.deepEqual(doubles.logs, ['server.stopping', 'server.shutdown.failed']);
}
test('優雅關機逾時改為強制關閉並以 1 結束', shutdownTimeoutWiring);

/**
 * 驗證 listenServer 只在真正監聽成功時呼叫 onListening：埠已被占用（EADDRINUSE）時只呼叫 onError。
 * Express 5 的 app.listen(port, callback) 會把 callback 同時掛在 'error' 上，失敗時仍會記錄 server.started。
 * @returns {Promise<void>}
 */
async function listenFailureSkipsStarted() {
  const blocker = net.createServer();
  /** 等待占位 server 監聽。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function blockerListening(resolve, reject) { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); }
  await new Promise(blockerListening);
  const port = blocker.address().port;
  let started = 0;
  let failure;
  /** 記錄監聽成功次數。@returns {void} */
  function onListening() { started += 1; }
  /** 嘗試在已占用的埠監聽並等待錯誤。@param {Function} resolve 收到錯誤。@returns {void} */
  function waitError(resolve) {
    /** 保存監聽錯誤。@param {Error} error 錯誤。@returns {void} */
    function onError(error) { failure = error; resolve(); }
    listenServer(express(), port, { onListening, onError }, '127.0.0.1');
  }
  try {
    await new Promise(waitError);
    await delay(20);
    assert.equal(failure.code, 'EADDRINUSE');
    assert.equal(started, 0, '監聽失敗不呼叫 onListening');
  } finally {
    /** 關閉占位 server。@param {Function} resolve 完成。@returns {void} */
    function closeBlocker(resolve) { blocker.close(resolve); }
    await new Promise(closeBlocker);
  }
  let listened;
  /** 正常監聽時只呼叫 onListening。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function waitListening(resolve, reject) { listened = listenServer(express(), 0, { onListening: resolve, onError: reject }, '127.0.0.1'); }
  await new Promise(waitListening);
  /** 關閉測試 server。@param {Function} resolve 完成。@returns {void} */
  function closeListened(resolve) { listened.close(resolve); }
  await new Promise(closeListened);
}
test('監聽失敗不記錄啟動成功，只走錯誤路徑', listenFailureSkipsStarted);

/**
 * 驗證關機清掃不會銷毀仍有排隊請求的 keep-alive 連線：/hold 在關機前開始（不受工作追蹤，清掃立即開始），
 * 關機中同一連線再送 /next（pipelining，排在 /hold 之後）；/hold 回應 end() 後暫緩寫出（finish 前）的期間持續清掃。
 * Node 內建 closeIdleConnections() 此時會把連線視為閒置而銷毀，兩個回應都收不到；修正後兩個回應完整送達，關機很快完成。
 * @returns {Promise<void>}
 */
async function pipelinedRequestSurvivesSweep() {
  const tasks = createTaskTracker();
  let releaseHold;
  let markHold;
  let markNext;
  /** 保存放行 /hold 的控制。@param {Function} resolve 放行。@returns {void} */
  function holdGate(resolve) { releaseHold = resolve; }
  const gate = new Promise(holdGate);
  /** 保存 /hold 開始處理的通知。@param {Function} resolve 通知。@returns {void} */
  function holdStarted(resolve) { markHold = resolve; }
  const holdSeen = new Promise(holdStarted);
  /** 保存 /next 已解析的通知。@param {Function} resolve 通知。@returns {void} */
  function nextStarted(resolve) { markNext = resolve; }
  const nextSeen = new Promise(nextStarted);
  /** 關機前開始、等待放行的請求。@param {object} req 請求。@param {object} res 回應。@returns {Promise<void>} 放行後回應。 */
  async function hold(req, res) { markHold(); await gate; res.json({ ok: 'hold' }); }
  /** 關機中才送達、排在 /hold 後的請求。@param {object} req 請求。@param {object} res 回應。@returns {void} */
  function next(req, res) { markNext(); res.json({ ok: 'next' }); }
  const application = express();
  application.use(createCloseOnShutdown(tasks));
  application.get('/hold', hold);
  application.get('/next', next);
  let server;
  let serverSocket;
  /** 記錄伺服器端 socket，供暫緩寫出。@param {net.Socket} socket 連線。@returns {void} */
  function captureSocket(socket) { serverSocket = socket; }
  /** 等待監聽成功。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function listening(resolve, reject) { server = listenServer(application, 0, { onListening: resolve, onError: reject }, '127.0.0.1'); }
  await new Promise(listening);
  server.keepAliveTimeout = 60000;
  server.on('connection', captureSocket);
  const socket = net.connect(server.address().port, '127.0.0.1');
  let raw = '';
  /** 累加原始回應。@param {Buffer} chunk 片段。@returns {void} */
  function onData(chunk) { raw += chunk; }
  socket.on('data', onData);
  /** 等待連線結束。@param {Function} resolve 結束。@returns {void} */
  function waitEnd(resolve) { socket.once('close', resolve); }
  const ended = new Promise(waitEnd);
  try {
    socket.write('GET /hold HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await holdSeen;
    const started = Date.now();
    const drained = drainServer(server, tasks, 3000, 5);
    socket.write('GET /next HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await nextSeen;
    // 暫緩伺服器端實際寫出，讓 /hold 回應停在「已 end()、尚未 finish」的狀態，期間清掃計時器會執行多次。
    const held = [];
    const { _write: write, _writev: writev } = serverSocket;
    /** 暫存單筆寫出。@param {Buffer} chunk 資料。@param {string} encoding 編碼。@param {Function} callback 完成通知。@returns {void} */
    function holdWrite(chunk, encoding, callback) {
      /** 放行時以原本的 _write 寫出這筆資料。@returns {void} */
      function flushWrite() { write.call(serverSocket, chunk, encoding, callback); }
      held.push(flushWrite);
    }
    /** 暫存批次寫出。@param {Array} chunks 資料。@param {Function} callback 完成通知。@returns {void} */
    function holdWritev(chunks, callback) {
      /** 放行時以原本的 _writev 寫出這批資料。@returns {void} */
      function flushWritev() { writev.call(serverSocket, chunks, callback); }
      held.push(flushWritev);
    }
    serverSocket._write = holdWrite;
    serverSocket._writev = holdWritev;
    releaseHold();
    await delay(100);
    assert.equal(serverSocket.destroyed, false, '有排隊請求的連線不得被清掃');
    serverSocket._write = write;
    serverSocket._writev = writev;
    for (const flush of held) flush();
    await Promise.all([drained, ended]);
    assert.ok(Date.now() - started < 1000, `關機應遠早於期限完成，實際 ${Date.now() - started} ms`);
    const responses = raw.split('HTTP/1.1 ').filter(Boolean);
    assert.equal(responses.length, 2, '兩個回應都完整送達');
    assert.ok(responses[0].includes('{"ok":"hold"}'));
    assert.match(responses[1], /\r\nconnection: close\r\n/i);
    assert.ok(responses[1].includes('{"ok":"next"}'));
  } finally {
    socket.destroy();
    server.closeAllConnections();
  }
}
test('關機清掃不銷毀仍有排隊請求的 keep-alive 連線', pipelinedRequestSurvivesSweep);

/**
 * 驗證關機開始的瞬間也不銷毀有排隊請求的連線：/a 與 /b 一次以 pipelining 送出，/a 的處理器 end() 回應後立刻開始關機。
 * http.Server.close 會先執行一次內建 closeIdleConnections()，把「回應已 end() 但尚未 finish、且 /b 已排隊」的連線當成閒置銷毀；
 * drainServer 改用 net 層 close 後，兩個回應都必須完整送達。
 * @returns {Promise<void>}
 */
async function drainStartRightAfterEnd() {
  const tasks = createTaskTracker();
  let server;
  let drained;
  /** 回應後立刻開始關機。@param {object} req 請求。@param {object} res 回應。@returns {void} */
  function first(req, res) { res.end('a'); drained = drainServer(server, tasks, 3000, 5); }
  /** 排在 /a 之後的請求。@param {object} req 請求。@param {object} res 回應。@returns {void} */
  function second(req, res) { res.end('b'); }
  const application = express();
  application.use(createCloseOnShutdown(tasks));
  application.get('/a', first);
  application.get('/b', second);
  /** 等待監聽成功。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function listening(resolve, reject) { server = listenServer(application, 0, { onListening: resolve, onError: reject }, '127.0.0.1'); }
  await new Promise(listening);
  server.keepAliveTimeout = 60000;
  const socket = net.connect(server.address().port, '127.0.0.1');
  let raw = '';
  /** 累加原始回應。@param {Buffer} chunk 片段。@returns {void} */
  function onData(chunk) { raw += chunk; }
  socket.on('data', onData);
  /** 等待連線結束。@param {Function} resolve 結束。@returns {void} */
  function waitEnd(resolve) { socket.once('close', resolve); }
  const ended = new Promise(waitEnd);
  try {
    socket.write('GET /a HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nGET /b HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await ended;
    await drained;
    const responses = raw.split('HTTP/1.1 ').filter(Boolean);
    assert.equal(responses.length, 2, '兩個回應都完整送達');
    assert.ok(responses[1].endsWith('b'));
  } finally {
    socket.destroy();
    server.closeAllConnections();
  }
}
test('回應剛結束時開始關機也不銷毀已排隊的請求', drainStartRightAfterEnd);

/**
 * 驗證連線追蹤只清掃真正閒置的連線：已送出部分請求標頭（尚未解析出完整請求）的連線不被銷毀，從未送資料的連線被銷毀。
 * @returns {Promise<void>}
 */
async function sweepSkipsPendingData() {
  /** 立即回應。@param {object} req 請求。@param {object} res 回應。@returns {void} */
  function ok(req, res) { res.end('ok'); }
  const application = express();
  application.get('/', ok);
  let server;
  /** 等待監聽成功。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function listening(resolve, reject) { server = listenServer(application, 0, { onListening: resolve, onError: reject }, '127.0.0.1'); }
  await new Promise(listening);
  const tracker = trackConnections(server);
  const port = server.address().port;
  /**
   * 建立用戶端連線並等待連線成功。
   * @returns {Promise<net.Socket>} 已連線的用戶端。
   */
  function connect() {
    /** 連線並在成功時回傳。@param {Function} resolve 完成。@returns {void} */
    function open(resolve) {
      const client = net.connect(port, '127.0.0.1');
      /** 連線成功後回傳用戶端。@returns {void} */
      function onConnect() { resolve(client); }
      client.once('connect', onConnect);
    }
    return new Promise(open);
  }
  const partial = await connect();
  const silent = await connect();
  try {
    partial.write('GET / HTTP/1.1\r\nHo');
    await delay(50);
    assert.equal(tracker.size(), 2);
    assert.equal(tracker.sweepIdle(), 1, '只銷毀沒有任何資料的連線');
    await delay(20);
    assert.equal(tracker.size(), 1);
    assert.equal(partial.destroyed, false);
  } finally {
    partial.destroy();
    silent.destroy();
    server.closeAllConnections();
    server.close();
  }
}
test('連線清掃略過尚有未解析資料的連線', sweepSkipsPendingData);
