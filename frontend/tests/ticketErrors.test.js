import test from 'node:test';
import assert from 'node:assert/strict';
import { describeHttpError, loadDepartments, submitTicket, MESSAGES, TicketServiceError } from '../src/services/ticketService.js';

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.sessionStorage;
/** 建立有效登入狀態。@returns {void} */
function setupSession() {
  const session = { user: { username: 'racky.huang', userID: 'user-racky.huang', department: { id: 'dept-it-1', name: '資訊管理一部' } }, token: 'test-token', expiresAt: Date.now() + 60000 };
  globalThis.sessionStorage = {
    /** 讀取工作階段。@returns {string} 序列化登入資料。 */
    getItem() { return JSON.stringify(session); },
  };
}
/** 還原全域。@returns {void} */
function restore() { globalThis.fetch = originalFetch; globalThis.sessionStorage = originalStorage; }
test.beforeEach(setupSession);
test.afterEach(restore);

/**
 * 驗證各 HTTP 狀態碼的提示文字、錯誤代碼與倒數秒數規則。
 * @returns {void}
 */
function statusMapping() {
  const backend = (code, message, retry) => ({ error: { code, message, ...(retry ? { retry_after: retry } : {}) } });
  const cases = [
    [400, backend('INVALID_PAYLOAD', 'subject 必須是 1 到 100 字元的非空白字串'), `${MESSAGES.invalid}\nsubject 必須是 1 到 100 字元的非空白字串`, 0],
    [400, undefined, MESSAGES.invalid, 0],
    [401, backend('UNAUTHORIZED', '登入已失效，請重新登入'), MESSAGES.loginRequired, 0],
    [403, backend('USER_ID_MISMATCH', '身分不符'), '身分不符', 0],
    [403, undefined, MESSAGES.forbidden, 0],
    [404, backend('NOT_FOUND', '找不到此 API'), MESSAGES.notFound, 0],
    [413, backend('PAYLOAD_TOO_LARGE', '請求內容超過大小限制'), MESSAGES.tooLarge, 0],
    [429, backend('RATE_LIMIT_EXCEEDED', '請等待冷卻結束後再送出', 7), '請等待冷卻結束後再送出', 7],
    [429, backend('REQUEST_IN_PROGRESS', '此帳號仍有問題處理中', 2), '此帳號仍有問題處理中', 2],
    [429, backend('RATE_LIMIT_EXCEEDED', ''), MESSAGES.busy, 0],
    [429, undefined, MESSAGES.busy, 0],
    [429, backend('DAILY_QUOTA_EXCEEDED', '此帳號今日額度已用完，台北時間午夜重置', 36000), '此帳號今日額度已用完，台北時間午夜重置', 0],
    [429, backend('GLOBAL_QUOTA_EXCEEDED', '', 36000), MESSAGES.quota, 0],
    [503, backend('SERVICE_BUSY', '目前服務忙碌，請稍後再試', 2), '目前服務忙碌，請稍後再試', 0],
    [503, undefined, MESSAGES.unavailable, 0],
    [500, backend('SERVER_ERROR', '檢索或 AI 服務暫時無法回應'), MESSAGES.serverError, 0],
    [502, '<html>proxy</html>', MESSAGES.serverError, 0],
    [418, undefined, '伺服器回應異常（418）', 0],
  ];
  for (const [status, payload, message, retryAfter] of cases) {
    const described = describeHttpError(status, payload);
    assert.equal(described.message, message, `status ${status}`);
    assert.equal(described.retryAfter, retryAfter, `status ${status} retry`);
  }
  assert.equal(describeHttpError(429, backend('RATE_LIMIT_EXCEEDED', 'x'), '17').retryAfter, 17);
  assert.equal(describeHttpError(429, backend('RATE_LIMIT_EXCEEDED', 'x', 3.2), '17').retryAfter, 4);
  assert.equal(describeHttpError(429, backend('DAILY_QUOTA_EXCEEDED', 'x')).code, 'DAILY_QUOTA_EXCEEDED');
  assert.equal(describeHttpError(401, undefined).code, 'UNAUTHORIZED');
  assert.equal(describeHttpError(500, 'not json').code, 'SERVER_ERROR');
}
test('HTTP 狀態碼對應的提示、代碼與倒數規則', statusMapping);

/**
 * 驗證名單載入的 404、非 JSON、逾時、連線失敗與 401 都轉成固定錯誤。
 * @returns {Promise<void>}
 */
