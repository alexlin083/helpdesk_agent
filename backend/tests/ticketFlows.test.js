import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'helpdesk-flows-'));
process.env.NODE_ENV = 'local';
process.env.ADMIN_PASSWORD = 'test-admin-only-password';
process.env.TICKETS_FILE = join(scratch, 'unused.json');
process.env.DEMO_PASSWORD = 'test-only-password';
process.env.GEMINI_API_KEY = '';
process.env.LIMIT_STORE = 'memory';
process.env.LOG_LEVEL = 'silent';
const { env } = await import('../config/env.js');
const { createDepartmentService } = await import('../services/departmentService.js');
const { createAccountService } = await import('../services/accountService.js');
const { createFileTicketStore } = await import('../services/ticketStore.js');
const { createTicketHandler, createDepartmentTicketsHandler, createMyTicketsHandler, createCompletedTicketsHandler, createDecisionHandler, createTransferHandler, parseCompletedQuery, matchesCompleted } = await import('../controllers/ticketController.js');
const { errorHandler, notFound, HttpError } = await import('../middleware/errorHandler.js');
const { createAuthService } = await import('../services/authService.js');
const { createUsageService } = await import('../services/usageService.js');
const { createMemoryLimitStore } = await import('../services/limitStore.js');

/** 測試結束後清除暫存檔案。@returns {void} */
function cleanup() { rmSync(scratch, { recursive: true, force: true }); }
test.after(cleanup);

// 測試用部門與帳號；姓名與內容皆為假資料。
const departments = createDepartmentService({ departments: [
  { id: 'dept-it-1', name: '資訊管理一部', duty: 'IT資訊服務台', business: ['IT資訊服務台'] },
  { id: 'dept-it-2', name: '資訊管理二部', duty: 'ERP', business: ['ERP'] },
  { id: 'dept-hr-1', name: '人力資源部', duty: '人事', business: ['請假'] },
] });
const accounts = createAccountService({ accounts: [
  { username: 'one.it', department_id: 'dept-it-1' }, { username: 'two.it', department_id: 'dept-it-1' }, { username: 'erp.user', department_id: 'dept-it-2' }, { username: 'hr.user', department_id: 'dept-hr-1' },
], departments });
const auth = createAuthService({ ...env, authSecret: 'test-only-secret-value-that-is-long-enough' }, accounts);

/**
 * 隔離的憑證驗證 middleware，使用測試帳號服務。
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
 * 在本機臨時埠啟動測試 app，完成後關閉所有連線。
 * @param {object} application Express app。
 * @param {Function} run 接收本機位址的測試操作。
 * @returns {Promise<void>}
 */
