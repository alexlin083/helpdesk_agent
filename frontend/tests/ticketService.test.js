import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDepartments, submitTicket, normalizeDepartments, normalizeTicketResponse, MESSAGES } from '../src/services/ticketService.js';

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.sessionStorage;
let session;
/** 建立有效的前端登入狀態，不呼叫後端。@returns {void} */
function setupSession() {
  session = { user: { username: 'racky.huang', userID: 'user-racky.huang', department: { id: 'dept-it-1', name: '資訊管理一部' } }, token: 'test-token', expiresAt: Date.now() + 60000 };
  globalThis.sessionStorage = {
    /** 讀取工作階段。@returns {string} 序列化登入資料。 */
    getItem() { return JSON.stringify(session); },
  };
}
/** 還原 fetch 與儲存體。@returns {void} */
function restore() { globalThis.fetch = originalFetch; globalThis.sessionStorage = originalStorage; }
test.beforeEach(setupSession);
test.afterEach(restore);

const listBody = { departments: [
  { id: 'dept-it-1', name: ' 資訊管理一部 ', type: '資訊', duty: 'IT資訊服務台', business: ['VPN', 3, null, ' 防火牆 '], handlers: [{ id: 'h-1', name: 'racky.huang', title: '多餘欄位' }, { id: 'h-2', name: ' amy.chen ' }] },
  { id: 'dept-hr-1', name: '人力資源部', duty: '人事', business: ['請假'] },
] };

/**
 * 驗證名單請求使用 GET、憑證與 20 秒逾時，並正規化回應欄位的預設值與非文字關鍵字。
 * @returns {Promise<void>}
 */
async function departmentsContract() {
  /** 模擬成功名單並檢查請求。@param {string} url 網址。@param {RequestInit} options 設定。@returns {Promise<Response>} 回應。 */
  async function fakeFetch(url, options) {
    assert.equal(url, 'http://localhost:3000/api/departments');
    assert.equal(options.method, 'GET');
    assert.deepEqual(options.headers, { Accept: 'application/json', Authorization: 'Bearer test-token' });
    assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(listBody);
  }
  globalThis.fetch = fakeFetch;
  const departments = await loadDepartments();
  assert.deepEqual(departments, [
    { id: 'dept-it-1', name: '資訊管理一部', type: '資訊', duty: 'IT資訊服務台', business: ['VPN', '防火牆'],
      handlers: [{ id: 'h-1', name: 'racky.huang' }, { id: 'h-2', name: 'amy.chen' }] },
    { id: 'dept-hr-1', name: '人力資源部', type: '', duty: '人事', business: ['請假'], handlers: [] },
  ]);
}
test('名單請求合約與欄位正規化', departmentsContract);

/**
 * 驗證部門或處理人缺少 id 或 name 時整份名單視為格式不正確，其他缺漏使用預設值。
 * @returns {void}
 */
function departmentsValidation() {
  const invalid = [null, {}, { departments: {} }, { departments: [null] }, { departments: [{ name: '沒有 id' }] },
    { departments: [{ id: 'x', name: ' ' }] }, { departments: [{ id: 'x', name: 'y', handlers: [{ name: '沒有 id' }] }] },
    { departments: [{ id: 'x', name: 'y', handlers: [{ id: 'h', name: '' }] }] }];
  for (const data of invalid) {
    /** 嘗試正規化無效名單。@returns {object[]} 名單。@throws {TicketServiceError} 格式不正確。 */
    function run() { return normalizeDepartments(data); }
    assert.throws(run, { code: 'INVALID_RESPONSE', message: MESSAGES.listInvalid });
  }
  assert.deepEqual(normalizeDepartments({ departments: [] }), []);
  assert.deepEqual(normalizeDepartments({ departments: [{ id: 'x', name: 'y', business: 'not-array', handlers: 'nope', type: 5, duty: null }] }),
    [{ id: 'x', name: 'y', type: '', duty: '', business: [], handlers: [] }]);
}
test('名單缺少 id 或 name 視為格式不正確', departmentsValidation);

