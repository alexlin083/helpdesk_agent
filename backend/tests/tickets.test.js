import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'helpdesk-tickets-'));
process.env.NODE_ENV = 'local';
process.env.ADMIN_PASSWORD = 'test-admin-only-password';
process.env.DEMO_PASSWORD = 'test-only-password';
process.env.GEMINI_API_KEY = '';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.LIMIT_STORE = 'memory';
process.env.LOG_LEVEL = 'silent';
process.env.TICKETS_FILE = join(scratch, 'app-tickets.json');
const { app } = await import('../server.js');
const { env } = await import('../config/env.js');
const { createDepartmentService, normalizeDepartments, departmentService } = await import('../services/departmentService.js');
const { createAccountService, normalizeAccounts, accountService } = await import('../services/accountService.js');
const { buildTicketDecision, createTicketJudge, ticketJudgeSchema } = await import('../services/ticketJudge.js');
const { createFileTicketStore, TICKET_STATUSES } = await import('../services/ticketStore.js');
const { createTicketHandler, createDepartmentsHandler, createMyTicketsHandler, createDepartmentTicketsHandler, createDecisionHandler } = await import('../controllers/ticketController.js');
const { errorHandler, notFound, HttpError } = await import('../middleware/errorHandler.js');
const { authenticate } = await import('../middleware/authenticate.js');
const { authService, createAuthService } = await import('../services/authService.js');
const { createUsageService } = await import('../services/usageService.js');
const { createMemoryLimitStore } = await import('../services/limitStore.js');
const { createLogger } = await import('../utils/logger.js');

/** 測試結束後清除暫存檔案。@returns {void} */
function cleanup() { rmSync(scratch, { recursive: true, force: true }); }
test.after(cleanup);

// 測試用部門與帳號設定；姓名與內容皆為假資料，與實際環境無關。
const sample = [
  { id: 'dept-it-1', name: '資訊管理一部', type: '資訊', duty: '網路、VPN，並擔任 IT資訊服務台', business: ['VPN', 'IT資訊服務台'] },
  { id: 'dept-it-2', name: '資訊管理二部', duty: 'ERP 相關業務', business: ['ERP'] },
];
const departments = createDepartmentService({ departments: sample });
const accounts = createAccountService({ accounts: [
  { username: 'one.it', department_id: 'dept-it-1' }, { username: 'two.it', department_id: 'dept-it-1' }, { username: 'erp.user', department_id: 'dept-it-2' },
], departments });
const auth = createAuthService({ ...env, authSecret: 'test-only-secret-value-that-is-long-enough' }, accounts);

/**
 * 以隔離的 app 建立隔離的憑證驗證 middleware（使用測試帳號服務）。
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
 * 在本機臨時埠啟動測試 app，完成後關閉所有連線；不呼叫真實 Gemini 與 AWS。
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
 * 建立只含需求單相關路由的隔離 app，可注入判斷器、儲存與配額服務。
 * @param {object} options createTicketHandler 的依賴（departments、judge、store、usage）。
 * @returns {object} Express app。
 */
function ticketApp(options) {
  const application = express();
  application.use(express.json({ limit: '16kb' }));
  application.post('/tickets', testAuthenticate, createTicketHandler({ ...options, accounts }));
  application.get('/tickets/mine', testAuthenticate, createMyTicketsHandler(options.store));
  application.get('/tickets/department', testAuthenticate, createDepartmentTicketsHandler(options.store));
  application.post('/tickets/:id/decision', testAuthenticate, createDecisionHandler(options.store));
  application.get('/departments', testAuthenticate, createDepartmentsHandler(options.departments, accounts));
  application.use(notFound);
  application.use(errorHandler);
  return application;
}

/**
 * 建立使用暫存檔的需求單儲存。
 * @param {string} name 檔名。
 * @returns {object} 儲存與檔案路徑。
 */
