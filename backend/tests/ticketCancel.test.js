import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'helpdesk-cancel-'));
process.env.NODE_ENV = 'test';
process.env.TICKETS_FILE = join(scratch, 'unused.json');
process.env.DEMO_PASSWORD = 'test-only-password';
process.env.GEMINI_API_KEY = '';
process.env.LIMIT_STORE = 'memory';
process.env.LOG_LEVEL = 'silent';
const { env } = await import('../config/env.js');
const { createDepartmentService } = await import('../services/departmentService.js');
const { createAccountService } = await import('../services/accountService.js');
const { createFileTicketStore, TICKET_STATUSES } = await import('../services/ticketStore.js');
const { createTicketHandler, createDepartmentTicketsHandler, createMyTicketsHandler, createCompletedTicketsHandler, createDecisionHandler, createTransferHandler, createCancelHandler } = await import('../controllers/ticketController.js');
const { errorHandler, notFound, HttpError } = await import('../middleware/errorHandler.js');
const { createAuthService } = await import('../services/authService.js');
const { createUsageService } = await import('../services/usageService.js');
const { createMemoryLimitStore } = await import('../services/limitStore.js');

/** 測試結束後清除暫存檔案。@returns {void} */
function cleanup() { rmSync(scratch, { recursive: true, force: true }); }
test.after(cleanup);

const departments = createDepartmentService({ departments: [
  { id: 'dept-it-1', name: '資訊管理一部', duty: 'IT資訊服務台', business: ['IT資訊服務台'] },
  { id: 'dept-hr-1', name: '人力資源部', duty: '人事', business: ['請假'] },
] });
const accounts = createAccountService({ accounts: [
  { username: 'one.it', department_id: 'dept-it-1' }, { username: 'hr.user', department_id: 'dept-hr-1' }, { username: 'hr.other', department_id: 'dept-hr-1' },
], departments });
const auth = createAuthService({ ...env, authSecret: 'test-only-secret-value-that-is-long-enough' }, accounts);

/**
 * 隔離的憑證驗證 middleware。
 * @param {import('express').Request} req 請求。
 * @param {import('express').Response} res 回應。
 * @param {import('express').NextFunction} next 後續。
 * @returns {Promise<void>}
 */
async function testAuthenticate(req, res, next) {
  const header = req.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) throw new HttpError(401, 'UNAUTHORIZED', '請先登入');
  req.user = await auth.verify(header.slice(7));
  next();
}

/**
 * 在本機臨時埠啟動測試 app。
 * @param {object} application Express app。
 * @param {Function} run 測試操作。
 * @returns {Promise<void>}
 */