/**
 * 驗證送單請求去除首尾空白、handler_id 空值轉為 null、不帶 userID，並以 20 秒逾時送出。
 * @returns {Promise<void>}
 */
async function ticketContract() {
  const bodies = [];
  /** 模擬成功送單並記錄本文。@param {string} url 網址。@param {RequestInit} options 設定。@returns {Promise<Response>} 回應。 */
  async function fakeFetch(url, options) {
    assert.equal(url, 'http://localhost:3000/api/tickets');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { Accept: 'application/json', Authorization: 'Bearer test-token', 'Content-Type': 'application/json' });
    assert.ok(options.signal instanceof AbortSignal);
    bodies.push(JSON.parse(options.body));
    return Response.json({ ticket_id: 'TK-1', route: 'HANDLER', department: '資訊管理一部', handler: { name: 'racky.huang' } });
  }
  globalThis.fetch = fakeFetch;
  const result = await submitTicket({ subject: ' VPN 申請 ', content: ' 需要權限 ', handlerId: 'h-1' });
  assert.deepEqual(result, { ticket_id: 'TK-1', route: 'HANDLER', department: '資訊管理一部', handler: { name: 'racky.huang' } });
  await submitTicket({ subject: 'a', content: 'b', handlerId: '' });
  await submitTicket({ subject: 'a', content: 'b' });
  assert.deepEqual(bodies, [
    { subject: 'VPN 申請', content: '需要權限', handler_id: 'h-1' },
    { subject: 'a', content: 'b', handler_id: null },
    { subject: 'a', content: 'b', handler_id: null },
  ]);
  for (const body of bodies) assert.deepEqual(Object.keys(body), ['subject', 'content', 'handler_id']);
}
test('送單請求合約：去空白、handler_id 空值為 null、不帶 userID', ticketContract);

/**
 * 驗證前端字數驗證會先擋下請求，且以 Unicode code points 計算邊界。
 * @returns {Promise<void>}
 */
async function localValidation() {
  let calls = 0;
  /** 計算實際送出的次數。@returns {Promise<Response>} 回應。 */
  async function fakeFetch() { calls += 1; return Response.json({ ticket_id: 'TK-1', route: 'FALLBACK', department: '資訊管理一部' }); }
  globalThis.fetch = fakeFetch;
  await assert.rejects(submitTicket({ subject: '  ', content: 'x' }), { code: 'INVALID_PAYLOAD', message: '請填寫主題' });
  await assert.rejects(submitTicket({ subject: 'x', content: '' }), { code: 'INVALID_PAYLOAD', message: '請填寫需求內容' });
  await assert.rejects(submitTicket({ subject: '😀'.repeat(101), content: 'x' }), { code: 'INVALID_PAYLOAD', message: '主題最多 100 字，目前 101 字' });
  await assert.rejects(submitTicket({ subject: 'x', content: '😀'.repeat(2001) }), { code: 'INVALID_PAYLOAD', message: '需求內容最多 2000 字，目前 2001 字' });
  assert.equal(calls, 0);
  await submitTicket({ subject: '😀'.repeat(100), content: '😀'.repeat(2000) });
  assert.equal(calls, 1);
}
test('前端字數驗證先於網路請求', localValidation);

/**
 * 驗證 2xx 但內容無法解讀的各種情況，以及 basis 的整理規則與多餘欄位的忽略。
 * @returns {void}
 */