function tempStore(name) {
  const file = join(scratch, name);
  return { store: createFileTicketStore({ file }), file };
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
 * 驗證部門設定檔的正規化、預設值與各種啟動失敗條件；錯誤訊息只含位置與原因。
 * @returns {void}
 */
function departmentConfig() {
  const list = departments.list();
  assert.deepEqual(Object.keys(list[0]), ['id', 'name', 'type', 'duty', 'business']);
  assert.equal(list[1].type, '');
  assert.deepEqual(Object.keys(departments.forJudge()[0]), ['id', 'name', 'duty', 'business']);
  assert.equal(departments.defaultDepartment().id, 'dept-it-1');
  assert.equal(departments.findDepartment('dept-it-2').name, '資訊管理二部');
  assert.equal(departments.findDepartment(null), null);
  list[0].business.push('injected');
  assert.equal(departments.list()[0].business.length, 2);
  const invalid = [
    [{}, /部門陣列/],
    [[{ ...sample[0], id: ' ' }], /departments\[0\]\.id/],
    [[{ ...sample[0], duty: undefined }], /departments\[0\]\.duty/],
    [[{ ...sample[0], business: [] }], /business/],
    [[{ ...sample[0], business: ['VPN', 3, 'IT資訊服務台'] }], /business\[1\]/],
    [[{ ...sample[0], type: 1 }], /type/],
    [[{ ...sample[0], handlers: [{ id: 'x', name: 'y' }] }], /handlers 已改由帳號設定檔/],
    [[sample[0], { ...sample[1], id: 'dept-it-1' }], /id 重複/],
    [[sample[1]], /預設部門/],
    [[sample[0], { ...sample[1], business: ['IT資訊服務台'] }], /預設部門/],
  ];
  for (const [config, pattern] of invalid) {
    /** 嘗試載入無效設定。@returns {object[]} 正規化結果。@throws {Error} 設定無效。 */
    function load() { return normalizeDepartments(config); }
    assert.throws(load, pattern);
  }
  assert.ok(departmentService.list().length >= 1);
  assert.equal(departmentService.defaultDepartment().business.includes('IT資訊服務台'), true);
}
test('部門設定檔的正規化、查詢與啟動驗證', departmentConfig);

/**
 * 驗證帳號設定檔：格式、唯一性、部門必須存在，以及真實設定檔的十組帳號都對應到部門。
 * @returns {void}
 */
function accountConfig() {
  assert.deepEqual(accounts.usernames, ['one.it', 'two.it', 'erp.user']);
  assert.deepEqual(accounts.find('erp.user'), { username: 'erp.user', userID: 'user-erp.user', role: 'USER', department: { id: 'dept-it-2', name: '資訊管理二部' } });
  assert.equal(accounts.find('One.it'), null);
  assert.equal(accounts.find(null), null);
  assert.deepEqual(accounts.handlersOf('dept-it-1'), [{ id: 'one.it', name: 'one.it' }, { id: 'two.it', name: 'two.it' }]);
  assert.deepEqual(accounts.handlersOf('dept-none'), []);
  assert.equal(accounts.findHandler('erp.user').department.name, '資訊管理二部');
  assert.deepEqual(accounts.findHandler('erp.user').handler, { id: 'erp.user', name: 'erp.user' });
  assert.equal(accounts.findHandler('missing'), null);
  assert.equal(accounts.findHandler(null), null);
  const invalid = [
    [[], /非空/], [{}, /非空/], [[null], /accounts\[0\] 必須是物件/],
    [[{ username: 'Racky.Huang', department_id: 'dept-it-1' }], /username/],
    [[{ username: 'racky', department_id: 'dept-it-1' }], /username/],
    [[{ username: 'a.b', department_id: 'dept-it-1' }, { username: 'a.b', department_id: 'dept-it-2' }], /重複/],
    [[{ username: 'a.b', department_id: 'dept-missing' }], /department_id/],
    [[{ username: 'a.b' }], /department_id/],
  ];
  for (const [config, pattern] of invalid) {
    /** 嘗試載入無效帳號設定。@returns {object[]} 結果。@throws {Error} 設定無效。 */
    function load() { return normalizeAccounts(config, departments); }
    assert.throws(load, pattern);
  }
  const real = accountService.list();
  assert.equal(real.length, 11);
  for (const account of real) assert.ok(departmentService.findDepartment(account.department.id), account.username);
  assert.equal(real[0].username, 'racky.huang');
  for (const department of departmentService.list()) assert.ok(accountService.handlersOf(department.id).length >= 1, `${department.name} 至少要有一個帳號可指定`);
}
test('帳號設定檔的驗證與十組帳號的部門對應', accountConfig);

/**
 * 驗證 75 分分流、未知或 null 部門走預設部門、basis 截斷，以及輸出格式驗證。
 * @returns {void}
 */
function judgeDecision() {
  const high = buildTicketDecision({ department_id: 'dept-it-2', confidence_score: 75, basis: '  ERP 報表  ' }, departments);
  assert.equal(high.route, 'DEPARTMENT');
  assert.equal(high.department.name, '資訊管理二部');
  assert.equal(high.basis, 'ERP 報表');
  assert.equal(buildTicketDecision({ department_id: 'dept-it-2', confidence_score: 80, basis: '提到 ERP 報表權限。。 ' }, departments).basis, '提到 ERP 報表權限', '去掉句尾句號');
  const low = buildTicketDecision({ department_id: 'dept-it-2', confidence_score: 74, basis: '' }, departments);
  assert.equal(low.route, 'FALLBACK');
  assert.equal(low.department.id, 'dept-it-1');
  assert.equal(low.aiDepartment.id, 'dept-it-2');
  for (const id of [null, 'dept-unknown']) {
    const result = buildTicketDecision({ department_id: id, confidence_score: 100, basis: 'x' }, departments);
    assert.equal(result.route, 'FALLBACK');
    assert.equal(result.aiDepartment, null);
  }
  const long = buildTicketDecision({ department_id: 'dept-it-2', confidence_score: 90, basis: '😀'.repeat(250) }, departments);
  assert.equal(Array.from(long.basis).length, 200);
  for (const output of [null, {}, { department_id: 'dept-it-2', confidence_score: 101, basis: '' }, { department_id: 'dept-it-2', confidence_score: 74.5, basis: '' },
    { department_id: 5, confidence_score: 80, basis: '' }, { department_id: 'dept-it-2', confidence_score: 80 }, { department_id: 'dept-it-2', confidence_score: 80, basis: null }]) {
    /** 嘗試驗證無效輸出。@returns {object} 分流。@throws {HttpError} 格式異常。 */
    function build() { return buildTicketDecision(output, departments); }
    assert.throws(build, (error) => error.status === 500 && error.code === 'SERVER_ERROR');
  }
  assert.equal(ticketJudgeSchema.properties.department_id.nullable, true);
}
test('需求單判斷的 75 分分流、預設部門與輸出驗證', judgeDecision);

/**
 * 驗證判斷器只呼叫一次 Gemini、不送處理人、設定正確，並將上游錯誤轉成安全的 429／500。
 * @returns {Promise<void>}
 */
async function judgePipeline() {
  const requests = [];
  /** 模擬一次成功的結構化輸出。@param {object} request SDK 請求。@returns {Promise<object>} 回應。 */
  async function generateContent(request) {
    requests.push(request);
    return { text: JSON.stringify({ department_id: 'dept-it-2', confidence_score: 88, basis: '需求提到 ERP' }) };
  }
  const judge = createTicketJudge({ getAI: () => ({ models: { generateContent } }), departments, model: 'test-model' });
  const decision = await judge({ subject: 'ERP 報表權限', content: '需要新增報表檢視權限' });
  assert.equal(decision.route, 'DEPARTMENT');
  assert.equal(decision.model, 'test-model');
  assert.equal(requests.length, 1);
  const input = JSON.parse(requests[0].contents);
  assert.deepEqual(input.ticket, { subject: 'ERP 報表權限', content: '需要新增報表檢視權限' });
  assert.deepEqual(Object.keys(input.departments[0]), ['id', 'name', 'duty', 'business']);
  assert.ok(!requests[0].contents.includes('one.it'));
  assert.equal(requests[0].config.responseMimeType, 'application/json');
  assert.equal(requests[0].config.maxOutputTokens, 1024);
  assert.equal(requests[0].config.httpOptions.timeout, 15000);
  for (const text of ['', 'not json', '{}']) {
    const broken = createTicketJudge({ getAI: () => ({ models: { generateContent: async () => ({ text }) } }), departments });
    await assert.rejects(broken({ subject: 'a', content: 'b' }), { status: 500, code: 'SERVER_ERROR', message: 'AI 回應格式異常，請稍後再試' });
  }
  for (const [status, expected] of [[429, 429], [503, 500], [404, 500]]) {
    /** 模擬上游失敗。@returns {Promise<never>} @throws {object} 含狀態碼的錯誤。 */
    async function failing() { throw { status, message: 'secret-upstream-details' }; }
    const upstream = createTicketJudge({ getAI: () => ({ models: { generateContent: failing } }), departments });
    await assert.rejects(upstream({ subject: 'a', content: 'b' }), (error) => error.status === expected && !error.message.includes('secret'));
  }
  const missingKey = createTicketJudge({ departments });
  await assert.rejects(missingKey({ subject: 'a', content: 'b' }), { status: 500, message: '尚未設定 Gemini API 金鑰' });
  /** 模擬永不回應的上游。@returns {Promise<never>} 永遠擱置。 */
  function never() { return new Promise(() => {}); }
  const slow = createTicketJudge({ getAI: () => ({ models: { generateContent: never } }), departments, timeoutMs: 20 });
  await assert.rejects(slow({ subject: 'a', content: 'b' }), { status: 500, code: 'SERVER_ERROR' });
}
test('判斷器只呼叫一次 Gemini、不送處理人並安全轉換上游錯誤', judgePipeline);

/**
 * 驗證 JSON 檔需求單儲存：自動建檔、新增、查詢、更新、序列化寫入、損毀與寫入失敗的處理。
 * @returns {Promise<void>}
 */
async function ticketStoreBehaviour() {
  const { store, file } = tempStore('store.json');
  assert.deepEqual(await store.all(), []);
  await Promise.all([store.insert({ ticket_id: 'TK-1', status: 'PENDING' }), store.insert({ ticket_id: 'TK-2', status: 'PENDING' })]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).map((ticket) => ticket.ticket_id), ['TK-1', 'TK-2']);
  assert.equal((await store.find('TK-2')).status, 'PENDING');
  assert.equal(await store.find('TK-9'), null);
  const updated = await store.update('TK-1', (ticket) => ({ ...ticket, status: 'APPROVED' }));
  assert.equal(updated.status, 'APPROVED');
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].status, 'APPROVED');
  const copy = await store.all();
  copy[0].status = 'tampered';
  assert.equal((await store.find('TK-1')).status, 'APPROVED');
  await assert.rejects(store.update('TK-9', (ticket) => ticket), { status: 404, code: 'TICKET_NOT_FOUND' });
  /** 以 HttpError 拒絕更新。@returns {never} @throws {HttpError} 409。 */
  function refuse() { throw new HttpError(409, 'TICKET_ALREADY_DECIDED', 'x'); }
  await assert.rejects(store.update('TK-1', refuse), { status: 409 });
  await assert.rejects(store.insert({ ticket_id: 'TK-1' }), { status: 503, code: 'TICKET_STORE_UNAVAILABLE' });
  mkdirSync(`${file}.tmp`);
  await assert.rejects(store.insert({ ticket_id: 'TK-4' }), { status: 503, code: 'TICKET_STORE_UNAVAILABLE' });
  rmSync(`${file}.tmp`, { recursive: true, force: true });
  assert.equal((await store.all()).length, 2, '寫檔失敗的需求單不留在記憶體，重送不會重複');
  const reopened = createFileTicketStore({ file });
  assert.equal((await reopened.all()).length, 2);
  const corrupt = join(scratch, 'corrupt.json');
  writeFileSync(corrupt, '{"not":"array"}');
  await assert.rejects(createFileTicketStore({ file: corrupt }).all(), { status: 503, code: 'TICKET_STORE_UNAVAILABLE' });
  const unwritable = createFileTicketStore({ file: join(scratch, 'store.json', 'child.json') });
  await assert.rejects(unwritable.insert({ ticket_id: 'TK-3' }), { status: 503, code: 'TICKET_STORE_UNAVAILABLE' });
  assert.deepEqual(TICKET_STATUSES, ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);
}
test('JSON 檔需求單儲存的新增、更新與失敗處理', ticketStoreBehaviour);