async function withServer(application, run) {
  const server = application.listen(0, '127.0.0.1');
  /** 等待監聽成功。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function listening(resolve, reject) { server.once('listening', resolve); server.once('error', reject); }
  await new Promise(listening);
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); server.close(); }
}

/**
 * 建立含送單、查詢、已完成、簽核與轉單路由的隔離 app。
 * @param {object} store 需求單儲存。
 * @returns {object} Express app。
 */
function flowApp(store) {
  const usage = createUsageService({ store: createMemoryLimitStore() });
  /** 不應被呼叫的判斷器。@returns {Promise<never>} @throws {Error} 意外呼叫。 */
  async function judge() { throw new Error('must not judge'); }
  const application = express();
  application.use(express.json({ limit: '16kb' }));
  application.post('/tickets', testAuthenticate, createTicketHandler({ departments, accounts, judge, store, usage }));
  application.get('/tickets/mine', testAuthenticate, createMyTicketsHandler(store));
  application.get('/tickets/department', testAuthenticate, createDepartmentTicketsHandler(store));
  application.get('/tickets/completed', testAuthenticate, createCompletedTicketsHandler(store));
  application.post('/tickets/:id/decision', testAuthenticate, createDecisionHandler(store));
  application.post('/tickets/:id/transfer', testAuthenticate, createTransferHandler(store, departments, accounts));
  application.use(notFound);
  application.use(errorHandler);
  return application;
}

/**
 * 取得指定測試帳號的 Authorization 標頭。
 * @param {string} username 測試帳號。
 * @returns {Promise<object>} 含 Content-Type 與 Bearer 的標頭。
 */
async function headersFor(username) {
  const session = await auth.issue(accounts.find(username));
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
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
 * 驗證轉單：權限、目標驗證、處理人歸屬、狀態與歷程，以及轉單後只有新部門看得到、可簽核。
 * @returns {Promise<void>}
 */
async function transfers() {
  const store = createFileTicketStore({ file: join(scratch, 'transfer.json') });
  /** 執行轉單檢查。@param {string} base 位址。@returns {Promise<void>} */
  async function check(base) {
    const hr = await headersFor('hr.user');
    const one = await headersFor('one.it');
    const two = await headersFor('two.it');
    const erp = await headersFor('erp.user');
    const submitted = await call(`${base}/tickets`, hr, { subject: 'ERP 權限', content: '財務部需要 ERP 報表檢視權限', handler_id: 'one.it' });
    const id = submitted.body.ticket_id;
    assert.equal((await call(`${base}/tickets/${id}/transfer`, erp, { department_id: 'dept-it-2' })).status, 403, '不是送達部門不能轉');
    for (const [payload, message] of [
      [{}, '轉單的目標部門不存在'], [{ department_id: 'dept-none' }, '轉單的目標部門不存在'], [{ department_id: 'dept-it-1' }, '轉單的目標部門必須不同於目前部門'],
      [{ department_id: 'dept-it-2', handler_id: 7 }, 'handler_id 必須是字串或 null'], [{ department_id: 'dept-it-2', handler_id: 'h-none' }, '指定的處理人不存在'],
      [{ department_id: 'dept-it-2', handler_id: 'one.it' }, '指定的處理人不屬於目標部門'], [{ department_id: 'dept-it-2', comment: 'a'.repeat(201) }, 'comment 最多 200 字元'],
    ]) {
      const bad = await call(`${base}/tickets/${id}/transfer`, one, payload);
      assert.equal(bad.status, 400, message);
      assert.equal(bad.body.error.message, message);
    }
    assert.equal((await call(`${base}/tickets/TK-missing/transfer`, one, { department_id: 'dept-it-2' })).status, 404);
    const moved = await call(`${base}/tickets/${id}/transfer`, one, { department_id: 'dept-it-2', handler_id: 'erp.user', comment: ' AI 判斷錯誤，屬 ERP ' });
    assert.equal(moved.status, 200);
    const ticket = moved.body.ticket;
    assert.equal(ticket.status, 'PENDING');
    assert.equal(ticket.department_id, 'dept-it-2');
    assert.equal(ticket.department_name, '資訊管理二部');
    assert.deepEqual(ticket.handler, { id: 'erp.user', name: 'erp.user' });
    assert.equal(ticket.route, 'HANDLER', '原始分流方式保留');
    const transfer = ticket.history.at(-1);
    assert.equal(transfer.event, 'TRANSFERRED');
    assert.equal(transfer.by_username, 'one.it');
    assert.equal(transfer.from_department_name, '資訊管理一部');
    assert.equal(transfer.to_department_name, '資訊管理二部');
    assert.equal(transfer.to_handler_name, 'erp.user');
    assert.equal(transfer.comment, 'AI 判斷錯誤，屬 ERP');
    assert.deepEqual((await call(`${base}/tickets/department`, two)).body.tickets, [], '原部門不再看到');
    assert.equal((await call(`${base}/tickets/department`, erp)).body.tickets[0].ticket_id, id, '新部門看得到');
    assert.equal((await call(`${base}/tickets/${id}/decision`, one, { action: 'APPROVE' })).status, 403, '原部門不能再簽核');
    const mine = (await call(`${base}/tickets/mine`, hr)).body.tickets[0];
    assert.equal(mine.department_name, '資訊管理二部', '提單人看到新的送達部門');
    const again = await call(`${base}/tickets/${id}/transfer`, erp, { department_id: 'dept-hr-1' });
    assert.equal(again.status, 200);
    assert.equal(again.body.ticket.handler, null, '沒指定處理人時清空處理人');
    assert.equal(again.body.ticket.history.filter((item) => item.event === 'TRANSFERRED').length, 2);
    const approved = await call(`${base}/tickets/${id}/decision`, hr, { action: 'APPROVE', comment: '人資處理' });
    assert.equal(approved.status, 200);
    assert.equal((await call(`${base}/tickets/${id}/transfer`, hr, { department_id: 'dept-it-1' })).status, 409, '已簽核不能轉');
  }
  await withServer(flowApp(store), check);
}
test('轉單：權限、目標驗證、處理人歸屬與轉單後的可見範圍', transfers);

/**
 * 驗證查詢條件解析與比對規則。
 * @returns {void}
 */
function completedQuery() {
  assert.deepEqual(parseCompletedQuery({}), { status: '', keyword: '', from: '', to: '', limit: 100 });
  assert.deepEqual(parseCompletedQuery({ status: 'REJECTED', q: ' vpn ', from: '2026-10-01', to: '2026-10-31', limit: '20' }), { status: 'REJECTED', keyword: 'vpn', from: '2026-10-01', to: '2026-10-31', limit: 20 });
  for (const [query, pattern] of [[{ status: 'PENDING' }, /status/], [{ q: 'a'.repeat(101) }, /q 最多/], [{ from: '2026/10/01' }, /from/], [{ to: '2026-13-40' }, /to/],
    [{ from: '2026-10-02', to: '2026-10-01' }, /from 不可晚於 to/], [{ limit: '0' }, /limit/], [{ limit: '501' }, /limit/], [{ limit: 'x' }, /limit/]]) {
    /** 嘗試無效條件。@returns {object} 條件。@throws {HttpError} 400。 */
    function parse() { return parseCompletedQuery(query); }
    assert.throws(parse, pattern);
  }
  const base = { status: 'APPROVED', ticket_id: 'TK-1', subject: 'VPN 申請', content: '新人', updated_at: '2026-10-22T16:30:00.000Z',
    requester: { username: 'erp.user' }, decision: { at: '2026-10-22T16:30:00.000Z', by_username: 'one.it', comment: '已安排' }, handler: { name: 'one.it' } };
  const none = parseCompletedQuery({});
  assert.equal(matchesCompleted(base, none), true);
  assert.equal(matchesCompleted({ ...base, status: 'PENDING' }, none), false);
  assert.equal(matchesCompleted(base, parseCompletedQuery({ status: 'REJECTED' })), false);
  assert.equal(matchesCompleted(base, parseCompletedQuery({ q: 'vpn' })), true, '關鍵字不分大小寫');
  assert.equal(matchesCompleted(base, parseCompletedQuery({ q: 'one.it' })), true, '比對簽核人');
  assert.equal(matchesCompleted(base, parseCompletedQuery({ q: 'one.it' })), true, '比對處理人');
  assert.equal(matchesCompleted(base, parseCompletedQuery({ q: '不存在' })), false);
  assert.equal(matchesCompleted(base, parseCompletedQuery({ from: '2026-10-23', to: '2026-10-23' })), true, '16:30Z 是台北 10/23');
  assert.equal(matchesCompleted(base, parseCompletedQuery({ to: '2026-10-22' })), false);
  assert.equal(matchesCompleted(base, parseCompletedQuery({ from: '2026-10-24' })), false);
}
test('已完成查詢的條件解析與比對', completedQuery);

/**
 * 驗證已完成清單：含本部門已簽核／退回的單與自己提出且已結案的單、依簽核時間由新到舊、total 與 limit、各種篩選與 400。
 * @returns {Promise<void>}
 */
async function completedList() {
  const store = createFileTicketStore({ file: join(scratch, 'completed.json') });
  /** 執行已完成清單檢查。@param {string} base 位址。@returns {Promise<void>} */
  async function check(base) {
    const hr = await headersFor('hr.user');
    const one = await headersFor('one.it');
    const erp = await headersFor('erp.user');
    const ids = [];
    for (let index = 0; index < 5; index += 1) {
      const created = await call(`${base}/tickets`, hr, { subject: `會議室投影機報修 ${index + 1}`, content: index % 2 ? '投影機無法開機，請協助處理' : '投影機畫面閃爍，請安排檢查', handler_id: 'one.it' });
      ids.push(created.body.ticket_id);
    }
    const pendingOnly = await call(`${base}/tickets/completed`, one);
    assert.equal(pendingOnly.status, 200);
    assert.deepEqual(pendingOnly.body, { department: { id: 'dept-it-1', name: '資訊管理一部' }, total: 0, limit: 100, tickets: [] });
    for (const [index, id] of ids.entries()) {
      if (index === 4) continue;
      await call(`${base}/tickets/${id}/decision`, one, { action: index % 2 ? 'REJECT' : 'APPROVE', comment: index === 0 ? '第一張' : '' });
    }
    const all = (await call(`${base}/tickets/completed`, one)).body;
    assert.equal(all.total, 4);
    assert.deepEqual(all.tickets.map((ticket) => ticket.subject), ['會議室投影機報修 4', '會議室投影機報修 3', '會議室投影機報修 2', '會議室投影機報修 1'], '最新簽核在前');
    assert.deepEqual(all.tickets.map((ticket) => ticket.status), ['REJECTED', 'APPROVED', 'REJECTED', 'APPROVED']);
    const rejected = (await call(`${base}/tickets/completed?status=REJECTED`, one)).body;
    assert.deepEqual(rejected.tickets.map((ticket) => ticket.subject), ['會議室投影機報修 4', '會議室投影機報修 2']);
    const keyword = (await call(`${base}/tickets/completed?q=${encodeURIComponent('第一張')}`, one)).body;
    assert.deepEqual(keyword.tickets.map((ticket) => ticket.subject), ['會議室投影機報修 1'], '關鍵字比對簽核備註');
    const limited = (await call(`${base}/tickets/completed?limit=2`, one)).body;
    assert.equal(limited.total, 4);
    assert.equal(limited.limit, 2);
    assert.equal(limited.tickets.length, 2);
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    assert.equal((await call(`${base}/tickets/completed?from=${today}&to=${today}`, one)).body.total, 4);
    assert.equal((await call(`${base}/tickets/completed?to=2000-01-01`, one)).body.total, 0);
    assert.deepEqual((await call(`${base}/tickets/completed`, erp)).body.tickets, [], '其他部門、非提單人看不到');
    assert.equal((await call(`${base}/tickets/completed`, hr)).body.total, 4, '提單人看得到自己已結案的單');
    assert.equal((await call(`${base}/tickets/completed?status=REJECTED`, hr)).body.total, 2);
    assert.equal((await call(`${base}/tickets/completed?status=PENDING`, one)).status, 400);
    assert.equal((await call(`${base}/tickets/completed?limit=999`, one)).status, 400);
    assert.equal((await fetch(`${base}/tickets/completed`)).status, 401);
    const pending = (await call(`${base}/tickets/department`, one)).body.tickets;
    assert.equal(pending.filter((ticket) => ticket.status === 'PENDING').length, 1);
  }
  await withServer(flowApp(store), check);
}
test('已完成清單：排序、筆數上限、篩選與可見範圍', completedList);
