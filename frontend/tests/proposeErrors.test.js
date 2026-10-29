import { PAGE_URLS } from '../src/pageUrls.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createFakeWindow, buildProposeDom, fakeAuth } from './helpers/fakeDom.js';
import { initProposePage, PROPOSE_TEXT } from '../src/propose.js';
import { TicketServiceError, MESSAGES } from '../src/services/ticketService.js';

const departments = [{ id: 'dept-it-1', name: '資訊管理一部', type: '', duty: '', business: [], handlers: [{ id: 'h-1', name: 'racky.huang' }] }];

/**
 * 建立已登入的頁面環境。
 * @param {object} [services={}] 服務替身。
 * @returns {object} doc、win、nodes、auth 與頁面控制器。
 */
function mountPage(services = {}) {
  const doc = createFakeDocument();
  const win = createFakeWindow();
  const nodes = buildProposeDom(doc);
  const auth = fakeAuth({ username: 'david.lee', userID: 'user-david.lee', department: { id: 'dept-it-2', name: '資訊管理二部' } });
  globalThis.document = doc;
  /** 預設名單載入成功。@returns {Promise<object[]>} 部門。 */
  async function loadDepartments() { return departments; }
  const page = initProposePage(doc, win, { auth, loadDepartments, ...services });
  return { doc, win, nodes, auth, page };
}
/** 清除全域文件替身。@returns {void} */
function cleanup() { delete globalThis.document; }
test.afterEach(cleanup);

/**
 * 以指定錯誤執行一次送出，回傳頁面環境供斷言。
 * @param {unknown} error 送單時拋出的錯誤。
 * @param {object} [services={}] 其他服務替身。
 * @returns {Promise<object>} 頁面環境。
 */
async function submitWith(error, services = {}) {
  /** 一律失敗的送單。@returns {Promise<never>} @throws {unknown} 指定錯誤。 */
  async function submitTicket() { throw error; }
  const mounted = mountPage({ submitTicket, ...services });
  await mounted.page.ready;
  mounted.nodes.subject.value = '申請 VPN 帳號';
  mounted.nodes.content.value = '新進同仁需要 VPN 連線權限';
  await mounted.nodes.form.dispatch('submit');
  return mounted;
}

/**
 * 驗證名單載入失敗（404、格式不正確、逾時）維持停用、改預設項並在表單上方顯示原因；名單 401 回登入頁。
 * @returns {Promise<void>}
 */
async function listFailures(context) {
  for (const failure of [
    new TicketServiceError(MESSAGES.notFound, { status: 404, code: 'NOT_FOUND' }),
    new TicketServiceError(MESSAGES.listInvalid, { status: 200, code: 'INVALID_RESPONSE' }),
    new TicketServiceError(MESSAGES.listTimeout, { code: 'TIMEOUT' }),
  ]) {
    /** 模擬名單失敗。@returns {Promise<never>} @throws {TicketServiceError} 指定錯誤。 */
    async function loadDepartments() { throw failure; }
    const { nodes, page, win } = mountPage({ loadDepartments });
    await page.ready;
    assert.equal(nodes.handlerSearch.disabled, true);
    assert.equal(nodes.handlerSearch.placeholder, PROPOSE_TEXT.failed);
    assert.equal(nodes.handler.value, '');
    assert.equal(nodes.departmentsButton.disabled, true);
    assert.equal(nodes.notice.hidden, false);
    assert.equal(nodes.notice.textContent, `${PROPOSE_TEXT.notice}原因：${failure.message}`);
    assert.deepEqual(win.redirects, []);
    cleanup();
  }
  const errors = context.mock.method(console, 'error', () => {});
  /** 模擬非預期錯誤。@returns {Promise<never>} @throws {Error} 程式錯誤。 */
  async function broken() { throw new Error('bug'); }
  const unexpected = mountPage({ loadDepartments: broken });
  await unexpected.page.ready;
  assert.equal(unexpected.nodes.notice.textContent, `${PROPOSE_TEXT.notice}原因：${PROPOSE_TEXT.unexpected}`);
  assert.equal(errors.mock.callCount(), 1);
  cleanup();
  /** 模擬憑證失效。@returns {Promise<never>} @throws {TicketServiceError} 401。 */
  async function expired() { throw new TicketServiceError(MESSAGES.loginRequired, { status: 401, code: 'UNAUTHORIZED' }); }
  const { win, auth, page, doc } = mountPage({ loadDepartments: expired });
  await page.ready;
  assert.deepEqual(win.redirects, [PAGE_URLS.login]);
  assert.deepEqual(auth.calls, ['logout']);
  assert.equal(doc.body.hidden, true);
}
test('名單載入失敗的畫面狀態與 401 導回登入', listFailures);