/**
 * 驗證指定處理人路徑：直接保存為待簽核、不扣額、不呼叫 Gemini；以及欄位驗證與處理人不存在的 400。
 * @returns {Promise<void>}
 */
async function handlerPath() {
  const usage = createUsageService({ store: createMemoryLimitStore() });
  const { store } = tempStore('handler.json');
  /** 不應被呼叫的判斷器。@returns {Promise<never>} @throws {Error} 意外呼叫。 */
  async function judge() { throw new Error('must not judge'); }
  /** 執行處理人路徑檢查。@param {string} base 位址。@returns {Promise<void>} */
  async function check(base) {
    const headers = await headersFor('erp.user');
    const ok = await fetch(`${base}/tickets`, { method: 'POST', headers, body: JSON.stringify({ subject: ' VPN 申請 ', content: '新進同仁需要 VPN', handler_id: 'two.it', extra: 'ignored' }) });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(Object.keys(body), ['ticket_id', 'route', 'department', 'handler', 'status']);
    assert.match(body.ticket_id, /^TK-[0-9a-f-]{36}$/);
    assert.equal(body.route, 'HANDLER');
    assert.equal(body.department, '資訊管理一部');
    assert.deepEqual(body.handler, { name: 'two.it' });
    assert.equal(body.status, 'PENDING');
    assert.equal(ok.headers.get('X-User-Remaining'), null);
    assert.equal((await usage.usage('user-erp.user')).userRemaining, env.userDailyLimit);
    const stored = await store.find(body.ticket_id);
    assert.deepEqual(Object.keys(stored), ['ticket_id', 'created_at', 'updated_at', 'requester', 'subject', 'content', 'status', 'decision', 'history', 'route', 'department_id', 'department_name', 'handler', 'judgement']);
    assert.deepEqual(stored.requester, { user_id: 'user-erp.user', username: 'erp.user', department_id: 'dept-it-2', department_name: '資訊管理二部' });
    assert.equal(stored.subject, 'VPN 申請');
    assert.equal(stored.department_id, 'dept-it-1');
    assert.deepEqual(stored.handler, { id: 'two.it', name: 'two.it' });
    assert.equal(stored.judgement, null);
    assert.equal(stored.history[0].event, 'SUBMITTED');
    const invalid = [
      [{ content: 'x' }, 'subject 必須是 1 到 100 字元的非空白字串'],
      [{ subject: '   ', content: 'x' }, 'subject 必須是 1 到 100 字元的非空白字串'],
      [{ subject: '😀'.repeat(101), content: 'x' }, 'subject 必須是 1 到 100 字元的非空白字串'],
      [{ subject: 'x', content: 5 }, 'content 必須是 1 到 2000 字元的非空白字串'],
      [{ subject: 'x', content: 'a'.repeat(2001) }, 'content 必須是 1 到 2000 字元的非空白字串'],
      [{ subject: 'x', content: 'y', handler_id: 7 }, 'handler_id 必須是字串或 null'],
      [{ subject: 'x', content: 'y', handler_id: 'h-missing' }, '指定的處理人不存在'],
    ];
    for (const [payload, message] of invalid) {
      const result = await fetch(`${base}/tickets`, { method: 'POST', headers, body: JSON.stringify(payload) });
      assert.equal(result.status, 400);
      assert.deepEqual(await result.json(), { error: { code: 'INVALID_PAYLOAD', message } });
    }
    assert.equal((await store.all()).length, 1);
    assert.equal((await fetch(`${base}/tickets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/tickets`, { headers })).status, 404);
    const departmentsResponse = await fetch(`${base}/departments`, { headers });
    assert.equal(departmentsResponse.status, 200);
    assert.equal(departmentsResponse.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await departmentsResponse.json(), { departments: departments.list().map((department) => ({ ...department, handlers: accounts.handlersOf(department.id) })) });
    assert.equal((await fetch(`${base}/departments`)).status, 401);
  }
  await withServer(ticketApp({ departments, judge, store, usage }), check);
}
test('指定處理人直接送達並保存為待簽核，欄位與處理人驗證回 400', handlerPath);

