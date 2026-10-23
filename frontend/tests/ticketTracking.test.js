import test from 'node:test';
import assert from 'node:assert/strict';
import { transferTicket, loadCompletedTickets, normalizeStoredTicket, MESSAGES } from '../src/services/ticketService.js';
import { describeHistory, quickRange, taipeiDateString, describeSummary } from '../src/tickets.js';

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

const stored = { ticket_id: 'TK-1', created_at: '2026-10-23T01:00:00.000Z', updated_at: '2026-10-23T02:00:00.000Z', subject: '申請 VPN 帳號', content: '新進同仁需要 VPN 連線權限', status: 'PENDING', route: 'DEPARTMENT',
  department_id: 'dept-it-2', department_name: '資訊管理二部', handler: null, requester: { username: 'hr.user', department_name: '人力資源部' }, judgement: { basis: 'x', confidence_score: 80 }, decision: null,
  history: [{ at: '2026-10-23T01:00:00.000Z', event: 'SUBMITTED', by_username: 'hr.user' },
    { at: '2026-10-23T02:00:00.000Z', event: 'TRANSFERRED', by_username: 'racky.huang', from_department_name: '資訊管理一部', to_department_name: '資訊管理二部', to_handler_name: 'cindy.wang', comment: 'AI 判斷錯誤' }] };

/**
 * 驗證轉單請求合約、回應整理與本機驗證。
 * @returns {Promise<void>}
 */
