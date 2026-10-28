import { PAGE_URLS } from '../src/pageUrls.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createFakeWindow, fakeAuth, pageIds } from './helpers/fakeDom.js';
import { initAdminMonitoring } from '../src/components/adminMonitoring.js';
import { renderAdminMetrics } from '../src/components/adminMetrics.js';
import { loadAdminMetrics, AdminServiceError, isValidMetrics } from '../src/services/adminService.js';

/** 建立包含動態數值、來源保護摘要與帳號的假快照。@returns {object} 與 API 契約一致的測試資料。 */
function fixture() {
  return {
    observedAt: '2026-10-28T00:00:00Z', pollSeconds: 5,
    runtime: { startedAt: '2026-10-27T23:00:00Z', uptimeSeconds: 3600, environment: 'production', storage: 'memory', maintaining: false, stopping: false, pending: 1 },
    ai: { day: '2026-10-28', resetAt: '2026-10-28T16:00:00Z', used: 4, remaining: 76, dailyLimit: 80, userDailyLimit: 20, active: 1, concurrencyLimit: 2, userConcurrencyLimit: 1, cooldownSeconds: 15 },
    users: [{ username: '<script>fake</script>', userID: 'user-test.user', department: { name: '測試部門' }, used: 4, remaining: 16, dailyLimit: 20, cooldownSeconds: 8, inProgress: true }],
    login: { capacity: 512, ip: { limit: 100, windowSeconds: 900, activeKeys: 1, atLimitKeys: 0, failures: 7 }, account: { limit: 5, windowSeconds: 300, activeKeys: 1, atLimitKeys: 1, failures: 5 } },
    http: [{ scope: 'ticket', by: 'user', limit: 9, windowSeconds: 120, maxKeys: 2048, activeKeys: 1, totalHits: 10, atLimitKeys: 1, overLimitRequests: 1 }],
    monitoring: { pollSeconds: 5, windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  };
}

/** 建立監測頁 DOM 與可控制計時器，避免測試留下真實輪詢。@returns {object} 文件、視窗、元素與待執行計時器。 */
function setup() {
  const doc = createFakeDocument();
  const win = createFakeWindow();
  const nodes = {};
  const ids = ['admin-monitoring', 'metrics-status', 'metrics-refresh', 'metrics-toggle', 'metrics-cards', 'metrics-updated', 'metrics-runtime', 'metrics-policy', 'metrics-monitor-policy', 'metrics-quota-progress', 'metrics-users', 'metrics-http', 'metrics-login', 'metrics-login-capacity'];
  for (const id of ids) {
    const node = doc.createElement(id === 'metrics-quota-progress' ? 'progress' : 'div');
    node.setAttribute('id', id);
    doc.body.append(node);
    nodes[id] = node;
  }
  const timers = new Map();
  let nextID = 0;
  /** 記錄排程，不啟動真正背景計時器。@param {Function} callback 事件。@param {number} delay 毫秒。@returns {number} 排程 id。 */
  win.setTimeout = function setTimer(callback, delay) { nextID += 1; timers.set(nextID, { callback, delay }); return nextID; };
  /** 移除排程。@param {number} id 排程 id。@returns {void} */
  win.clearTimeout = function clearTimer(id) { timers.delete(id); };
  const events = new Map();
  /** 記錄文件可見性事件。@param {string} type 名稱。@param {Function} callback 處理器。@returns {void} */
  doc.addEventListener = function addEvent(type, callback) { events.set(type, callback); };
  /** 移除文件事件。@param {string} type 名稱。@returns {void} */
  doc.removeEventListener = function removeEvent(type) { events.delete(type); };
  const auth = fakeAuth({ username: 'test.admin', userID: 'user-test.admin', role: 'ADMIN', department: { id: 'test', name: '測試部門' } });
  /** 登出時記錄導頁。@returns {void} */
  function leave() { auth.logout(); win.location.replace(PAGE_URLS.login); }
  return { doc, win, nodes, timers, events, auth, leave };
}

/** 驗證畫面以實際設定呈現、動態內容為純文字，且 HTML 擁有全部必要節點。@returns {void} */
function rendering() {
  const { doc, nodes } = setup();
  const ids = pageIds(new URL('../admin/admin.html', import.meta.url));
  for (const id of Object.keys(nodes)) assert.ok(ids.has(id), id);
  renderAdminMetrics(doc, fixture());
  assert.match(nodes['metrics-cards'].textContent, /4 \/ 80/);
  assert.match(nodes['metrics-cards'].textContent, /76 次/);
  assert.match(nodes['metrics-policy'].textContent, /15 秒/);
  assert.match(nodes['metrics-http'].textContent, /9 次／120 秒/);
  assert.equal(nodes['metrics-quota-progress'].max, 80);
  assert.equal(nodes['metrics-quota-progress'].value, 4);
  assert.match(nodes['metrics-users'].textContent, /<script>fake<\/script>/);
  assert.equal(doc.querySelectorAll('script').length, 0);
  assert.match(nodes['metrics-login'].textContent, /100 次／900 秒/);
}
test('監測儀表板呈現實際設定與安全文字', rendering);

/** 驗證自動、手動、暫停、隱藏與恢復的生命週期，沒有重疊計時器。@returns {Promise<void>} 互動完成。 */
async function pollingLifecycle() {
  const setupData = setup();
  const { doc, win, auth, leave, nodes, timers, events } = setupData;
  let requests = 0;
  /** 回傳假快照，記錄取樣次數。@returns {Promise<object>} 快照。 */
  async function load() { requests += 1; return fixture(); }
  const monitoring = initAdminMonitoring(doc, win, { auth, leave, load });
  await monitoring.ready;
  assert.equal(requests, 1);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 5000);
  await nodes['metrics-toggle'].click();
  assert.equal(timers.size, 0);
  await monitoring.refresh();
  assert.equal(requests, 2);
  assert.equal(timers.size, 0, '手動更新不開啟自動模式');
  await nodes['metrics-toggle'].click();
  assert.equal(requests, 3);
  doc.hidden = true;
  await events.get('visibilitychange')();
  assert.equal(timers.size, 0);
  await monitoring.refresh();
  assert.equal(requests, 3);
  doc.hidden = false;
  await events.get('visibilitychange')();
  assert.equal(requests, 4);
  win.events.get('pagehide')();
  assert.equal(timers.size, 0);
  await win.events.get('pageshow')();
  assert.equal(requests, 5);
  monitoring.destroy();
  assert.equal(timers.size, 0);
}
test('每五秒取樣、手動更新、暫停與可見性生命週期', pollingLifecycle);