/**
 * 驗證 AI 判斷路徑：預扣額度與標頭、DEPARTMENT／FALLBACK 回應、保存的判斷欄位、basis 省略與租約釋放。
 * @returns {Promise<void>}
 */
async function judgePath() {
  let now = 100000;
  /** 可控制時間。@returns {number} epoch 毫秒。 */
  function clock() { return now; }
  const usage = createUsageService({ store: createMemoryLimitStore(), clock });
  const { store } = tempStore('judge.json');
  let output = { department_id: 'dept-it-2', confidence_score: 90, basis: '  需求提到 ERP  ' };
  /** 模擬 Gemini。@returns {Promise<object>} 回應。 */
  async function generateContent() { return { text: JSON.stringify(output) }; }
  const judge = createTicketJudge({ getAI: () => ({ models: { generateContent } }), departments, model: 'test-model' });
  /** 執行判斷路徑檢查。@param {string} base 位址。@returns {Promise<void>} */
  async function check(base) {
    const headers = await headersFor('one.it');
    const payload = JSON.stringify({ subject: ' ERP 報表權限 ', content: ' 財務部需要新增報表 ', handler_id: null });
    const first = await fetch(`${base}/tickets`, { method: 'POST', headers, body: payload });
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.deepEqual(Object.keys(body), ['ticket_id', 'route', 'department', 'basis', 'status']);
    assert.equal(body.route, 'DEPARTMENT');
    assert.equal(body.department, '資訊管理二部');
    assert.equal(body.basis, '需求提到 ERP');
    assert.equal(Number(first.headers.get('X-User-Remaining')), env.userDailyLimit - 1);
    const saved = await store.find(body.ticket_id);
    assert.equal(saved.requester.user_id, 'user-one.it');
    assert.equal(saved.subject, 'ERP 報表權限');
    assert.equal(saved.content, '財務部需要新增報表');
    assert.equal(saved.department_id, 'dept-it-2');
    assert.equal(saved.handler, null);
    assert.deepEqual(saved.judgement, { ai_department_id: 'dept-it-2', confidence_score: 90, basis: '需求提到 ERP', model: 'test-model' });
    assert.ok(Number.isFinite(Date.parse(saved.created_at)));
    const cooled = await fetch(`${base}/tickets`, { method: 'POST', headers, body: payload });
    assert.equal(cooled.status, 429);
    assert.equal((await cooled.json()).error.code, 'RATE_LIMIT_EXCEEDED');
    now += 10000;
    output = { department_id: 'dept-it-2', confidence_score: 60, basis: '' };
    const fallback = await fetch(`${base}/tickets`, { method: 'POST', headers, body: payload });
    assert.equal(fallback.status, 200);
    const low = await fallback.json();
    assert.deepEqual(Object.keys(low), ['ticket_id', 'route', 'department', 'status']);
    assert.equal(low.route, 'FALLBACK');
    assert.equal(low.department, '資訊管理一部');
    const lowSaved = await store.find(low.ticket_id);
    assert.equal(lowSaved.department_id, 'dept-it-1');
    assert.deepEqual(lowSaved.judgement, { ai_department_id: 'dept-it-2', confidence_score: 60, basis: '', model: 'test-model' });
    assert.equal((await usage.usage('user-one.it')).userRemaining, env.userDailyLimit - 2);
    assert.equal((await usage.usage('user-one.it')).cooldownSeconds, 10);
  }
  await withServer(ticketApp({ departments, judge, store, usage }), check);
}
test('AI 判斷路徑：預扣額度、DEPARTMENT／FALLBACK 回應與保存的判斷欄位', judgePath);