/**
 * 驗證 429 非額度錯誤依後端秒數倒數，倒數中不能送出，結束後恢復送出鈕。
 * @param {import('node:test').TestContext} context 可控制的時間。
 * @returns {Promise<void>}
 */
async function busyCountdown(context) {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  let calls = 0;
  /** 第一次 429、之後成功。@returns {Promise<object>} 結果。@throws {TicketServiceError} 冷卻中。 */
  async function submitTicket() {
    calls += 1;
    if (calls === 1) throw new TicketServiceError('請等待冷卻結束後再送出', { status: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfter: 5 });
    return { ticket_id: 'TK-1', route: 'FALLBACK', department: '資訊管理一部' };
  }
  const { nodes, page } = mountPage({ submitTicket });
  await page.ready;
  nodes.subject.value = '申請 VPN 帳號';
  nodes.content.value = '新進同仁需要 VPN 連線權限';
  await nodes.form.dispatch('submit');
  assert.equal(nodes.submitError.textContent, '請等待冷卻結束後再送出');
  assert.equal(nodes.submit.disabled, true);
  assert.equal(nodes.submit.textContent, '請等 5 秒');
  assert.equal(nodes.subject.readOnly, false);
  context.mock.timers.tick(2000);
  assert.equal(nodes.submit.textContent, '請等 3 秒');
  await nodes.form.dispatch('submit');
  assert.equal(calls, 1, '倒數中不會送出');
  context.mock.timers.tick(3000);
  assert.equal(nodes.submit.disabled, false);
  assert.equal(nodes.submit.textContent, PROPOSE_TEXT.submit);
  assert.equal(page.remainingWait(), 0);
  await nodes.form.dispatch('submit');
  assert.equal(calls, 2);
  assert.equal(nodes.resultDialog.open, true);
  assert.equal(nodes.resultMethod.textContent, '內容未對應到明確部門');
  assert.equal(nodes.resultNote.textContent, '先送「資訊管理一部」，由人工分派部門');
  assert.equal(nodes.resultBasisRow.hidden, true);
}
test('系統繁忙時依後端秒數倒數後恢復', busyCountdown);

/**
 * 驗證額度用盡、超過 300 秒、沒有秒數與 503 都只顯示提示而不倒數。
 * @returns {Promise<void>}
 */
async function noCountdown() {
  const cases = [
    new TicketServiceError('此帳號今日額度已用完，台北時間午夜重置', { status: 429, code: 'DAILY_QUOTA_EXCEEDED', retryAfter: 0 }),
    new TicketServiceError(MESSAGES.quota, { status: 429, code: 'GLOBAL_QUOTA_EXCEEDED', retryAfter: 0 }),
    new TicketServiceError(MESSAGES.busy, { status: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfter: 301 }),
    new TicketServiceError(MESSAGES.busy, { status: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfter: 0 }),
    new TicketServiceError('目前服務忙碌，請稍後再試', { status: 503, code: 'SERVICE_BUSY', retryAfter: 0 }),
  ];
  for (const error of cases) {
    const { nodes } = await submitWith(error);
    assert.equal(nodes.submitError.textContent, error.message);
    assert.equal(nodes.submit.disabled, false);
    assert.equal(nodes.submit.textContent, PROPOSE_TEXT.submit);
    cleanup();
  }
}
test('額度用盡、過長等待與 503 不倒數', noCountdown);