async function listFailures() {
  /** 模擬舊版後端沒有此端點。@returns {Promise<Response>} 404。 */
  async function notFound() { return Response.json({ error: { code: 'NOT_FOUND', message: '找不到此 API' } }, { status: 404 }); }
  globalThis.fetch = notFound;
  await assert.rejects(loadDepartments(), { status: 404, message: MESSAGES.notFound });
  /** 模擬 2xx 但不是 JSON。@returns {Promise<Response>} HTML。 */
  async function html() { return new Response('<html></html>', { status: 200 }); }
  globalThis.fetch = html;
  await assert.rejects(loadDepartments(), { code: 'INVALID_RESPONSE', message: MESSAGES.listInvalid });
  /** 模擬逾時。@returns {Promise<never>} @throws {DOMException} TimeoutError。 */
  async function timeout() { throw new DOMException('Timed out', 'TimeoutError'); }
  globalThis.fetch = timeout;
  await assert.rejects(loadDepartments(), { code: 'TIMEOUT', message: MESSAGES.listTimeout });
  /** 模擬斷線。@returns {Promise<never>} @throws {TypeError} 網路錯誤。 */
  async function offline() { throw new TypeError('Failed to fetch'); }
  globalThis.fetch = offline;
  await assert.rejects(loadDepartments(), { code: 'NETWORK_ERROR', message: MESSAGES.network });
  /** 模擬憑證失效。@returns {Promise<Response>} 401。 */
  async function expired() { return Response.json({ error: { code: 'UNAUTHORIZED', message: '登入已失效，請重新登入' } }, { status: 401 }); }
  globalThis.fetch = expired;
  await assert.rejects(loadDepartments(), { status: 401, code: 'UNAUTHORIZED' });
  /** 模擬 5xx 無 JSON。@returns {Promise<Response>} 502。 */
  async function gateway() { return new Response('bad gateway', { status: 502 }); }
  globalThis.fetch = gateway;
  await assert.rejects(loadDepartments(), { status: 502, message: MESSAGES.serverError });
}
test('名單載入失敗的各種提示', listFailures);

/**
 * 驗證送單的逾時、無法辨識、HTTP 錯誤與等待秒數都保留給畫面判斷，且不自動重送。
 * @returns {Promise<void>}
 */
async function ticketFailures() {
  const input = { subject: '申請 VPN 帳號', content: '新進同仁需要 VPN 連線權限' };
  /** 模擬逾時。@returns {Promise<never>} @throws {DOMException} TimeoutError。 */
  async function timeout() { throw new DOMException('Timed out', 'TimeoutError'); }
  globalThis.fetch = timeout;
  await assert.rejects(submitTicket(input), { code: 'TIMEOUT', message: MESSAGES.ticketTimeout });
  /** 模擬 2xx 但不是 JSON。@returns {Promise<Response>} 純文字。 */
  async function plain() { return new Response('ok', { status: 200 }); }
  globalThis.fetch = plain;
  await assert.rejects(submitTicket(input), { code: 'INVALID_RESPONSE', message: MESSAGES.ticketUnreadable });
  /** 模擬 2xx 但缺少欄位。@returns {Promise<Response>} JSON。 */
  async function partial() { return Response.json({ ticket_id: 'TK-1' }); }
  globalThis.fetch = partial;
  await assert.rejects(submitTicket(input), { code: 'INVALID_RESPONSE', message: MESSAGES.ticketUnreadable });
  let calls = 0;
  /** 模擬冷卻中。@returns {Promise<Response>} 429。 */
  async function limited() {
    calls += 1;
    return Response.json({ error: { code: 'RATE_LIMIT_EXCEEDED', message: '請等待冷卻結束後再送出', retry_after: 6 } }, { status: 429, headers: { 'Retry-After': '6' } });
  }
  globalThis.fetch = limited;
  await assert.rejects(submitTicket(input), { status: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfter: 6, message: '請等待冷卻結束後再送出' });
  assert.equal(calls, 1);
  /** 模擬額度用盡。@returns {Promise<Response>} 429。 */
  async function quota() { return Response.json({ error: { code: 'GLOBAL_QUOTA_EXCEEDED', message: '全站今日額度已用完，台北時間午夜重置', retry_after: 40000 } }, { status: 429 }); }
  globalThis.fetch = quota;
  await assert.rejects(submitTicket(input), { status: 429, code: 'GLOBAL_QUOTA_EXCEEDED', retryAfter: 0 });
  /** 模擬需求單儲存故障。@returns {Promise<Response>} 503。 */
  async function records() { return Response.json({ error: { code: 'TICKET_STORE_UNAVAILABLE', message: '需求單儲存暫時無法使用，請稍後再試' } }, { status: 503 }); }
  globalThis.fetch = records;
  await assert.rejects(submitTicket(input), { status: 503, code: 'TICKET_STORE_UNAVAILABLE', retryAfter: 0, message: '需求單儲存暫時無法使用，請稍後再試' });
  /** 模擬欄位錯誤。@returns {Promise<Response>} 400。 */
  async function invalid() { return Response.json({ error: { code: 'INVALID_PAYLOAD', message: '指定的處理人不存在' } }, { status: 400 }); }
  globalThis.fetch = invalid;
  await assert.rejects(submitTicket({ ...input, handlerId: 'h-missing' }), { status: 400, message: `${MESSAGES.invalid}\n指定的處理人不存在` });
  assert.ok(new TicketServiceError('x') instanceof Error);
}
test('送單失敗的提示、等待秒數與不自動重送', ticketFailures);