/**
 * 驗證判斷失敗與儲存失敗都已扣額並釋放租約，不回傳判斷結果，且日誌不含需求單原文。
 * @returns {Promise<void>}
 */
async function failurePaths() {
  let now = 100000;
  /** 可控制時間。@returns {number} epoch 毫秒。 */
  function clock() { return now; }
  const usage = createUsageService({ store: createMemoryLimitStore(), clock });
  const records = [];
  /** 以安全日誌輸出收集日誌。@param {string} record JSON 日誌。@returns {void} */
  function capture(record) { records.push(record); }
  const log = createLogger({ level: 'debug', sink: { log: capture, warn: capture, error: capture } });
  log('info', 'ticket.judge.started', { subject: 'private-subject', content: 'private-content', fieldLengths: { title: 3, detail: 5 } });
  assert.ok(!records.join('').includes('private-subject'));
  assert.ok(!records.join('').includes('private-content'));
  assert.ok(records.join('').includes('"fieldLengths":{"title":3,"detail":5}'));
  /** 模擬 Gemini 上游 429。@returns {Promise<never>} @throws {object} 上游限流。 */
  async function limited() { throw { status: 429, message: 'secret' }; }
  const judgeLimited = createTicketJudge({ getAI: () => ({ models: { generateContent: limited } }), departments });
  /** 模擬成功判斷。@returns {Promise<object>} 回應。 */
  async function fine() { return { text: JSON.stringify({ department_id: 'dept-it-2', confidence_score: 95, basis: 'ok' }) }; }
  const judgeFine = createTicketJudge({ getAI: () => ({ models: { generateContent: fine } }), departments });
  const headers = await headersFor('two.it');
  const payload = JSON.stringify({ subject: '申請 VPN 帳號', content: '新進同仁需要 VPN 連線權限' });
  /** 判斷失敗的檢查。@param {string} base 位址。@returns {Promise<void>} */
  async function checkJudge(base) {
    const result = await fetch(`${base}/tickets`, { method: 'POST', headers, body: payload });
    assert.equal(result.status, 429);
    assert.equal((await result.json()).error.code, 'RATE_LIMIT_EXCEEDED');
    assert.equal((await usage.usage('user-two.it')).userRemaining, env.userDailyLimit - 1);
  }
  await withServer(ticketApp({ departments, judge: judgeLimited, store: tempStore('fail-judge.json').store, usage }), checkJudge);
  now += 10000;
  writeFileSync(join(scratch, 'blocker'), '');
  const failingStore = createFileTicketStore({ file: join(scratch, 'blocker', 'child.json') });
  /** 儲存失敗的檢查。@param {string} base 位址。@returns {Promise<void>} */
  async function checkStore(base) {
    const result = await fetch(`${base}/tickets`, { method: 'POST', headers, body: payload });
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: { code: 'TICKET_STORE_UNAVAILABLE', message: '需求單儲存暫時無法使用，請稍後再試' } });
    assert.equal((await usage.usage('user-two.it')).userRemaining, env.userDailyLimit - 2);
    now += 10000;
    const again = await fetch(`${base}/tickets`, { method: 'POST', headers, body: payload });
    assert.equal(again.status, 503, '租約已釋放，下一次請求不會被 REQUEST_IN_PROGRESS 擋下');
    const assigned = await fetch(`${base}/tickets`, { method: 'POST', headers, body: JSON.stringify({ subject: '申請 VPN 帳號', content: '新進同仁需要 VPN 連線權限', handler_id: 'one.it' }) });
    assert.equal(assigned.status, 503, '指定處理人的單也需要保存成功');
  }
  await withServer(ticketApp({ departments, judge: judgeFine, store: failingStore, usage }), checkStore);
}
test('判斷失敗與儲存失敗都扣額並釋放租約，日誌遮蔽需求單原文', failurePaths);