/**
 * 驗證 400、404、413、連線失敗、逾時與無法辨識的回應都顯示在送出區，不開結果視窗，且輸入內容保留。
 * @returns {Promise<void>}
 */
async function displayedErrors() {
  const cases = [
    new TicketServiceError(`${MESSAGES.invalid}\nsubject 必須是 1 到 100 字元的非空白字串`, { status: 400, code: 'INVALID_PAYLOAD' }),
    new TicketServiceError(MESSAGES.notFound, { status: 404, code: 'NOT_FOUND' }),
    new TicketServiceError(MESSAGES.tooLarge, { status: 413, code: 'PAYLOAD_TOO_LARGE' }),
    new TicketServiceError(MESSAGES.network, { code: 'NETWORK_ERROR' }),
    new TicketServiceError(MESSAGES.ticketTimeout, { code: 'TIMEOUT' }),
    new TicketServiceError(MESSAGES.ticketUnreadable, { status: 200, code: 'INVALID_RESPONSE' }),
    new TicketServiceError(MESSAGES.serverError, { status: 500, code: 'SERVER_ERROR' }),
  ];
  for (const error of cases) {
    const { nodes, win } = await submitWith(error);
    assert.equal(nodes.submitError.textContent, error.message);
    assert.equal(nodes.resultDialog.open, false);
    assert.equal(nodes.subject.value, '申請 VPN 帳號');
    assert.equal(nodes.content.value, '新進同仁需要 VPN 連線權限');
    assert.equal(nodes.submit.disabled, false);
    assert.deepEqual(win.redirects, []);
    cleanup();
  }
  const { nodes } = await submitWith(new TicketServiceError(MESSAGES.invalid, { status: 400 }));
  nodes.subject.value = '申請 VPN 帳號（修改）';
  await nodes.subject.dispatch('input');
  assert.equal(nodes.submitError.textContent, '', '輸入時清掉送出區的整體錯誤提示');
}
test('送出失敗只顯示提示並保留輸入內容', displayedErrors);

/**
 * 驗證送單 401 與本機憑證過期都清除登入並回登入頁；非預期錯誤只顯示固定提示並寫入主控台。
 * @param {import('node:test').TestContext} context mock 管理器。
 * @returns {Promise<void>}
 */
async function sessionAndUnexpected(context) {
  const expired = await submitWith(new TicketServiceError(MESSAGES.loginRequired, { status: 401, code: 'UNAUTHORIZED' }));
  assert.deepEqual(expired.win.redirects, [PAGE_URLS.login]);
  assert.deepEqual(expired.auth.calls, ['logout']);
  assert.equal(expired.doc.body.hidden, true);
  cleanup();
  let calls = 0;
  /** 不應被呼叫。@returns {Promise<object>} 結果。 */
  async function submitTicket() { calls += 1; return {}; }
  const local = mountPage({ submitTicket });
  await local.page.ready;
  local.auth.user = null;
  local.nodes.subject.value = '申請 VPN 帳號';
  local.nodes.content.value = '新進同仁需要 VPN 連線權限';
  await local.nodes.form.dispatch('submit');
  assert.equal(calls, 0);
  assert.deepEqual(local.win.redirects, [PAGE_URLS.login]);
  cleanup();
  const errors = context.mock.method(console, 'error', () => {});
  const unexpected = await submitWith(new TypeError('程式錯誤 private-detail'));
  assert.equal(unexpected.nodes.submitError.textContent, PROPOSE_TEXT.unexpected);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(unexpected.nodes.submit.disabled, false);
}
test('憑證失效回登入頁，非預期錯誤只顯示固定提示', sessionAndUnexpected);