async function withServer(application, run) {
  const server = application.listen(0, '127.0.0.1');
  /** 等待監聽。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function listening(resolve, reject) { server.once('listening', resolve); server.once('error', reject); }
  await new Promise(listening);
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); server.close(); }
}

/**
 * 以 JSON 呼叫 API 並解析。
 * @param {string} url 網址。
 * @param {object} headers 標頭。
 * @param {object} [body] 本文；有本文時用 POST。
 * @returns {Promise<{status: number, body: object}>} 狀態與 JSON。
 */
async function call(url, headers, body) {
  const response = await fetch(url, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  return { status: response.status, body: await response.json() };
}

/**
 * 取得測試帳號的標頭。
 * @param {string} username 帳號。
 * @returns {Promise<object>} 標頭。
 */
async function headersFor(username) {
  const session = await auth.issue(accounts.find(username));
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
}

/**
 * 驗證取消：提單人可取消待簽核的單、部門成員替提單人取消必須填原因、無關者 403、已取消後不能再簽核／轉單／取消，且紀錄進入已完成。
 * @returns {Promise<void>}
 */
async function cancellations() {
  const store = createFileTicketStore({ file: join(scratch, 'cancel.json') });
  const usage = createUsageService({ store: createMemoryLimitStore() });
  /** 不應被呼叫的判斷器。@returns {Promise<never>} @throws {Error} 意外呼叫。 */
  async function judge() { throw new Error('must not judge'); }
  const application = express();
  application.use(express.json());
  application.post('/tickets', testAuthenticate, createTicketHandler({ departments, accounts, judge, store, usage }));
  application.get('/tickets/mine', testAuthenticate, createMyTicketsHandler(store));
  application.get('/tickets/department', testAuthenticate, createDepartmentTicketsHandler(store));
  application.get('/tickets/completed', testAuthenticate, createCompletedTicketsHandler(store));
  application.post('/tickets/:id/decision', testAuthenticate, createDecisionHandler(store));
  application.post('/tickets/:id/transfer', testAuthenticate, createTransferHandler(store, departments, accounts));
  application.post('/tickets/:id/cancel', testAuthenticate, createCancelHandler(store));
  application.use(notFound);
  application.use(errorHandler);
  /** 執行取消檢查。@param {string} base 位址。@returns {Promise<void>} */
  async function check(base) {
    const requester = await headersFor('hr.user');
    const bystander = await headersFor('hr.other');
    const department = await headersFor('one.it');
    /** 送一張人資同事給一部的單。@param {string} subject 主題。@returns {Promise<string>} 單號。 */
    async function submit(subject) { return (await call(`${base}/tickets`, requester, { subject, content: '新進同仁需要相關設備與權限', handler_id: 'one.it' })).body.ticket_id; }
    const byRequester = await submit('申請螢幕');
    const byDepartment = await submit('申請鍵盤滑鼠');
    const stays = await submit('申請筆電');
    assert.equal((await call(`${base}/tickets/${byRequester}/cancel`, bystander, {})).status, 403, '同部門但不是提單人也不是送達部門不能取消');
    assert.equal((await call(`${base}/tickets/TK-missing/cancel`, requester, {})).status, 404);
    assert.equal((await call(`${base}/tickets/${byRequester}/cancel`, requester, { comment: 5 })).status, 400);
    const own = await call(`${base}/tickets/${byRequester}/cancel`, requester, {});
    assert.equal(own.status, 200, '提單人取消不必填原因');
    assert.equal(own.body.ticket.status, 'CANCELLED');
    assert.equal(own.body.ticket.decision.cancelled_by, 'REQUESTER');
    assert.equal(own.body.ticket.decision.comment, '');
    assert.deepEqual(own.body.ticket.history.map((item) => item.event), ['SUBMITTED', 'CANCELLED']);
    const noReason = await call(`${base}/tickets/${byDepartment}/cancel`, department, { comment: '  ' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error.message, '替提單人取消時必須填寫原因');
    const forRequester = await call(`${base}/tickets/${byDepartment}/cancel`, department, { comment: ' 使用者來電說不需要了 ' });
    assert.equal(forRequester.status, 200);
    assert.equal(forRequester.body.ticket.decision.cancelled_by, 'DEPARTMENT');
    assert.equal(forRequester.body.ticket.decision.by_username, 'one.it');
    assert.equal(forRequester.body.ticket.history.at(-1).comment, '使用者來電說不需要了');
    for (const [path, payload] of [['decision', { action: 'APPROVE' }], ['transfer', { department_id: 'dept-hr-1' }], ['cancel', { comment: 'again' }]]) {
      const blocked = await call(`${base}/tickets/${byRequester}/${path}`, path === 'cancel' ? requester : department, payload);
      assert.equal(blocked.status, 409, path);
      assert.equal(blocked.body.error.code, 'TICKET_ALREADY_DECIDED');
      assert.ok(blocked.body.error.message.includes('取消'), path);
    }
    const pending = (await call(`${base}/tickets/department`, department)).body.tickets.filter((ticket) => ticket.status === 'PENDING');
    assert.deepEqual(pending.map((ticket) => ticket.ticket_id), [stays]);
    const mine = (await call(`${base}/tickets/mine`, requester)).body.tickets;
    assert.deepEqual(mine.map((ticket) => ticket.status), ['PENDING', 'CANCELLED', 'CANCELLED']);
    const completed = (await call(`${base}/tickets/completed?status=CANCELLED`, department)).body;
    assert.equal(completed.total, 2);
    assert.equal((await call(`${base}/tickets/completed?status=CANCELLED`, requester)).body.total, 2, '提單人在已完成也看得到自己被取消的單');
    assert.deepEqual((await call(`${base}/tickets/completed?q=${encodeURIComponent('來電')}`, department)).body.tickets.map((ticket) => ticket.ticket_id), [byDepartment]);
    assert.equal((await call(`${base}/tickets/completed?status=PENDING`, department)).status, 400);
    assert.deepEqual(TICKET_STATUSES, ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);
  }
  await withServer(application, check);
}
test('取消需求單：提單人與部門的權限、原因規則與後續狀態', cancellations);