/**
 * 驗證查詢與簽核：我的需求單、部門需求單排序與可見範圍、簽核／退回的權限、狀態與歷程。
 * @returns {Promise<void>}
 */
async function trackingAndDecisions() {
  const usage = createUsageService({ store: createMemoryLimitStore() });
  const { store } = tempStore('tracking.json');
  /** 不應被呼叫的判斷器。@returns {Promise<never>} @throws {Error} 意外呼叫。 */
  async function judge() { throw new Error('must not judge'); }
  /** 執行追蹤與簽核檢查。@param {string} base 位址。@returns {Promise<void>} */
  async function check(base) {
    const erp = await headersFor('erp.user');
    const one = await headersFor('one.it');
    const two = await headersFor('two.it');
    /** 送出指定處理人的單。@param {object} headers 提單人標頭。@param {string} handlerId 處理人。@param {string} subject 主題。@returns {Promise<string>} 單號。 */
    async function submit(headers, handlerId, subject) {
      const response = await fetch(`${base}/tickets`, { method: 'POST', headers, body: JSON.stringify({ subject, content: '新進同仁需要相關設備與權限', handler_id: handlerId }) });
      assert.equal(response.status, 200);
      return (await response.json()).ticket_id;
    }
    const toIt1a = await submit(erp, 'one.it', '申請 VPN 帳號');
    const toIt1b = await submit(erp, 'two.it', '申請辦公電腦');
    const toIt2 = await submit(one, 'erp.user', 'ERP 報表權限');
    const mine = await fetch(`${base}/tickets/mine`, { headers: erp });
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get('Cache-Control'), 'no-store');
    const mineBody = await mine.json();
    assert.deepEqual(mineBody.tickets.map((ticket) => ticket.subject), ['申請辦公電腦', '申請 VPN 帳號']);
    assert.deepEqual((await (await fetch(`${base}/tickets/mine`, { headers: two })).json()).tickets, []);
    const department = await (await fetch(`${base}/tickets/department`, { headers: one })).json();
    assert.deepEqual(department.department, { id: 'dept-it-1', name: '資訊管理一部' });
    assert.deepEqual(department.tickets.map((ticket) => ticket.ticket_id), [toIt1a, toIt1b]);
    assert.deepEqual((await (await fetch(`${base}/tickets/department`, { headers: erp })).json()).tickets.map((ticket) => ticket.ticket_id), [toIt2]);
    const forbidden = await fetch(`${base}/tickets/${toIt1a}/decision`, { method: 'POST', headers: erp, body: JSON.stringify({ action: 'APPROVE' }) });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, 'FORBIDDEN');
    for (const [payload, message] of [[{}, 'action 必須是 APPROVE 或 REJECT'], [{ action: 'approve' }, 'action 必須是 APPROVE 或 REJECT'],
      [{ action: 'APPROVE', comment: 5 }, 'comment 必須是字串'], [{ action: 'APPROVE', comment: 'a'.repeat(201) }, 'comment 最多 200 字元']]) {
      const bad = await fetch(`${base}/tickets/${toIt1a}/decision`, { method: 'POST', headers: one, body: JSON.stringify(payload) });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).error.message, message);
    }
    const missing = await fetch(`${base}/tickets/TK-missing/decision`, { method: 'POST', headers: one, body: JSON.stringify({ action: 'APPROVE' }) });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'TICKET_NOT_FOUND');
    const approved = await fetch(`${base}/tickets/${toIt1a}/decision`, { method: 'POST', headers: two, body: JSON.stringify({ action: 'APPROVE', comment: ' 已安排 ' }) });
    assert.equal(approved.status, 200);
    const { ticket } = await approved.json();
    assert.equal(ticket.status, 'APPROVED');
    assert.deepEqual(ticket.decision.comment, '已安排');
    assert.equal(ticket.decision.by_username, 'two.it');
    assert.deepEqual(ticket.history.map((item) => item.event), ['SUBMITTED', 'APPROVED']);
    assert.equal(ticket.history[1].comment, '已安排');
    assert.ok(ticket.updated_at >= ticket.created_at);
    const again = await fetch(`${base}/tickets/${toIt1a}/decision`, { method: 'POST', headers: one, body: JSON.stringify({ action: 'REJECT' }) });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error.code, 'TICKET_ALREADY_DECIDED');
    const rejected = await fetch(`${base}/tickets/${toIt1b}/decision`, { method: 'POST', headers: one, body: JSON.stringify({ action: 'REJECT' }) });
    const rejectedBody = await rejected.json();
    assert.equal(rejectedBody.ticket.status, 'REJECTED');
    assert.equal(rejectedBody.ticket.decision.comment, '');
    assert.equal(rejectedBody.ticket.history[1].comment, undefined);
    const ordered = await (await fetch(`${base}/tickets/department`, { headers: one })).json();
    assert.deepEqual(ordered.tickets.map((item) => item.status), ['REJECTED', 'APPROVED']);
    const requesterView = await (await fetch(`${base}/tickets/mine`, { headers: erp })).json();
    assert.deepEqual(requesterView.tickets.map((item) => item.status), ['REJECTED', 'APPROVED']);
    assert.equal(requesterView.tickets[1].decision.comment, '已安排');
    assert.equal((await fetch(`${base}/tickets/mine`)).status, 401);
    assert.equal((await fetch(`${base}/tickets/${toIt1a}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  }
  await withServer(ticketApp({ departments, judge, store, usage }), check);
}
test('我的需求單、部門需求單與簽核／退回的權限與歷程', trackingAndDecisions);

/**
 * 驗證完整 app 已掛載需求單、查詢與簽核 API：未登入 401、方法不符 404、CORS 預檢、登入回應含部門，以及真實設定檔可用。
 * @returns {Promise<void>}
 */
async function mountedRoutes() {
  /** 執行完整 app 檢查。@param {string} base 位址。@returns {Promise<void>} */
  async function check(base) {
    assert.equal((await fetch(`${base}/api/departments`)).status, 401);
    assert.equal((await fetch(`${base}/api/tickets/mine`)).status, 401);
    assert.equal((await fetch(`${base}/api/tickets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/tickets`)).status, 404);
    assert.equal((await fetch(`${base}/api/departments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    const preflight = await fetch(`${base}/api/tickets`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(preflight.status, 204);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username":"grace.tsai","password":"test-only-password"}' });
    const session = await login.json();
    assert.deepEqual(session.user, { username: 'grace.tsai', userID: 'user-grace.tsai', role: 'USER', department: { id: 'dept-ga-1', name: '總務與硬體組' } });
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
    const list = await fetch(`${base}/api/departments`, { headers });
    assert.equal(list.status, 200);
    const { departments: realDepartments } = await list.json();
    assert.ok(realDepartments.length >= 1);
    for (const department of realDepartments) assert.deepEqual(Object.keys(department), ['id', 'name', 'type', 'duty', 'business', 'handlers']);
    const handler = realDepartments.find((department) => department.id === 'dept-ga-1').handlers[0];
    assert.equal(handler.id, handler.name, '處理人即帳號');
    const assigned = await fetch(`${base}/api/tickets`, { method: 'POST', headers, body: JSON.stringify({ subject: '申請 VPN 帳號', content: '新進同仁需要 VPN 連線權限', handler_id: handler.id }) });
    assert.equal(assigned.status, 200);
    const { ticket_id: ticketId } = await assigned.json();
    assert.equal(JSON.parse(readFileSync(process.env.TICKETS_FILE, 'utf8'))[0].ticket_id, ticketId);
    const pending = await (await fetch(`${base}/api/tickets/department`, { headers })).json();
    assert.equal(pending.tickets[0].ticket_id, ticketId);
    const decided = await fetch(`${base}/api/tickets/${ticketId}/decision`, { method: 'POST', headers, body: JSON.stringify({ action: 'APPROVE' }) });
    assert.equal(decided.status, 200);
    assert.equal((await (await fetch(`${base}/api/tickets/mine`, { headers })).json()).tickets[0].status, 'APPROVED');
    const noKey = await fetch(`${base}/api/tickets`, { method: 'POST', headers, body: JSON.stringify({ subject: '申請 VPN 帳號', content: '新進同仁需要 VPN 連線權限' }) });
    assert.equal(noKey.status, 500);
    assert.equal((await noKey.json()).error.message, '尚未設定 Gemini API 金鑰');
    const oversized = await fetch(`${base}/api/tickets`, { method: 'POST', headers, body: JSON.stringify({ subject: '申請 VPN 帳號', content: 'a'.repeat(20000) }) });
    assert.equal(oversized.status, 413);
    assert.equal((await fetch(`${base}/api/tickets/${ticketId}/decision`, { method: 'PUT', headers, body: '{}' })).status, 404);
  }
  await withServer(app, check);
}
test('完整 app 掛載需求單、查詢與簽核 API 並沿用統一錯誤處理', mountedRoutes);