async function transferContract() {
  const calls = [];
  /** 記錄請求並回應。@param {string} url 網址。@param {RequestInit} options 設定。@returns {Promise<Response>} 回應。 */
  async function fakeFetch(url, options) { calls.push([url, options.method, JSON.parse(options.body)]); return Response.json({ ticket: stored }); }
  globalThis.fetch = fakeFetch;
  const ticket = await transferTicket('TK-1', 'dept-it-2', 'h-it-2-01', ' AI 判斷錯誤 ');
  assert.equal(ticket.department_id, 'dept-it-2');
  assert.equal(ticket.history[1].to_handler_name, 'cindy.wang');
  await transferTicket('TK-1', 'dept-it-2', '', '');
  assert.deepEqual(calls, [
    ['http://localhost:3000/api/tickets/TK-1/transfer', 'POST', { department_id: 'dept-it-2', handler_id: 'h-it-2-01', comment: 'AI 判斷錯誤' }],
    ['http://localhost:3000/api/tickets/TK-1/transfer', 'POST', { department_id: 'dept-it-2', handler_id: null, comment: '' }],
  ]);
  await assert.rejects(transferTicket('TK-1', ''), { code: 'INVALID_PAYLOAD', message: '請選擇要轉到的部門' });
  await assert.rejects(transferTicket('', 'dept-it-2'), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(transferTicket('TK-1', 'dept-it-2', '', 'a'.repeat(201)), { code: 'INVALID_PAYLOAD' });
  assert.equal(calls.length, 2);
  /** 模擬目標部門相同。@returns {Promise<Response>} 400。 */
  async function same() { return Response.json({ error: { code: 'INVALID_PAYLOAD', message: '轉單的目標部門必須不同於目前部門' } }, { status: 400 }); }
  globalThis.fetch = same;
  await assert.rejects(transferTicket('TK-1', 'dept-it-1'), { status: 400, message: `${MESSAGES.invalid}\n轉單的目標部門必須不同於目前部門` });
  /** 模擬無法辨識。@returns {Promise<Response>} 純文字。 */
  async function plain() { return new Response('ok'); }
  globalThis.fetch = plain;
  await assert.rejects(transferTicket('TK-1', 'dept-it-2'), { code: 'INVALID_RESPONSE', message: MESSAGES.transferUnreadable });
}
test('轉單的請求合約與驗證', transferContract);

/**
 * 驗證已完成查詢的參數組合、回應整理與本機驗證。
 * @returns {Promise<void>}
 */
async function completedContract() {
  const urls = [];
  /** 記錄網址並回應。@param {string} url 網址。@param {RequestInit} options 設定。@returns {Promise<Response>} 回應。 */
  async function fakeFetch(url, options) {
    urls.push([url, options.method]);
    return Response.json({ department: { id: 'dept-it-1', name: '資訊管理一部' }, total: 150, limit: 100, tickets: [{ ...stored, status: 'APPROVED' }] });
  }
  globalThis.fetch = fakeFetch;
  const result = await loadCompletedTickets();
  assert.equal(result.total, 150);
  assert.equal(result.limit, 100);
  assert.equal(result.tickets[0].status, 'APPROVED');
  await loadCompletedTickets({ status: 'REJECTED', q: ' VPN ', from: '2026-10-01', to: '2026-10-31', limit: 50 });
  await loadCompletedTickets({ q: '', status: '', from: '', to: '' });
  assert.deepEqual(urls.map(([url]) => url), [
    'http://localhost:3000/api/tickets/completed',
    'http://localhost:3000/api/tickets/completed?status=REJECTED&q=VPN&from=2026-10-01&to=2026-10-31&limit=50',
    'http://localhost:3000/api/tickets/completed',
  ]);
  await assert.rejects(loadCompletedTickets({ from: '2026-10-02', to: '2026-10-01' }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(loadCompletedTickets({ q: 'a'.repeat(101) }), { code: 'INVALID_PAYLOAD' });
  /** 模擬缺少 total。@returns {Promise<Response>} 回應。 */
  async function malformed() { return Response.json({ department: { id: 'd', name: 'n' }, tickets: [] }); }
  globalThis.fetch = malformed;
  await assert.rejects(loadCompletedTickets(), { code: 'INVALID_RESPONSE' });
}
test('已完成查詢的參數與回應整理', completedContract);

/**
 * 驗證歷程文字、常用區間與摘要文字。
 * @returns {void}
 */
function helpers() {
  const ticket = normalizeStoredTicket(stored);
  assert.equal(describeHistory(ticket.history[0]), '送出需求單・hr.user');
  assert.equal(describeHistory(ticket.history[1]), '轉單・racky.huang：資訊管理一部 → 資訊管理二部（cindy.wang），AI 判斷錯誤');
  assert.equal(describeHistory({ event: 'APPROVED', at: 'x', by_username: 'a', comment: '好' }), '簽核・a：好');
  const now = Date.parse('2026-10-23T15:30:00Z');
  assert.equal(taipeiDateString(0, now), '2026-10-23');
  assert.equal(taipeiDateString(0, Date.parse('2026-10-23T16:30:00Z')), '2026-10-24', '台北時間已跨日');
  assert.deepEqual(quickRange('today', now), { from: '2026-10-23', to: '2026-10-23' });
  assert.deepEqual(quickRange('7', now), { from: '2026-10-17', to: '2026-10-23' });
  assert.deepEqual(quickRange('30', now), { from: '2026-09-24', to: '2026-10-23' });
  assert.deepEqual(quickRange('all', now), { from: '', to: '' });
  assert.equal(describeSummary(0, 0, 100), '符合條件 0 筆');
  assert.equal(describeSummary(12, 12, 100), '符合條件 12 筆');
  assert.equal(describeSummary(150, 100, 100), '符合條件 150 筆，顯示最新 100 筆（上限 100 筆）');
}
test('歷程文字、常用區間與摘要', helpers);

import { cancelTicket } from '../src/services/ticketService.js';

/**
 * 驗證取消請求合約、回應整理與錯誤對應。
 * @returns {Promise<void>}
 */
async function cancelContract() {
  const calls = [];
  /** 記錄請求並回應已取消的單。@param {string} url 網址。@param {RequestInit} options 設定。@returns {Promise<Response>} 回應。 */
  async function fakeFetch(url, options) {
    calls.push([url, options.method, JSON.parse(options.body)]);
    return Response.json({ ticket: { ...stored, status: 'CANCELLED', decision: { by_username: 'hr.user', at: '2026-10-23T03:00:00.000Z', comment: '', cancelled_by: 'REQUESTER' } } });
  }
  globalThis.fetch = fakeFetch;
  const ticket = await cancelTicket('TK-1', ' 不需要了 ');
  assert.equal(ticket.status, 'CANCELLED');
  assert.equal(ticket.decision.cancelled_by, 'REQUESTER');
  await cancelTicket('TK-1');
  assert.deepEqual(calls.map(([url, method, body]) => [url, method, body.comment]), [
    ['http://localhost:3000/api/tickets/TK-1/cancel', 'POST', '不需要了'], ['http://localhost:3000/api/tickets/TK-1/cancel', 'POST', '']]);
  await assert.rejects(cancelTicket(''), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(cancelTicket('TK-1', 'a'.repeat(201)), { code: 'INVALID_PAYLOAD' });
  /** 模擬部門未填原因。@returns {Promise<Response>} 400。 */
  async function reason() { return Response.json({ error: { code: 'INVALID_PAYLOAD', message: '替提單人取消時必須填寫原因' } }, { status: 400 }); }
  globalThis.fetch = reason;
  await assert.rejects(cancelTicket('TK-1'), { status: 400, message: `${MESSAGES.invalid}\n替提單人取消時必須填寫原因` });
  /** 模擬已取消過。@returns {Promise<Response>} 409。 */
  async function conflict() { return Response.json({ error: { code: 'TICKET_ALREADY_DECIDED', message: '這張需求單已經取消' } }, { status: 409 }); }
  globalThis.fetch = conflict;
  await assert.rejects(cancelTicket('TK-1'), { status: 409, message: '這張需求單已經取消' });
  /** 模擬無法辨識。@returns {Promise<Response>} 純文字。 */
  async function plain() { return new Response('ok'); }
  globalThis.fetch = plain;
  await assert.rejects(cancelTicket('TK-1'), { code: 'INVALID_RESPONSE', message: MESSAGES.cancelUnreadable });
}
test('取消需求單的請求合約與驗證', cancelContract);