/** 驗證慢請求不重疊，重置暫停後忽略舊回應，重新取樣才更新畫面。@returns {Promise<void>} 驗證完成。 */
async function cancelStaleRequests() {
  const { doc, win, auth, leave, nodes, timers } = setup();
  let finish;
  let signal;
  let calls = 0;
  /** 保存舊回應的完成控制點。@param {Function} resolve 完成函式。@returns {void} */
  function capture(resolve) { finish = resolve; }
  const pending = new Promise(capture);
  /** 模擬第一個請求很慢且不理會取消。@param {object} session 登入服務。@param {object} options 訊號。@returns {Promise<object>} 快照。 */
  async function load(session, options) { calls += 1; signal = options.signal; return calls === 1 ? pending : fixture(); }
  const monitoring = initAdminMonitoring(doc, win, { auth, leave, load });
  await monitoring.refresh();
  assert.equal(calls, 1);
  assert.equal(timers.size, 0);
  const oldSignal = signal;
  monitoring.suspend();
  assert.equal(oldSignal.aborted, true);
  await monitoring.resume();
  assert.match(nodes['metrics-cards'].textContent, /4 \/ 80/);
  const stale = fixture();
  stale.ai.used = 79;
  finish(stale);
  await monitoring.ready;
  assert.doesNotMatch(nodes['metrics-cards'].textContent, /79 \/ 80/);
  assert.equal(timers.size, 1);
  monitoring.destroy();
}
test('慢請求不重疊且重置後不被舊回應覆蓋', cancelStaleRequests);