function responseValidation() {
  const invalid = [null, 'text', {}, { ticket_id: '', route: 'FALLBACK', department: 'x' }, { ticket_id: 'TK', route: 'FALLBACK' },
    { ticket_id: 'TK', route: 'OTHER', department: 'x' }, { ticket_id: 'TK', route: 'HANDLER', department: 'x' },
    { ticket_id: 'TK', route: 'HANDLER', department: 'x', handler: { id: 'x' } }];
  for (const data of invalid) {
    /** 嘗試整理無法辨識的回應。@returns {object} 結果。@throws {TicketServiceError} 無法辨識。 */
    function run() { return normalizeTicketResponse(data); }
    assert.throws(run, { code: 'INVALID_RESPONSE', message: MESSAGES.ticketUnreadable });
  }
  assert.deepEqual(normalizeTicketResponse({ ticket_id: ' TK-2 ', route: 'DEPARTMENT', department: ' 資訊管理二部 ', basis: ' 提到 ERP ' }),
    { ticket_id: 'TK-2', route: 'DEPARTMENT', department: '資訊管理二部', basis: '提到 ERP' });
  assert.deepEqual(normalizeTicketResponse({ ticket_id: 'TK-3', route: 'FALLBACK', department: '資訊管理一部', basis: '   ' }),
    { ticket_id: 'TK-3', route: 'FALLBACK', department: '資訊管理一部' });
  assert.deepEqual(normalizeTicketResponse({ ticket_id: 'TK-4', route: 'HANDLER', department: 'd', handler: { name: ' racky.huang ', title: '忽略' }, basis: '忽略' }),
    { ticket_id: 'TK-4', route: 'HANDLER', department: 'd', handler: { name: 'racky.huang' } });
}
test('送單回應的辨識規則與欄位整理', responseValidation);

/**
 * 驗證沒有有效憑證時不呼叫網路並回傳需要登入的錯誤。
 * @returns {Promise<void>}
 */
async function requiresLogin() {
  let calls = 0;
  /** 不應被呼叫。@returns {Promise<Response>} 回應。 */
  async function fakeFetch() { calls += 1; return Response.json({}); }
  globalThis.fetch = fakeFetch;
  session.expiresAt = Date.now() - 1;
  await assert.rejects(loadDepartments(), { status: 401, code: 'LOGIN_REQUIRED' });
  await assert.rejects(submitTicket({ subject: 'a', content: 'b' }), { status: 401, code: 'LOGIN_REQUIRED' });
  assert.equal(calls, 0);
}
test('憑證過期時不送出請求', requiresLogin);

import { loadMyTickets, loadDepartmentTickets, decideTicket, normalizeStoredTicket } from '../src/services/ticketService.js';

/**
 * 驗證查詢與簽核端點的請求合約、回應整理與錯誤對應。
 * @returns {Promise<void>}
 */
async function trackingContract() {
  const stored = { ticket_id: 'TK-1', created_at: '2026-10-23T01:00:00.000Z', subject: ' 申請 VPN 帳號 ', content: '新進同仁需要 VPN 連線權限', status: 'PENDING', route: 'HANDLER',
    department_name: '資訊管理一部', handler: { name: 'racky.huang' }, requester: { username: 'erp.user', department_name: '資訊管理二部' }, judgement: null, decision: null,
    history: [{ at: '2026-10-23T01:00:00.000Z', event: 'SUBMITTED', by_username: 'erp.user' }, { bad: true }] };
  const urls = [];
  /** 記錄請求並回應清單。@param {string} url 網址。@param {RequestInit} options 設定。@returns {Promise<Response>} 回應。 */
  async function listFetch(url, options) {
    urls.push([url, options.method, options.body]);
    if (url.endsWith('/mine')) return Response.json({ tickets: [stored] });
    if (url.endsWith('/department')) return Response.json({ department: { id: 'dept-it-1', name: '資訊管理一部' }, tickets: [{ ...stored, status: 'APPROVED', decision: { by_username: 'amy.chen', at: '2026-10-23T02:00:00.000Z', comment: ' ok ' } }] });
    return Response.json({ ticket: { ...stored, status: 'REJECTED' } });
  }
  globalThis.fetch = listFetch;
  const mine = await loadMyTickets();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].subject, '申請 VPN 帳號');
  assert.deepEqual(mine[0].handler, { name: 'racky.huang' });
  assert.equal(mine[0].history.length, 1, '缺少欄位的歷程會被略過');
  assert.equal(mine[0].updated_at, stored.created_at);
  const department = await loadDepartmentTickets();
  assert.deepEqual(department.department, { id: 'dept-it-1', name: '資訊管理一部' });
  assert.deepEqual(department.tickets[0].decision, { by_username: 'amy.chen', at: '2026-10-23T02:00:00.000Z', comment: 'ok', cancelled_by: '' });
  const decided = await decideTicket('TK-1', 'REJECT', ' 原因 ');
  assert.equal(decided.status, 'REJECTED');
  assert.deepEqual(urls.map(([url, method]) => [url, method]), [
    ['http://localhost:3000/api/tickets/mine', 'GET'], ['http://localhost:3000/api/tickets/department', 'GET'], ['http://localhost:3000/api/tickets/TK-1/decision', 'POST']]);
  assert.deepEqual(JSON.parse(urls[2][2]), { action: 'REJECT', comment: '原因' });
  await assert.rejects(decideTicket('', 'APPROVE'), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(decideTicket('TK-1', 'approve'), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(decideTicket('TK-1', 'APPROVE', 'a'.repeat(201)), { code: 'INVALID_PAYLOAD', message: '備註最多 200 字，目前 201 字' });
  assert.equal(urls.length, 3);
  for (const data of [null, {}, { ...stored, status: 'DONE' }, { ...stored, department_name: '' }, { ...stored, subject: ' ' }]) {
    /** 嘗試整理無效記錄。@returns {object} 結果。@throws {TicketServiceError} 格式不正確。 */
    function run() { return normalizeStoredTicket(data); }
    assert.throws(run, { code: 'INVALID_RESPONSE' });
  }
  /** 模擬已簽核過。@returns {Promise<Response>} 409。 */
  async function conflict() { return Response.json({ error: { code: 'TICKET_ALREADY_DECIDED', message: '這張需求單已經簽核過' } }, { status: 409 }); }
  globalThis.fetch = conflict;
  await assert.rejects(decideTicket('TK-1', 'APPROVE'), { status: 409, code: 'TICKET_ALREADY_DECIDED', message: '這張需求單已經簽核過' });
  /** 模擬不是送達部門。@returns {Promise<Response>} 403。 */
  async function forbidden() { return Response.json({ error: { code: 'FORBIDDEN', message: '只有送達部門的成員可以簽核這張需求單' } }, { status: 403 }); }
  globalThis.fetch = forbidden;
  await assert.rejects(decideTicket('TK-1', 'APPROVE'), { status: 403, message: '只有送達部門的成員可以簽核這張需求單' });
  /** 模擬查無需求單。@returns {Promise<Response>} 404。 */
  async function missing() { return Response.json({ error: { code: 'TICKET_NOT_FOUND', message: '找不到這張需求單' } }, { status: 404 }); }
  globalThis.fetch = missing;
  await assert.rejects(decideTicket('TK-9', 'APPROVE'), { status: 404, message: '找不到這張需求單' });
  /** 模擬清單格式錯誤。@returns {Promise<Response>} 不含 tickets。 */
  async function malformed() { return Response.json({ items: [] }); }
  globalThis.fetch = malformed;
  await assert.rejects(loadMyTickets(), { code: 'INVALID_RESPONSE', message: MESSAGES.listInvalid });
  await assert.rejects(loadDepartmentTickets(), { code: 'INVALID_RESPONSE' });
  /** 模擬簽核回應無法辨識。@returns {Promise<Response>} 純文字。 */
  async function plain() { return new Response('ok', { status: 200 }); }
  globalThis.fetch = plain;
  await assert.rejects(decideTicket('TK-1', 'APPROVE'), { code: 'INVALID_RESPONSE', message: MESSAGES.decisionUnreadable });
}
test('需求單查詢與簽核的合約、整理與錯誤對應', trackingContract);