/** 驗證錯誤保留舊資料、429 等待及 401 永久停止輪詢。@param {object} context 可控制時間。@returns {Promise<void>} 驗證完成。 */
async function failureRecovery(context) {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const { doc, win, auth, leave, nodes, timers } = setup();
  let calls = 0;
  /** 依序回傳成功、限流與登入失效。@returns {Promise<object>} 快照。@throws {AdminServiceError} 測試錯誤。 */
  async function load() {
    calls += 1;
    if (calls === 1) return fixture();
    if (calls === 2) throw Object.assign(new AdminServiceError('監測頻率過高', 429), { retryAfter: 30 });
    throw new AdminServiceError('登入失效', 401);
  }
  const monitoring = initAdminMonitoring(doc, win, { auth, leave, load });
  await monitoring.ready;
  const rendered = nodes['metrics-cards'].textContent;
  const observed = nodes['metrics-updated'].textContent;
  await monitoring.refresh();
  assert.equal(nodes['metrics-cards'].textContent, rendered);
  assert.equal(nodes['metrics-updated'].textContent, observed);
  assert.match(nodes['metrics-status'].textContent, /不是最新快照/);
  assert.equal([...timers.values()][0].delay, 30000);
  await monitoring.refresh();
  assert.equal(calls, 2);
  monitoring.suspend();
  await monitoring.resume();
  assert.equal(calls, 2, '重置完成也不能略過監測自己的 Retry-After');
  context.mock.timers.tick(30000);
  await monitoring.refresh();
  assert.deepEqual(win.redirects, [PAGE_URLS.login]);
  assert.equal(timers.size, 0);
  await monitoring.refresh();
  assert.equal(calls, 3);
}
test('更新失敗保留舊值、尊重限流等待及登入失效停止', failureRecovery);

/** 驗證監測 service 的 Bearer、停用快取、取消訊號、格式檢查與 Retry-After。@returns {Promise<void>} 合約驗證完成。 */
async function serviceContract() {
  const original = globalThis.fetch;
  const { auth } = setup();
  const controller = new AbortController();
  /** 驗證正確監測請求並回傳資料。@param {string} url 網址。@param {object} options 請求設定。@returns {Promise<Response>} 假回應。 */
  async function success(url, options) {
    assert.ok(url.endsWith('/api/admin/metrics'));
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.ok(options.signal);
    return Response.json(fixture());
  }
  try {
    globalThis.fetch = success;
    assert.equal((await loadAdminMetrics(auth, { signal: controller.signal })).ai.dailyLimit, 80);
    const malformed = fixture();
    malformed.users[0].remaining = -1;
    assert.equal(isValidMetrics(malformed), false);
    /** 模擬錯誤回應資料。@returns {Promise<Response>} 破損快照。 */
    async function invalid() { return Response.json(malformed); }
    globalThis.fetch = invalid;
    await assert.rejects(loadAdminMetrics(auth), /格式異常/);
    /** 模擬含標頭等待時間的限流回應。@returns {Promise<Response>} 429。 */
    async function blocked() { return Response.json({ error: { message: '請稍後再試' } }, { status: 429, headers: { 'Retry-After': '17' } }); }
    globalThis.fetch = blocked;
    await assert.rejects(loadAdminMetrics(auth), { status: 429, retryAfter: 17 });
  } finally { globalThis.fetch = original; }
}
test('監測 service 授權、快取、格式驗證與限流資訊', serviceContract);
