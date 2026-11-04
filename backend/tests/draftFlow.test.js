import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestEnv } from './helpers/testEnv.js';

const scratch = mkdtempSync(join(tmpdir(), 'helpdesk-draft-'));
setupTestEnv({ CORS_ORIGIN: 'http://localhost:5173', LOG_LEVEL: 'info', DATABASE_FILE: join(scratch, 'app.db') });

// 收集本檔所有日誌，確認不含主題、訊息或欄位值；測試結束後還原。
const captured = [];
const originalConsole = { log: console.log, warn: console.warn, error: console.error };
/** 把日誌輸出存入陣列而不印出。@param {...unknown} parts 輸出內容。@returns {void} */
function capture(...parts) { captured.push(parts.join(' ')); }
console.log = capture;
console.warn = capture;
console.error = capture;

const { env } = await import('../src/config/env.js');
const { app } = await import('../src/server.js');
const { createDepartmentService } = await import('../src/services/departmentService.js');
const { createAccountService, accountService } = await import('../src/services/personnel/accountService.js');
const { createEmployeeService } = await import('../src/services/personnel/employeeService.js');
const { loadRequestTypes, DEFAULT_TYPES_DIR, CATALOG_FILE } = await import('../src/services/requestTypes/registry.js');
const { createSqliteDataStore, dataStore } = await import('../src/services/storage/dataStore.js');
const { createUsageService } = await import('../src/services/usageService.js');
const { createMemoryLimitStore } = await import('../src/services/storage/limitStore.js');
const { createTaskTracker } = await import('../src/services/taskTracker.js');
const { createAuthService, authService } = await import('../src/services/authService.js');
const { createDraftHandler, createRequestTypesHandler, AI_NOTICES } = await import('../src/controllers/requestTypeController.js');
const { createTicketHandler, createDecisionHandler, createTransferHandler, createCancelHandler, DRAFT_BASIS } = await import('../src/controllers/ticketController.js');
const { createMyLeaveBalanceHandler, createLeaveBalancesHandler, createLeaveAdjustmentHandler } = await import('../src/controllers/leaveController.js');
const { errorHandler, notFound, HttpError } = await import('../src/middleware/errorHandler.js');
const { SCHEMA_VERSION, APPLICATION_ID } = await import('../src/services/storage/database.js');
const Database = createRequire(import.meta.url)('better-sqlite3');

const openedStores = [dataStore];
/** 測試結束後還原 console、關閉資料庫連線並刪除暫存檔。@returns {void} */
function cleanup() {
  Object.assign(console, originalConsole);
  for (const store of openedStores) store.close();
  rmSync(scratch, { recursive: true, force: true });
}
test.after(cleanup);

/**
 * 確認自動生成回應中顯示給使用者的文字（reply、prompt、ai_error.message）都沒有「。」：
 * 不論文字來自 AI、定義檔的招呼語、後端固定說明或檢核清單，都要符合共用標點規範
 * @param {{reply: string, prompt: string, ai_error: {message: string}|null}} body 自動生成的回應本文
 * @returns {void}
 * @throws {AssertionError} 任何一段文字含有「。」
 */
function assertNoFullStop(body) {
  for (const [name, text] of [['reply', body.reply], ['prompt', body.prompt], ['ai_error.message', body.ai_error?.message ?? '']]) {
    assert.ok(!text.includes('。'), `${name} 不得含有「。」：${text}`);
  }
}

// 測試用部門、帳號與員工資料；全部為假資料，與實際環境無關。
const departments = createDepartmentService({ departments: [
  { id: 'dept-it-1', name: '資訊管理一部', duty: 'VPN、網路並擔任 IT資訊服務台', business: ['VPN', 'IT資訊服務台'] },
  { id: 'dept-hr-1', name: '人力資源部', duty: '人事', business: ['人事'] },
  { id: 'dept-ga-1', name: '總務與硬體組', duty: '辦公設備與報修', business: ['辦公設備'] },
  { id: 'dept-fin-1', name: '財務部', duty: '報帳與請款', business: ['報帳'] },
  { id: 'dept-pur-1', name: '採購部', duty: '採購與詢價', business: ['採購'] },
] });
const rawAccounts = [
  { username: 'one.it', department_id: 'dept-it-1' }, { username: 'two.it', department_id: 'dept-it-1' }, { username: 'three.it', department_id: 'dept-it-1' },
  { username: 'hr.one', department_id: 'dept-hr-1' }, { username: 'hr.two', department_id: 'dept-hr-1' },
  { username: 'ga.one', department_id: 'dept-ga-1' }, { username: 'ga.two', department_id: 'dept-ga-1' },
  { username: 'fin.one', department_id: 'dept-fin-1' }, { username: 'fin.two', department_id: 'dept-fin-1' },
  { username: 'boss.admin', department_id: 'dept-it-1', role: 'ADMIN' },
];
const accounts = createAccountService({ departments, accounts: rawAccounts });
const grants = { 2026: { 特休: 6720, 事假: 6720, 病假: 14400 }, 2027: { 特休: 6720, 事假: 6720, 病假: 14400 } };
const rawEmployees = rawAccounts.filter(/** 一般帳號。@param {object} item 帳號。@returns {boolean} USER 時 true。 */ (item) => !item.role)
  .map(/** 產生假員工資料。@param {object} item 帳號。@param {number} index 序號。@returns {object} 員工。 */ (item, index) => ({ username: item.username, display_name: `測試員工${index + 1}`,
    employee_no: `T-90${String(index + 1).padStart(2, '0')}`, hire_date: '2020-01-01', entitlements: grants }));
const employees = createEmployeeService({ accounts, employees: rawEmployees });
const personnel = { accounts: rawAccounts, employees: rawEmployees };
// 需求類型使用實際的定義檔（data/requestTypes），部門改用測試部門；另以 withHandlers 加回指定處理人設定，繼續驗證引擎的處理人規則。
const types = loadRequestTypes({ departments, read: withHandlers });

/**
 * 讀取實際定義檔，並為每個類型加回「指定處理人」設定（實際設定已全部移除，提出需求單頁不再提供），讓引擎的處理人規則仍有測試覆蓋：
 * handler 的候選工具為 department_members，一般需求可以指定本人、其他類型不行；請假以外的類型 ai.tools 加回 department_members（與移除前相同）；一般需求的固定文字加回「[指定處理人]」一行。
 * @param {string} path 定義檔路徑。
 * @returns {string} 檔案內容（JSON 文字）。
 */
function withHandlers(path) {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith(CATALOG_FILE)) return text;
  const definition = JSON.parse(text);
  definition.handler = { options_tool: 'department_members', not_self: definition.id !== 'general' };
  if (definition.id !== 'leave') definition.ai.tools = [...new Set([...definition.ai.tools, 'department_members'])];
  if (definition.id === 'general') definition.render.lines.push('[指定處理人]: {handler|default:未指定}');
  return JSON.stringify(definition);
}
const LEAVE_VERSION = types.find('leave').version;
const auth = createAuthService({ ...env, authSecret: 'test-only-secret-value-that-is-long-enough' }, accounts);
// 固定在台北 2026-11-01（週日）上午。
const NOW = Date.UTC(2026, 10, 1, 2, 0);
/** 固定時間來源。@returns {number} epoch 毫秒。 */
function clock() { return NOW; }

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
 * 建立隔離的測試環境：暫存 SQLite（假員工資料）、記憶體配額、可控制的 AI 助手替身與含所有相關路由的 app。
 * AI 替身的 classify／fill 依 setAI 設定的值或函式回應，並記錄每次呼叫（kind 與交給 AI 的參數）。
 * @param {string} name 資料庫檔名。
 * @param {object} [options={}] 選項。
 * @param {string} [options.key=''] 假的 AI 金鑰（只決定是否嘗試 AI，不會連線）。
 * @param {object} [options.limits={}] 覆寫配額設定。
 * @param {object} [options.registry=types] 需求類型目錄；預設為實際定義檔，測試新增類型時可傳入從暫存目錄載入的目錄。
 * @returns {object} store、usage、calls、setAI、judged、application。
 */
function setup(name, { key = '', limits = {}, registry = types } = {}) {
  const store = createSqliteDataStore({ file: join(scratch, name), seed: personnel });
  openedStores.push(store);
  const config = { ...env, ...limits, aiApiKey: key };
  const usage = createUsageService({ store: createMemoryLimitStore(), config, clock });
  const calls = [];
  const next = { classify: null, fill: null };
  const judged = { count: 0 };
  /** 設定 AI 替身下一次的結果。@param {{classify?: object|Function, fill?: object|Function}} value 結果或函式。@returns {void} */
  function setAI(value) { Object.assign(next, value); }
  /**
   * 依設定產生替身回應。
   * @param {string} kind classify 或 fill。
   * @param {object} request 交給 AI 的參數。
   * @returns {Promise<object>} 結果。
   */
  async function respond(kind, request) {
    calls.push({ kind, request });
    const value = next[kind];
    if (typeof value === 'function') return value(request);
    return { toolsUsed: [], model: 'test-model', ...structuredClone(value) };
  }
  const assistant = {
    /** 分類替身。@param {object} request 參數。@returns {Promise<object>} 結果。 */
    classify: (request) => respond('classify', request),
    /** 填寫替身。@param {object} request 參數。@returns {Promise<object>} 結果。 */
    fill: (request) => respond('fill', request),
  };
  /** 不應被呼叫的判斷器。@returns {Promise<never>} @throws {Error} 意外呼叫。 */
  async function judge() { judged.count += 1; throw new Error('must not judge'); }
  const application = express();
  application.use(express.json({ limit: '16kb' }));
  application.get('/forms', testAuthenticate, createRequestTypesHandler(registry));
  application.post('/tickets/draft', testAuthenticate, createDraftHandler({ types: registry, departments, accounts, store, usage, tasks: createTaskTracker(), assistant, config, clock }));
  application.post('/tickets', testAuthenticate, createTicketHandler({ departments, accounts, judge, store, usage, types: registry, clock }));
  application.post('/tickets/:id/decision', testAuthenticate, createDecisionHandler(store, registry));
  application.post('/tickets/:id/transfer', testAuthenticate, createTransferHandler(store, departments, accounts, registry));
  application.post('/tickets/:id/cancel', testAuthenticate, createCancelHandler(store, registry));
  application.get('/me/leave-balance', testAuthenticate, createMyLeaveBalanceHandler({ store, types: registry, clock }));
  application.get('/leave/balances', testAuthenticate, createLeaveBalancesHandler({ store, types: registry, clock }));
  application.post('/leave/adjustments', testAuthenticate, createLeaveAdjustmentHandler({ store, types: registry, accounts, clock }));
  application.use(notFound);
  application.use(errorHandler);
  return { store, usage, calls, setAI, judged, application };
}

/**
 * 在本機臨時埠啟動 app，提供以帳號呼叫 API 的函式，完成後關閉所有連線；不呼叫真實 Gemini。
 * @param {object} application Express app。
 * @param {Function} run 接收 call(method, path, username, body) 的測試操作。
 * @returns {Promise<void>}
 */
async function withServer(application, run) {
  const server = application.listen(0, '127.0.0.1');
  /** 等待監聽成功。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function listening(resolve, reject) { server.once('listening', resolve); server.once('error', reject); }
  await new Promise(listening);
  const base = `http://127.0.0.1:${server.address().port}`;
  /**
   * 以測試帳號呼叫 API。
   * @param {string} method HTTP 方法。
   * @param {string} path 路徑。
   * @param {string|null} username 測試帳號；null 表示不帶憑證。
   * @param {object} [body] JSON 本文。
   * @returns {Promise<{status: number, body: object}>} 狀態碼與解析後的本文。
   */
  async function call(method, path, username, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (username) headers.Authorization = `Bearer ${(await auth.issue(accounts.find(username))).token}`;
    const response = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  try { await run(call); } finally { server.closeAllConnections(); server.close(); }
}

/**
 * 組出完整的請假欄位（預設 2026-12-01 週二 09:30～17:30 特休、代理人 two.it）。
 * @param {object} [overrides={}] 覆寫的欄位。
 * @returns {Record<string, string>} 欄位值。
 */
function leaveFields(overrides = {}) {
  return { leave_type: '特休', start_at: '2026-12-01T09:30', end_at: '2026-12-01T17:30', agent: 'two.it', ...overrides };
}

/**
 * 組出設備申請的完整欄位。
 * @param {object} [overrides={}] 覆寫的欄位。
 * @returns {Record<string, string>} 欄位值。
 */
function equipmentFields(overrides = {}) {
  return { item: '27 吋螢幕', quantity: '2', purpose: '雙螢幕開發', needed_by: '2026-11-20', location: '3F A 區', ...overrides };
}

/**
 * 組出手動編輯驗證的 state（全部欄位鎖定）。
 * @param {string} typeId 需求類型 id。
 * @param {Record<string, string>} fields 欄位值。
 * @param {object} [extra={}] 其他 state 欄位。
 * @returns {object} state。
 */
function stateOf(typeId, fields, extra = {}) {
  return { type_id: typeId, department_id: types.find(typeId).departmentId, handler_id: null, fields, locked: Object.keys(fields), ...extra };
}

/**
 * 以手動編輯驗證取得後端渲染的需求內容，再以 form 送出。
 * @param {Function} call withServer 提供的呼叫函式。
 * @param {string} username 提單人。
 * @param {string} typeId 需求類型 id。
 * @param {Record<string, string>} fields 欄位值。
 * @param {object} [extra={}] 送出本文的其他欄位（例如 handler_id）。
 * @returns {Promise<{status: number, body: object}>} 送出結果。
 */
async function submitType(call, username, typeId, fields, extra = {}) {
  const draft = await call('POST', '/tickets/draft', username, { subject: '申請', state: stateOf(typeId, fields) });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.complete, true, `草稿應已完成：${draft.body.prompt}`);
  return call('POST', '/tickets', username, { subject: '申請', content: `請協助核准\n${draft.body.rendered_content}`, form: { id: typeId, version: types.find(typeId).version, fields }, ...extra });
}

/**
 * 驗證沒有 AI 時的自動生成：主題關鍵字備援、定義的招呼語、一般需求請使用者選部門、手動編輯驗證、計算結果與額度摘要、設備申請的欄位規則；
 * 不呼叫 AI、不扣額度。
 * @returns {Promise<void>}
 */
async function draftWithoutAI() {
  const { usage, calls, application } = setup('no-ai.db');
  /** 執行檢查。@param {Function} call 呼叫函式。@returns {Promise<void>} */
  async function check(call) {
    const first = await call('POST', '/tickets/draft', 'one.it', { subject: ' 12 月想請特休 ' });
    assert.equal(first.status, 200);
    const body = first.body;
    assert.deepEqual(Object.keys(body), ['intent', 'type', 'department', 'department_options', 'handler', 'handler_options', 'values', 'sources', 'missing', 'invalid',
      'field_options', 'computed', 'summaries', 'reply', 'prompt', 'ai_available', 'ai_error', 'complete', 'rendered_content', 'preview_content', 'tools_used']);
    assert.equal(body.intent, '請假申請');
    assert.deepEqual(Object.keys(body.type), ['id', 'version', 'name', 'department', 'fields']);
    assert.equal(body.type.id, 'leave');
    assert.equal(body.type.version, LEAVE_VERSION);
    assert.deepEqual(body.department, { id: 'dept-hr-1', name: '人力資源部' });
    assert.equal(body.department_options.length, 5);
    assert.deepEqual(body.handler_options, [{ id: 'hr.one', name: 'hr.one' }, { id: 'hr.two', name: 'hr.two' }]);
    assert.deepEqual(body.values, { applicant: 'one.it', leave_type: '', start_at: '', end_at: '', agent: '', note: '' });
    assert.deepEqual(body.sources, { applicant: 'system', department_id: 'system' });
    assert.deepEqual(body.missing, ['leave_type', 'start_at', 'end_at', 'agent']);
    assert.deepEqual(body.field_options, { agent: [{ id: 'two.it', name: 'two.it', available: true }, { id: 'three.it', name: 'three.it', available: true }] });
    assert.deepEqual(body.computed, []);
    assert.deepEqual(body.summaries, []);
    assert.equal(body.reply, `one.it 你好，這邊已經收到你想要請假的需求，根據您的需求您的業務將會由人資部進行處理，由於請假程序需要您先提供一些基本的訊息，請告訴我你想請假的日期、時間、假別、代理人，我將會自動為您生成需求單給您送出；如果填寫過程中有遇到任何問題，可以隨時與我溝通，例如不清楚填寫格式或者代理人可以選擇誰等等\n${AI_NOTICES.AI_UNAVAILABLE}`);
    assert.equal(body.prompt, '這份需求單將送到「人力資源部」；還需要提供：假別、請假起始時間、請假截止時間、代理人');
    assertNoFullStop(body);
    assert.equal(body.ai_available, false);
    assert.deepEqual(body.ai_error, { code: 'AI_UNAVAILABLE', message: AI_NOTICES.AI_UNAVAILABLE });
    assert.equal(body.complete, false);
    assert.equal(body.rendered_content, null);
    assert.equal(body.preview_content, '[請假人]: one.it\n[請假日期]: \n[請假起始時間]: \n[請假截止時間]: \n[假別]: \n[請假時數]: \n[代理人]: \n[備註]: 無');
    assert.deepEqual(body.tools_used, []);
    const general = (await call('POST', '/tickets/draft', 'one.it', { subject: '印表機卡紙' })).body;
    assert.equal(general.type.id, 'general');
    assert.equal(general.department, null);
    assert.equal(general.intent, '一般需求');
    assert.deepEqual(general.values, { description: '' });
    assert.deepEqual(general.missing, ['department_id', 'description']);
    assert.deepEqual(general.handler_options, []);
    assert.deepEqual(general.field_options, {});
    assert.match(general.reply, /^one\.it 你好，這邊已經收到你的需求，請告訴我需求的詳細狀況/u);
    assert.equal(general.prompt, '請在右側選擇處理部門；還需要提供：需求說明');
    assert.equal(general.preview_content, '[需求說明]: \n[處理部門]: \n[指定處理人]: 未指定');
    const manual = (await call('POST', '/tickets/draft', 'one.it', { subject: '12 月想請特休', state: stateOf('leave', leaveFields({ note: '  家中\n有事 ' })) })).body;
    assert.equal(manual.reply, '', '手動編輯驗證不產生對話');
    assert.equal(manual.ai_error, null);
    assert.equal(manual.complete, true);
    assert.deepEqual(manual.computed, [{ key: 'minutes', label: '請假時數', value: 420, text: '7 小時 0 分鐘' }]);
    assert.deepEqual(manual.summaries, ['特休剩餘時數：112 小時 0 分鐘 → 105 小時 0 分鐘']);
    assert.deepEqual(manual.sources, { applicant: 'system', leave_type: 'user', start_at: 'user', end_at: 'user', agent: 'user', note: 'user', department_id: 'system' });
    assert.equal(manual.rendered_content, '[請假人]: one.it\n[請假日期]: 2026-12-01（週二）\n[請假起始時間]: 09:30\n[請假截止時間]: 17:30\n[假別]: 特休\n[請假時數]: 7 小時 0 分鐘\n[代理人]: two.it\n[備註]: 家中 有事');
    assert.equal(manual.preview_content, manual.rendered_content);
    assert.match(manual.prompt, /資料已完整/u);
    assertNoFullStop(manual);
    const equipmentFirst = (await call('POST', '/tickets/draft', 'one.it', { subject: '想申請螢幕' })).body;
    assert.equal(equipmentFirst.type.id, 'equipment');
    assert.deepEqual(equipmentFirst.department, { id: 'dept-ga-1', name: '總務與硬體組' });
    assert.match(equipmentFirst.reply, /^one\.it 你好，這邊已經收到你想要申請設備的需求，根據您的需求您的業務將會由總務與硬體組進行處理/u);
    assert.deepEqual(equipmentFirst.missing, ['item', 'quantity', 'purpose', 'needed_by', 'location']);
    const badEquipment = (await call('POST', '/tickets/draft', 'one.it', { subject: '想申請螢幕', state: stateOf('equipment', equipmentFields({ quantity: '0', needed_by: '2026-10-31' })) })).body;
    assert.deepEqual(badEquipment.invalid, [{ key: 'quantity', message: '數量不可小於 1' }, { key: 'needed_by', message: '需要日期不可早於今天' }]);
    assert.equal(badEquipment.complete, false);
    const equipment = (await call('POST', '/tickets/draft', 'one.it', { subject: '想申請螢幕', state: stateOf('equipment', equipmentFields()) })).body;
    assert.equal(equipment.complete, true);
    assert.equal(equipment.rendered_content, '[申請人]: one.it\n[設備品項]: 27 吋螢幕\n[數量]: 2\n[用途說明]: 雙螢幕開發\n[需要日期]: 2026-11-20（週五）\n[送交地點]: 3F A 區');
    const chosen = (await call('POST', '/tickets/draft', 'one.it', { subject: '報帳', state: { type_id: 'general', department_id: 'dept-fin-1', handler_id: 'fin.two',
      fields: { description: ' 十一月差旅報帳\r\n共三張發票 ' }, locked: ['department_id', 'handler_id', 'description'] } })).body;
    assert.equal(chosen.complete, true);
    assert.deepEqual(chosen.handler, { id: 'fin.two', name: 'fin.two' });
    assert.deepEqual(chosen.sources, { description: 'user', department_id: 'user', handler_id: 'user' });
    assert.equal(chosen.intent, '財務部相關需求');
    assert.equal(chosen.rendered_content, '[需求說明]: 十一月差旅報帳\n共三張發票\n[處理部門]: 財務部\n[指定處理人]: fin.two');
    const moved = (await call('POST', '/tickets/draft', 'one.it', { subject: '報帳', state: { type_id: 'general', department_id: 'dept-fin-1', handler_id: 'one.it', fields: { description: '報帳' } } })).body;
    assert.equal(moved.handler, null, '不屬於部門的處理人改為未指定');
    assert.match(moved.prompt, /原指定處理人不是「財務部」可指定的處理人，已改為未指定/u);
    assertNoFullStop(moved);
    const hrSelf = (await call('POST', '/tickets/draft', 'hr.one', { subject: '請假', state: stateOf('leave', {}, { handler_id: 'hr.one' }) })).body;
    assert.deepEqual(hrSelf.handler_options, [{ id: 'hr.two', name: 'hr.two' }], '定義 handler.not_self 時排除本人');
    assert.equal(hrSelf.handler, null);
    assert.equal(calls.length, 0, '沒有金鑰時不呼叫 AI');
    assert.equal((await usage.draftUsage('user-one.it')).userRemaining, env.draftUserDailyLimit, '沒有呼叫 AI 不扣額度');
    for (const [payload, pattern] of [[{}, /subject/u], [{ subject: 'x', message: 'x'.repeat(301) }, /message/u], [{ subject: 'x', state: { type_id: 'nope' } }, /需求類型/u]]) {
      const bad = await call('POST', '/tickets/draft', 'one.it', payload);
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, 'INVALID_PAYLOAD');
      assert.match(bad.body.error.message, pattern);
    }
    assert.equal((await call('POST', '/tickets/draft', null, { subject: 'x' })).status, 401);
  }
  await withServer(application, check);
}
test('沒有 AI 時的自動生成：關鍵字備援、招呼語、手動編輯驗證與設備規則', draftWithoutAI);

/**
 * 驗證有 AI 時的自動生成：分類決定類型與部門、填寫時 AI 呼叫允許的工具（伺服器端執行並套用存取規則）、鎖定欄位不被改寫、
 * AI 切換需求類型、AI 失敗不讓請求失敗、額度只在呼叫 AI 時扣除，以及日誌不含使用者文字。
 * @returns {Promise<void>}
 */
async function draftWithAI() {
  const { usage, calls, setAI, application } = setup('with-ai.db', { key: 'test-key-not-real', limits: { draftUserDailyLimit: 12 } });
  /** 建立分類結果。@param {object} overrides 覆寫。@returns {object} 結果。 */
  const classified = (overrides) => ({ intent: '申請特休', typeId: 'leave', departmentId: 'dept-it-1', confidence: 90, reply: 'AI 的招呼語', ...overrides });
  /** 建立填寫結果。@param {object} overrides 覆寫。@returns {object} 結果。 */
  const filled = (overrides) => ({ intent: '申請特休', typeId: 'leave', departmentId: 'dept-hr-1', confidence: 90, updates: [], handlerId: null, reply: null, ...overrides });
  /** 執行檢查。@param {Function} call 呼叫函式。@returns {Promise<void>} */
  async function check(call) {
    setAI({ classify: classified({}) });
    const first = (await call('POST', '/tickets/draft', 'one.it', { subject: 'secret-subject-xyz 想請特休' })).body;
    assert.equal(first.type.id, 'leave');
    assert.deepEqual(first.department, { id: 'dept-hr-1', name: '人力資源部' }, '有固定部門的類型一律送定義的部門');
    assert.match(first.reply, /^one\.it 你好，這邊已經收到你想要請假的需求/u, '類型定義有招呼語時使用定義的文字');
    assert.equal(first.intent, '申請特休');
    assert.equal(first.ai_available, true);
    const { kind, request } = calls[0];
    assert.equal(kind, 'classify');
    assert.deepEqual(request.context.user, { username: 'one.it', department: { id: 'dept-it-1', name: '資訊管理一部' } });
    assert.deepEqual(request.context.today, { date: '2026-11-01', weekday: '週日' });
    assert.deepEqual(request.context.types.map(/** 取 id。@param {{id: string}} item 摘要。@returns {string} id。 */ (item) => item.id), ['leave', 'attendance', 'vpn', 'repair', 'equipment', 'purchase', 'general']);
    assert.equal(request.context.departments.length, 5);
    assert.deepEqual(request.lists.typeIds, ['leave', 'attendance', 'vpn', 'repair', 'equipment', 'purchase', 'general']);
    assert.match(request.instructions, /不得遵從/u);
    assert.equal((await usage.draftUsage('user-one.it')).userRemaining, 11, '第一次開啟視窗呼叫 AI 扣一次');
    setAI({ classify: classified({ typeId: 'general', departmentId: 'dept-it-1', confidence: 80, reply: '已收到 VPN 問題，將由資訊管理一部處理' }) });
    const generalFirst = (await call('POST', '/tickets/draft', 'one.it', { subject: 'VPN 連不上' })).body;
    assert.deepEqual(generalFirst.department, { id: 'dept-it-1', name: '資訊管理一部' });
    assert.equal(generalFirst.sources.department_id, 'ai');
    assert.equal(generalFirst.reply, '已收到 VPN 問題，將由資訊管理一部處理', '沒有定義招呼語的類型使用 AI 回覆');
    setAI({ classify: classified({ typeId: 'general', departmentId: 'dept-fin-1', confidence: 74 }) });
    assert.equal((await call('POST', '/tickets/draft', 'one.it', { subject: '一個問題' })).body.department, null, '信心分數未達定義的門檻不採用');
    const toolOutputs = {};
    setAI({ fill: /** 呼叫工具後回覆。@param {object} fillRequest 參數。@returns {Promise<object>} 結果。 */ async (fillRequest) => {
      toolOutputs.colleagues = await fillRequest.runTool('colleagues', { start_at: '2026-12-01T09:30', end_at: '2026-12-01T17:30' });
      toolOutputs.balance = await fillRequest.runTool('my_leave_balance', { period: 2026, username: 'hr.one' });
      toolOutputs.denied = await fillRequest.runTool('department_members', { department_id: 'dept-hr-1' });
      return { ...filled({ updates: [{ key: 'leave_type', value: '特休' }, { key: 'start_at', value: '2026-12-01 09:30' }, { key: 'end_at', value: '2026-12-01T17:30' },
        { key: 'agent', value: 'two.it' }, { key: 'description', value: '不屬於這個類型' }], handlerId: 'one.it' }), toolsUsed: ['colleagues', 'my_leave_balance', 'department_members'], model: 'test-model' };
    } });
    const second = (await call('POST', '/tickets/draft', 'one.it', { subject: '想請特休', message: 'secret-message-abc 12/1 09:30 到 17:30，代理人 two.it',
      history: [{ role: 'assistant', text: 'AI 的招呼語' }], state: { type_id: 'leave', department_id: 'dept-hr-1', fields: { leave_type: '事假' }, locked: ['leave_type'] } })).body;
    assert.equal(second.type.id, 'leave');
    assert.equal(second.values.leave_type, '事假', '鎖定的欄位不被 AI 改寫');
    assert.equal(second.values.start_at, '2026-12-01T09:30', 'AI 的時間寫法被正規化');
    assert.deepEqual(second.sources, { applicant: 'system', leave_type: 'user', start_at: 'ai', end_at: 'ai', agent: 'ai', department_id: 'system' });
    assert.equal(second.handler, null, 'AI 建議的處理人不可指定時不採用');
    assert.equal(second.complete, true);
    assert.deepEqual(second.summaries, ['事假剩餘時數：112 小時 0 分鐘 → 105 小時 0 分鐘']);
    assert.equal(second.reply, '已依你的訊息更新右側需求內容，請確認是否正確', 'AI 沒有回覆時使用後端文字');
    assert.deepEqual(second.tools_used, ['colleagues', 'my_leave_balance', 'department_members']);
    assert.deepEqual(toolOutputs.colleagues, { result: [{ id: 'two.it', name: 'two.it', available: true }, { id: 'three.it', name: 'three.it', available: true }] }, '同事工具只有帳號名稱');
    assert.deepEqual(toolOutputs.balance.result.balances.map(/** 取類別與剩餘。@param {object} entry 額度。@returns {string} 摘要。 */ (entry) => `${entry.category}:${entry.remaining}`), ['事假:6720', '病假:14400', '特休:6720'], '只回傳本人的額度');
    assert.deepEqual(toolOutputs.denied, { error: '這個工具不能在目前的需求類型使用' }, '不在類型 ai.tools 的工具被拒絕');
    const fillCall = calls.at(-1);
    assert.equal(fillCall.kind, 'fill');
    assert.equal(fillCall.request.context.request_type.id, 'leave');
    assert.equal(fillCall.request.context.message, 'secret-message-abc 12/1 09:30 到 17:30，代理人 two.it');
    assert.deepEqual(fillCall.request.context.state.locked, ['leave_type']);
    assert.deepEqual(fillCall.request.context.history, [{ role: 'assistant', text: 'AI 的招呼語' }]);
    assert.deepEqual(fillCall.request.tools.map(/** 取工具 id。@param {{id: string}} tool 工具。@returns {string} id。 */ (tool) => tool.id), ['colleagues', 'my_leave_balance', 'department_directory']);
    assert.ok(fillCall.request.lists.keys.includes('agent') && fillCall.request.lists.keys.includes('item') && !fillCall.request.lists.keys.includes('applicant'));
    setAI({ fill: filled({ typeId: 'equipment', departmentId: 'dept-ga-1', updates: [{ key: 'item', value: '筆電' }, { key: 'quantity', value: '1' }], reply: '改為設備申請' }) });
    const switched = (await call('POST', '/tickets/draft', 'one.it', { subject: '筆電', message: '其實我是要申請一台筆電', state: { type_id: 'general', fields: {} } })).body;
    assert.equal(switched.type.id, 'equipment', 'AI 可以依對話改成其他需求類型');
    assert.deepEqual(switched.department, { id: 'dept-ga-1', name: '總務與硬體組' });
    assert.deepEqual(switched.values, { applicant: 'one.it', item: '筆電', quantity: '1', purpose: '', needed_by: '', location: '' });
    const pinned = (await call('POST', '/tickets/draft', 'one.it', { subject: '筆電', message: '換類型', state: { type_id: 'general', fields: {}, locked: ['type_id'] } })).body;
    assert.equal(pinned.type.id, 'general', '鎖定 type_id 時不切換');
    setAI({ fill: filled({ intent: 'VPN 無法連線', typeId: 'general', departmentId: 'dept-it-1', confidence: 80, updates: [{ key: 'description', value: 'VPN 自昨天起無法連線' }], handlerId: 'two.it', reply: '已整理' }) });
    const general = (await call('POST', '/tickets/draft', 'one.it', { subject: 'VPN 連不上', message: '昨天開始就連不上', state: { type_id: 'general', fields: {} } })).body;
    assert.deepEqual(general.department, { id: 'dept-it-1', name: '資訊管理一部' });
    assert.deepEqual(general.handler, { id: 'two.it', name: 'two.it' });
    assert.deepEqual(general.sources, { description: 'ai', department_id: 'ai', handler_id: 'ai' });
    assert.equal(general.rendered_content, '[需求說明]: VPN 自昨天起無法連線\n[處理部門]: 資訊管理一部\n[指定處理人]: two.it');
    setAI({ fill: filled({ typeId: 'general', departmentId: 'dept-it-1', confidence: 99 }) });
    const kept = (await call('POST', '/tickets/draft', 'one.it', { subject: '報帳', message: '補充', state: { type_id: 'general', department_id: 'dept-fin-1', locked: ['department_id'] } })).body;
    assert.deepEqual(kept.department, { id: 'dept-fin-1', name: '財務部' }, '使用者鎖定的部門不被 AI 改寫');
    setAI({ fill: /** 模擬 AI 逾時。@returns {never} @throws {HttpError} 帶 draftReason 的錯誤。 */ () => { throw Object.assign(new HttpError(500, 'SERVER_ERROR', 'AI 處理逾時'), { draftReason: 'AI_TIMEOUT' }); } });
    const timeout = await call('POST', '/tickets/draft', 'one.it', { subject: '想請特休', message: '還是請特休', state: stateOf('leave', leaveFields(), { locked: [] }) });
    assert.equal(timeout.status, 200, 'AI 失敗不讓請求失敗');
    assert.deepEqual(timeout.body.ai_error, { code: 'AI_TIMEOUT', message: AI_NOTICES.AI_TIMEOUT });
    assert.equal(timeout.body.reply, AI_NOTICES.AI_TIMEOUT);
    assertNoFullStop(timeout.body);
    assert.equal(timeout.body.complete, true, '畫面上的欄位照常驗證');
    setAI({ fill: /** 模擬上游限流。@returns {never} @throws {HttpError} 帶等待秒數的錯誤。 */ () => { throw Object.assign(new HttpError(429, 'RATE_LIMIT_EXCEEDED', '忙碌'), { draftReason: 'RATE_LIMIT_EXCEEDED', retryAfter: 10 }); } });
    const limited = (await call('POST', '/tickets/draft', 'one.it', { subject: '想請特休', message: '再試一次', state: stateOf('leave', {}) })).body;
    assert.deepEqual(limited.ai_error, { code: 'RATE_LIMIT_EXCEEDED', message: AI_NOTICES.RATE_LIMIT_EXCEEDED, retry_after: 10 });
    setAI({ fill: /** 模擬程式錯誤。@returns {never} @throws {TypeError} 非 HttpError。 */ () => { throw new TypeError('程式錯誤'); } });
    assert.equal((await call('POST', '/tickets/draft', 'one.it', { subject: '想請特休', message: '再試一次', state: stateOf('leave', {}) })).status, 500, '非 AI 的程式錯誤仍回 500');
    const before = calls.length;
    const quotaBefore = (await usage.draftUsage('user-one.it')).userRemaining;
    const validation = await call('POST', '/tickets/draft', 'one.it', { subject: '想請特休', state: stateOf('leave', leaveFields()) });
    assert.equal(validation.body.complete, true);
    assert.equal(calls.length, before, '手動編輯驗證不呼叫 AI');
    assert.equal((await usage.draftUsage('user-one.it')).userRemaining, quotaBefore, '手動編輯驗證不扣額度');
    setAI({ fill: filled({}) });
    for (let index = 0; index < quotaBefore; index += 1) await call('POST', '/tickets/draft', 'one.it', { subject: '想請特休', message: '多問幾次', state: stateOf('leave', {}) });
    const exhausted = (await call('POST', '/tickets/draft', 'one.it', { subject: '想請特休', message: '額度用完了嗎', state: stateOf('leave', {}) })).body;
    assert.equal(exhausted.ai_error.code, 'DAILY_QUOTA_EXCEEDED');
    assert.ok(exhausted.ai_error.retry_after > 0);
    assert.equal(calls.length, before + quotaBefore, '額度用完後不呼叫 AI');
    assert.equal((await usage.usage('user-one.it')).userRemaining, env.userDailyLimit, '自動生成不扣需求單判斷額度');
    const logs = captured.join('\n');
    assert.ok(logs.includes('ticket.draft.evaluated'));
    for (const secret of ['secret-subject-xyz', 'secret-message-abc', 'VPN 自昨天起無法連線', '家中']) assert.ok(!logs.includes(secret), `日誌不可包含 ${secret}`);
  }
  await withServer(application, check);
}
test('有 AI 時的自動生成：分類、工具、鎖定欄位、切換類型、失敗與額度', draftWithAI);

/**
 * 驗證帳號欄位的 not_busy_between 與額度檢查：同事期間內已有申請時列為不可選並在驗證時拒絕、本人重疊提醒，以及額度不足時不能完成。
 * @returns {Promise<void>}
 */
async function agentAvailability() {
  const { store, application } = setup('agents.db');
  /** 執行檢查。@param {Function} call 呼叫函式。@returns {Promise<void>} */
  async function check(call) {
    const own = await submitType(call, 'two.it', 'leave', leaveFields({ start_at: '2026-12-01T09:00', end_at: '2026-12-01T18:00', agent: 'three.it' }));
    assert.equal(own.status, 200);
    const busy = (await call('POST', '/tickets/draft', 'one.it', { subject: '請假', state: stateOf('leave', leaveFields()) })).body;
    assert.deepEqual(busy.invalid, [{ key: 'agent', message: '這位同事在此期間也有請假，不能擔任代理人' }]);
    assert.deepEqual(busy.field_options.agent, [{ id: 'two.it', name: 'two.it', available: false, reason: '此期間已有請假' }, { id: 'three.it', name: 'three.it', available: true }]);
    assert.equal(busy.complete, false);
    const other = (await call('POST', '/tickets/draft', 'one.it', { subject: '請假', state: stateOf('leave', leaveFields({ start_at: '2026-12-02T09:30', end_at: '2026-12-02T17:30' })) })).body;
    assert.equal(other.complete, true, '不重疊的期間可以選同一位同事');
    const overlap = (await call('POST', '/tickets/draft', 'two.it', { subject: '請假', state: stateOf('leave', leaveFields({ agent: 'one.it' })) })).body;
    assert.deepEqual(overlap.invalid, [{ key: 'start_at', message: '這段時間已有請假單' }]);
    const spec = types.find('leave').ledgerSpec;
    await store.addLedgerAdjustment(spec, { username: 'one.it', category: '病假', period: 2026, delta: -14100, reason: '測試調減', byUserId: 'user-hr.one', at: new Date(NOW).toISOString() });
    const short = (await call('POST', '/tickets/draft', 'one.it', { subject: '請假', state: stateOf('leave', leaveFields({ leave_type: '病假', agent: 'three.it' })) })).body;
    assert.deepEqual(short.summaries, ['病假剩餘時數：5 小時 0 分鐘 → -2 小時 0 分鐘']);
    assert.deepEqual(short.invalid, [{ key: 'leave_type', message: '假別剩餘時數不足' }]);
    assert.equal(short.complete, false);
    assert.equal(short.rendered_content, null);
    assert.match(short.prompt, /需要修正：假別剩餘時數不足/u);
  }
  await withServer(application, check);
}
test('帳號欄位的期間篩選、本人重疊與額度不足', agentAvailability);

/**
 * 驗證請假單送出與簽核（行為與改版前相同）：route FORM 送人資、保存的表單資料與 ledger 快照、剩餘時數變化、重疊與額度 409、
 * 版本與內容檢查、處理人規則、本人不能簽核、核准時重新檢查額度、不能轉單、取消後時數恢復；以及版本 1 的舊請假單仍計入額度並可簽核。
 * @returns {Promise<void>}
 */
async function leaveSubmission() {
  const { store, usage, judged, application } = setup('submit.db');
  /** 執行檢查。@param {Function} call 呼叫函式。@returns {Promise<void>} */
  async function check(call) {
    const start = await call('GET', '/me/leave-balance', 'one.it');
    assert.equal(start.status, 200);
    assert.deepEqual(start.body, { year: 2026, balances: [
      { leave_type: '事假', granted_minutes: 6720, adjusted_minutes: 0, used_minutes: 0, pending_minutes: 0, remaining_minutes: 6720 },
      { leave_type: '病假', granted_minutes: 14400, adjusted_minutes: 0, used_minutes: 0, pending_minutes: 0, remaining_minutes: 14400 },
      { leave_type: '特休', granted_minutes: 6720, adjusted_minutes: 0, used_minutes: 0, pending_minutes: 0, remaining_minutes: 6720 },
    ] });
    const submitted = await submitType(call, 'one.it', 'leave', leaveFields(), { handler_id: 'hr.one' });
    assert.equal(submitted.status, 200);
    assert.deepEqual(Object.keys(submitted.body), ['ticket_id', 'route', 'department', 'handler', 'form', 'status']);
    assert.equal(submitted.body.route, 'FORM');
    assert.equal(submitted.body.department, '人力資源部');
    assert.deepEqual(submitted.body.handler, { name: 'hr.one' });
    assert.deepEqual(submitted.body.form, { id: 'leave', version: LEAVE_VERSION, name: '請假申請', computed: { minutes: 420 } });
    const saved = await store.find(submitted.body.ticket_id);
    assert.equal(saved.department_id, 'dept-hr-1');
    assert.equal(saved.judgement, null);
    assert.deepEqual(saved.form, { id: 'leave', version: LEAVE_VERSION, name: '請假申請', fields: { applicant: 'one.it', ...leaveFields(), note: '' }, computed: { minutes: 420 },
      labels: { applicant: '請假人', leave_type: '假別', start_at: '請假起始時間', end_at: '請假截止時間', agent: '代理人', note: '備註', minutes: '請假時數' },
      ledger: { category: '特休', amount: 420, period: 2026, start: '2026-12-01T09:30', end: '2026-12-01T17:30' } });
    assert.equal(judged.count, 0, '表單不呼叫 AI 判斷');
    assert.equal((await usage.usage('user-one.it')).userRemaining, env.userDailyLimit, '表單不扣判斷額度');
    const pending = (await call('GET', '/me/leave-balance?year=2026', 'one.it')).body.balances[2];
    assert.deepEqual(pending, { leave_type: '特休', granted_minutes: 6720, adjusted_minutes: 0, used_minutes: 0, pending_minutes: 420, remaining_minutes: 6300 });
    const overlapDraft = (await call('POST', '/tickets/draft', 'one.it', { subject: '請假', state: stateOf('leave', leaveFields({ start_at: '2026-12-01T13:00', agent: 'three.it' })) })).body;
    assert.deepEqual(overlapDraft.invalid, [{ key: 'start_at', message: '這段時間已有請假單' }], '草稿先提醒本人已有重疊的請假單');
    const overlap = await call('POST', '/tickets', 'one.it', { subject: '請假', content: overlapDraft.preview_content, form: { id: 'leave', version: LEAVE_VERSION, fields: leaveFields({ start_at: '2026-12-01T13:00', agent: 'three.it' }) } });
    assert.equal(overlap.status, 409);
    assert.deepEqual(overlap.body.error, { code: 'LEAVE_OVERLAP', message: '這段時間已有請假單' });
    const second = leaveFields({ start_at: '2026-12-02T09:00', end_at: '2026-12-02T18:00', agent: 'three.it' });
    const secondContent = (await call('POST', '/tickets/draft', 'one.it', { subject: '請假', state: stateOf('leave', second) })).body.rendered_content;
    const version = await call('POST', '/tickets', 'one.it', { subject: '請假', content: secondContent, form: { id: 'leave', version: 1, fields: second } });
    assert.equal(version.status, 409);
    assert.equal(version.body.error.code, 'FORM_VERSION_CHANGED', '舊版本的表單不能送出');
    const mismatch = await call('POST', '/tickets', 'one.it', { subject: '請假', content: secondContent.replace('09:00', '10:00'), form: { id: 'leave', version: LEAVE_VERSION, fields: second } });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.message, '需求內容與表單資料不一致，請重新按「自動生成」確認');
    for (const [handlerId, message] of [['fin.one', '指定的處理人不屬於「人力資源部」'], ['nobody.here', '指定的處理人不存在']]) {
      const bad = await call('POST', '/tickets', 'one.it', { subject: '請假', content: secondContent, form: { id: 'leave', version: LEAVE_VERSION, fields: second }, handler_id: handlerId });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.message, message);
    }
    const agentDraft = await call('POST', '/tickets/draft', 'two.it', { subject: '請假', state: stateOf('leave', leaveFields({ agent: 'one.it', start_at: '2026-12-01T10:00' })) });
    assert.deepEqual(agentDraft.body.invalid, [{ key: 'agent', message: '這位同事在此期間也有請假，不能擔任代理人' }]);
    const agentSubmit = await call('POST', '/tickets', 'two.it', { subject: '請假', content: agentDraft.body.preview_content, form: { id: 'leave', version: LEAVE_VERSION, fields: leaveFields({ agent: 'one.it', start_at: '2026-12-01T10:00' }) } });
    assert.equal(agentSubmit.status, 400);
    assert.equal(agentSubmit.body.error.message, '這位同事在此期間也有請假，不能擔任代理人', '送出時在交易內重新檢查');
    await call('POST', '/leave/adjustments', 'hr.two', { username: 'one.it', leave_type: '特休', year: 2026, delta_minutes: -6000, reason: '測試調減' });
    const insufficient = await call('POST', '/tickets', 'one.it', { subject: '請假', content: secondContent, form: { id: 'leave', version: LEAVE_VERSION, fields: second } });
    assert.equal(insufficient.status, 409);
    assert.deepEqual(insufficient.body.error, { code: 'LEAVE_BALANCE_INSUFFICIENT', message: '假別剩餘時數不足' });
    const ticketId = submitted.body.ticket_id;
    const transfer = await call('POST', `/tickets/${ticketId}/transfer`, 'hr.one', { department_id: 'dept-fin-1' });
    assert.equal(transfer.status, 409);
    assert.deepEqual(transfer.body.error, { code: 'FORM_TICKET_LOCKED', message: '請假單不能轉出人資部' });
    assert.equal((await call('POST', `/tickets/${ticketId}/decision`, 'two.it', { action: 'APPROVE' })).status, 403, '不是人資不能簽核');
    await call('POST', '/leave/adjustments', 'hr.two', { username: 'one.it', leave_type: '特休', year: 2026, delta_minutes: -1000, reason: '測試調減到負值' });
    const blocked = await call('POST', `/tickets/${ticketId}/decision`, 'hr.one', { action: 'APPROVE' });
    assert.equal(blocked.status, 409, '核准時重新檢查剩餘時數');
    assert.equal(blocked.body.error.code, 'LEAVE_BALANCE_INSUFFICIENT');
    await call('POST', '/leave/adjustments', 'hr.two', { username: 'one.it', leave_type: '特休', year: 2026, delta_minutes: 7000, reason: '測試補回' });
    const approved = await call('POST', `/tickets/${ticketId}/decision`, 'hr.one', { action: 'APPROVE', comment: '已核准' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.ticket.status, 'APPROVED');
    const used = (await call('GET', '/me/leave-balance', 'one.it')).body.balances[2];
    assert.deepEqual(used, { leave_type: '特休', granted_minutes: 6720, adjusted_minutes: 0, used_minutes: 420, pending_minutes: 0, remaining_minutes: 6300 });
    const hrLeave = await submitType(call, 'hr.one', 'leave', leaveFields({ agent: 'hr.two', start_at: '2026-12-10T09:00', end_at: '2026-12-10T12:00' }));
    assert.equal(hrLeave.status, 200);
    const self = await call('POST', `/tickets/${hrLeave.body.ticket_id}/decision`, 'hr.one', { action: 'APPROVE' });
    assert.equal(self.status, 403);
    assert.equal(self.body.error.message, '不能簽核自己提出的請假單');
    assert.equal((await call('POST', `/tickets/${hrLeave.body.ticket_id}/decision`, 'hr.one', { action: 'REJECT' })).status, 403, '也不能退回自己的請假單');
    assert.equal((await call('POST', `/tickets/${hrLeave.body.ticket_id}/decision`, 'hr.two', { action: 'APPROVE' })).status, 200, '由另一位人資簽核');
    const selfHandler = await submitType(call, 'hr.two', 'leave', leaveFields({ agent: 'hr.one', start_at: '2026-12-11T09:00', end_at: '2026-12-11T12:00' }), { handler_id: 'hr.two' });
    assert.equal(selfHandler.status, 400);
    assert.equal(selfHandler.body.error.message, '指定處理人不能是提單人本人');
    const cancellable = await submitType(call, 'three.it', 'leave', leaveFields({ agent: 'one.it', start_at: '2026-12-15T09:00', end_at: '2026-12-15T18:00' }));
    assert.equal((await call('GET', '/me/leave-balance', 'three.it')).body.balances[2].pending_minutes, 480);
    assert.equal((await call('POST', `/tickets/${cancellable.body.ticket_id}/cancel`, 'three.it', {})).status, 200);
    assert.equal((await call('GET', '/me/leave-balance', 'three.it')).body.balances[2].remaining_minutes, 6720, '取消後時數恢復');
    const rejected = await submitType(call, 'three.it', 'leave', leaveFields({ agent: 'one.it', start_at: '2026-12-15T09:00', end_at: '2026-12-15T18:00' }));
    assert.equal(rejected.status, 200, '取消後同一期間可以重新申請');
    assert.equal((await call('POST', `/tickets/${rejected.body.ticket_id}/decision`, 'hr.one', { action: 'REJECT' })).status, 200);
    assert.equal((await call('GET', '/me/leave-balance', 'three.it')).body.balances[2].remaining_minutes, 6720, '退回的請假單不計時數');
    // 改版前（version 1）保存的請假單：沒有 ledger 快照與 labels，仍計入額度、阻擋重疊並可簽核。
    const legacy = { ticket_id: 'TK-legacy-leave', created_at: '2026-10-20T01:00:00.000Z', updated_at: '2026-10-20T01:00:00.000Z',
      requester: { user_id: 'user-three.it', username: 'three.it', department_id: 'dept-it-1', department_name: '資訊管理一部' }, subject: '舊請假單', content: '舊內容',
      status: 'PENDING', decision: null, history: [], route: 'FORM', department_id: 'dept-hr-1', department_name: '人力資源部', handler: null, judgement: null,
      form: { id: 'leave', version: 1, name: '請假申請', fields: { applicant: 'three.it', leave_type: '事假', start_at: '2026-12-21T09:00', end_at: '2026-12-21T18:00', agent: 'two.it', note: '' }, computed: { minutes: 480, year: 2026 } } };
    await store.insert(legacy);
    assert.equal((await call('GET', '/me/leave-balance', 'three.it')).body.balances[0].pending_minutes, 480, '舊請假單計入待簽核');
    const legacyOverlap = (await call('POST', '/tickets/draft', 'three.it', { subject: '請假', state: stateOf('leave', leaveFields({ agent: 'one.it', start_at: '2026-12-21T13:00', end_at: '2026-12-21T15:00' })) })).body;
    assert.deepEqual(legacyOverlap.invalid, [{ key: 'start_at', message: '這段時間已有請假單' }], '舊請假單阻擋重疊');
    const legacyBusy = (await call('POST', '/tickets/draft', 'one.it', { subject: '請假', state: stateOf('leave', leaveFields({ agent: 'three.it', start_at: '2026-12-21T09:00', end_at: '2026-12-21T10:00' })) })).body;
    assert.deepEqual(legacyBusy.invalid, [{ key: 'agent', message: '這位同事在此期間也有請假，不能擔任代理人' }], '舊請假單也讓同事不能擔任代理人');
    const legacyApproved = await call('POST', '/tickets/TK-legacy-leave/decision', 'hr.one', { action: 'APPROVE' });
    assert.equal(legacyApproved.status, 200, '舊版本的請假單可以簽核');
    assert.equal(legacyApproved.body.ticket.form.version, 1, '保存的版本不變');
    assert.equal((await call('GET', '/me/leave-balance', 'three.it')).body.balances[0].used_minutes, 480);
    assert.equal((await call('GET', '/me/leave-balance?year=26', 'one.it')).status, 400);
    // 請假額度異動紀錄（leave_log）：每次送出、人資調整、簽核、退回與取消各一列，含異動前後的剩餘；被拒絕的送出不留紀錄
    const leaveSpec = types.find('leave').ledgerSpec;
    /** 取出某員工 2026 年的紀錄重點欄位。@param {string} username 帳號。@returns {Promise<Array<Array>>} 紀錄。 */
    const rowsOf = async (username) => (await store.ledgerLog(leaveSpec, { username, period: 2026 })).map(/** 取重點欄位。@param {object} row 紀錄列。@returns {Array} 欄位。 */ (row) =>
      [row.event, row.category, row.amount, row.remaining_before, row.remaining_after, row.by_username, row.comment]);
    assert.deepEqual(await rowsOf('one.it'), [
      ['SUBMITTED', '特休', 420, 6720, 6300, 'one.it', null],
      ['ADJUSTED', '特休', -6000, 6300, 300, 'hr.two', '測試調減'],
      ['ADJUSTED', '特休', -1000, 300, -700, 'hr.two', '測試調減到負值'],
      ['ADJUSTED', '特休', 7000, -700, 6300, 'hr.two', '測試補回'],
      ['APPROVED', '特休', 420, 6300, 6300, 'hr.one', '已核准'],
    ], '送出先扣、調整增減、簽核前後剩餘相同');
    assert.deepEqual(await rowsOf('three.it'), [
      ['SUBMITTED', '特休', 480, 6720, 6240, 'three.it', null],
      ['CANCELLED', '特休', 480, 6240, 6720, 'three.it', null],
      ['SUBMITTED', '特休', 480, 6720, 6240, 'three.it', null],
      ['REJECTED', '特休', 480, 6240, 6720, 'hr.one', null],
      ['APPROVED', '事假', 480, 6240, 6240, 'hr.one', null],
    ], '取消與退回把時數還回去；沒有快照的舊請假單簽核時依定義的欄位記錄');
    const [first] = await store.ledgerLog(leaveSpec, { username: 'one.it', period: 2026 });
    assert.deepEqual([first.ticket_id, first.type_id, first.start_at, first.end_at, first.source], [ticketId, 'leave', '2026-12-01T09:30', '2026-12-01T17:30', 'live']);
    const adjustmentRow = (await store.ledgerLog(leaveSpec, { username: 'one.it' }))[1];
    assert.ok(Number.isInteger(adjustmentRow.adjustment_id) && adjustmentRow.ticket_id === null, '人資調整記錄調整 id、沒有單號');
  }
  await withServer(application, check);
}
test('請假單送出、簽核、轉單鎖定、取消、剩餘時數與舊版請假單', leaveSubmission);

/**
 * 驗證設備申請：數量與日期規則、route FORM 送總務與硬體組、保存的表單資料（沒有 ledger）、總務成員核准、本人不能簽核、
 * 定義允許轉單，以及指定處理人不能是本人。
 * @returns {Promise<void>}
 */
async function equipmentFlow() {
  const { store, application } = setup('equipment.db');
  /** 執行檢查。@param {Function} call 呼叫函式。@returns {Promise<void>} */
  async function check(call) {
    const submitted = await submitType(call, 'one.it', 'equipment', equipmentFields(), { handler_id: 'ga.two' });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.route, 'FORM');
    assert.equal(submitted.body.department, '總務與硬體組');
    assert.deepEqual(submitted.body.form, { id: 'equipment', version: 1, name: '設備申請', computed: {} });
    const saved = await store.find(submitted.body.ticket_id);
    assert.deepEqual(saved.form.fields, { applicant: 'one.it', ...equipmentFields() });
    assert.equal(saved.form.ledger, undefined, '沒有 ledger 的類型不保存額度快照');
    assert.equal(saved.form.labels.quantity, '數量');
    const content = (await call('POST', '/tickets/draft', 'one.it', { subject: '設備', state: stateOf('equipment', equipmentFields()) })).body.rendered_content;
    for (const [fields, message] of [[equipmentFields({ quantity: '0' }), '數量不可小於 1'], [equipmentFields({ quantity: '1.5' }), '數量必須是整數'],
      [equipmentFields({ needed_by: '2026-10-01' }), '需要日期不可早於今天'], [equipmentFields({ location: '' }), '表單還缺少：送交地點']]) {
      const bad = await call('POST', '/tickets', 'one.it', { subject: '設備', content, form: { id: 'equipment', version: 1, fields } });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.message, message);
    }
    assert.equal((await call('POST', `/tickets/${submitted.body.ticket_id}/decision`, 'two.it', { action: 'APPROVE' })).status, 403, '不是總務成員不能簽核');
    const approved = await call('POST', `/tickets/${submitted.body.ticket_id}/decision`, 'ga.one', { action: 'APPROVE', comment: '已安排' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.ticket.status, 'APPROVED');
    const own = await submitType(call, 'ga.one', 'equipment', equipmentFields({ item: '滑鼠' }));
    assert.equal(own.status, 200);
    const self = await call('POST', `/tickets/${own.body.ticket_id}/decision`, 'ga.one', { action: 'APPROVE' });
    assert.equal(self.status, 403);
    assert.equal(self.body.error.message, '不能簽核自己提出的需求單');
    const transferred = await call('POST', `/tickets/${own.body.ticket_id}/transfer`, 'ga.two', { department_id: 'dept-it-1', comment: '改由資訊處理' });
    assert.equal(transferred.status, 200, '定義允許轉單');
    assert.equal(transferred.body.ticket.department_id, 'dept-it-1');
    const selfHandler = await submitType(call, 'ga.two', 'equipment', equipmentFields(), { handler_id: 'ga.two' });
    assert.equal(selfHandler.status, 400);
    assert.equal(selfHandler.body.error.message, '指定處理人不能是提單人本人');
  }
  await withServer(application, check);
}
test('設備申請：欄位規則、送達總務與硬體組、簽核與轉單', equipmentFlow);

/**
 * 驗證一般需求：以 form 送出時依定義的 DEPARTMENT 流程送達對話確認的部門（judgement.source 為 draft、不保存表單、保存 request_type）、
 * 依定義不能由提單人本人簽核或退回但可以轉單，舊版只帶 department_id 的流程照常可用，以及 GET /forms 的形狀。
 * @returns {Promise<void>}
 */
async function generalSubmission() {
  const { store, usage, judged, application } = setup('department.db');
  /** 執行檢查。@param {Function} call 呼叫函式。@returns {Promise<void>} */
  async function check(call) {
    const state = { type_id: 'general', department_id: 'dept-fin-1', handler_id: 'fin.two', fields: { description: '十一月差旅報帳' }, locked: ['department_id', 'handler_id', 'description'] };
    const draft = (await call('POST', '/tickets/draft', 'one.it', { subject: '報帳', state })).body;
    assert.equal(draft.complete, true);
    const viaForm = await call('POST', '/tickets', 'one.it', { subject: '報帳', content: draft.rendered_content, department_id: 'dept-fin-1', handler_id: 'fin.two',
      form: { id: 'general', version: 1, fields: { description: '十一月差旅報帳' } } });
    assert.equal(viaForm.status, 200);
    assert.deepEqual(Object.keys(viaForm.body), ['ticket_id', 'route', 'department', 'handler', 'basis', 'source', 'status']);
    assert.equal(viaForm.body.route, 'DEPARTMENT');
    assert.equal(viaForm.body.source, 'draft');
    const savedForm = await store.find(viaForm.body.ticket_id);
    assert.equal(savedForm.form, undefined, 'DEPARTMENT 流程不保存表單');
    assert.deepEqual(savedForm.request_type, { id: 'general', version: 1 }, '保存需求類型供簽核與轉單規則查詢');
    assert.deepEqual(savedForm.judgement, { source: 'draft', ai_department_id: 'dept-fin-1', confidence_score: null, basis: DRAFT_BASIS, model: null });
    const ownState = { type_id: 'general', department_id: 'dept-it-1', fields: { description: 'VPN 連不上' }, locked: ['department_id', 'description'] };
    const ownDraft = (await call('POST', '/tickets/draft', 'one.it', { subject: 'VPN', state: ownState })).body;
    const own = await call('POST', '/tickets', 'one.it', { subject: 'VPN', content: ownDraft.rendered_content, department_id: 'dept-it-1',
      form: { id: 'general', version: 1, fields: { description: 'VPN 連不上' } } });
    assert.equal(own.status, 200);
    const selfApproval = await call('POST', `/tickets/${own.body.ticket_id}/decision`, 'one.it', { action: 'REJECT' });
    assert.equal(selfApproval.status, 403, '一般需求依定義 not_requester 不能由提單人本人簽核或退回');
    assert.equal(selfApproval.body.error.message, '不能簽核自己提出的需求單');
    assert.equal((await call('POST', `/tickets/${own.body.ticket_id}/transfer`, 'two.it', { department_id: 'dept-fin-1' })).status, 200, '一般需求依定義 transfer 可以轉單');
    assert.equal((await call('POST', `/tickets/${viaForm.body.ticket_id}/decision`, 'fin.one', { action: 'APPROVE' })).status, 200, '送達部門的其他成員可以簽核');
    const noDepartment = await call('POST', '/tickets', 'one.it', { subject: '報帳', content: draft.rendered_content, form: { id: 'general', version: 1, fields: { description: '十一月差旅報帳' } } });
    assert.equal(noDepartment.status, 400);
    assert.match(noDepartment.body.error.message, /需要指定處理部門/u);
    const result = await call('POST', '/tickets', 'one.it', { subject: '報帳', content: '[需求說明]: 報帳\n[處理部門]: 財務部\n[指定處理人]: fin.two', department_id: 'dept-fin-1', handler_id: 'fin.two' });
    assert.equal(result.status, 200);
    assert.equal(result.body.route, 'DEPARTMENT');
    assert.equal(result.body.basis, DRAFT_BASIS);
    assert.equal(judged.count, 0);
    assert.equal((await usage.usage('user-one.it')).userRemaining, env.userDailyLimit);
    for (const [payload, message] of [[{ department_id: 'dept-x' }, '指定的部門不存在'], [{ department_id: 5 }, 'department_id 必須是字串或 null'],
      [{ department_id: 'dept-fin-1', handler_id: 'one.it' }, '指定的處理人不屬於「財務部」'], [{ form: 'leave' }, 'form 必須是物件'], [{ form: { id: 'nope', version: 1 } }, '找不到指定的需求類型']]) {
      const bad = await call('POST', '/tickets', 'one.it', { subject: '報帳', content: '報帳', ...payload });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.message, message);
    }
    const handler = await call('POST', '/tickets', 'one.it', { subject: '報帳', content: '報帳', handler_id: 'fin.one', department_id: '' });
    assert.equal(handler.body.route, 'HANDLER', '空字串的 department_id 視為未提供，維持既有流程');
    assert.equal((await call('POST', '/tickets', 'one.it', { subject: '報帳', content: '報帳' })).status, 500, '沒有 form、department_id 與處理人時仍走 AI 判斷');
    assert.equal(judged.count, 1);
    assert.equal((await call('POST', `/tickets/${result.body.ticket_id}/transfer`, 'fin.one', { department_id: 'dept-it-1' })).status, 200, '非表單需求單仍可轉單');
    const listed = await call('GET', '/forms', 'one.it');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.types.map(/** 取 id 與部門。@param {object} type 類型。@returns {string} 摘要。 */ (type) => `${type.id}:${type.department?.name ?? '-'}`), ['leave:人力資源部', 'attendance:人力資源部', 'vpn:資訊管理一部', 'repair:總務與硬體組', 'equipment:總務與硬體組', 'purchase:採購部', 'general:-']);
    assert.deepEqual(Object.keys(listed.body.types[0]), ['id', 'version', 'name', 'summary', 'department', 'fields', 'computed', 'workflow']);
    assert.deepEqual(listed.body.types.find(/** 找一般需求。@param {{id: string}} type 類型。@returns {boolean} 相符時 true。 */ (type) => type.id === 'general').workflow, { transfer: true, not_requester: true });
  }
  await withServer(application, check);
}
test('一般需求的送出與既有流程相容', generalSubmission);

/**
 * 驗證人資假別時數 API（讀取通用 ledger）：只有人資部門成員可以查詢與調整、參數與本文驗證、員工不存在 404，以及調整結果反映在剩餘時數。
 * @returns {Promise<void>}
 */
async function hrBalances() {
  const { application } = setup('hr.db');
  /** 執行檢查。@param {Function} call 呼叫函式。@returns {Promise<void>} */
  async function check(call) {
    assert.equal((await call('GET', '/leave/balances?username=one.it', 'one.it')).status, 403);
    assert.equal((await call('POST', '/leave/adjustments', 'fin.one', { username: 'one.it', leave_type: '特休', year: 2026, delta_minutes: 60, reason: 'x' })).status, 403);
    const listed = await call('GET', '/leave/balances?username=two.it&year=2027', 'hr.one');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.username, 'two.it');
    assert.equal(listed.body.year, 2027);
    assert.equal(listed.body.balances.length, 3);
    assert.equal((await call('GET', '/leave/balances?username=boss.admin', 'hr.one')).status, 404);
    assert.equal((await call('GET', '/leave/balances', 'hr.one')).status, 400);
    assert.equal((await call('GET', '/leave/balances?username=two.it&year=abcd', 'hr.one')).status, 400);
    const adjusted = await call('POST', '/leave/adjustments', 'hr.one', { username: 'two.it', leave_type: '事假', year: 2026, delta_minutes: 120, reason: ' 補發 ' });
    assert.equal(adjusted.status, 200);
    assert.deepEqual(Object.keys(adjusted.body.adjustment), ['id', 'username', 'leave_type', 'year', 'delta_minutes', 'reason', 'by_user_id', 'at']);
    assert.equal(adjusted.body.adjustment.reason, '補發');
    assert.equal(adjusted.body.adjustment.leave_type, '事假');
    assert.equal(adjusted.body.balances[0].remaining_minutes, 6840);
    assert.equal((await call('GET', '/me/leave-balance', 'two.it')).body.balances[0].adjusted_minutes, 120);
    for (const [body, pattern] of [[{ username: 'two.it', leave_type: '事假', year: 2026, delta_minutes: 0, reason: 'x' }, /delta_minutes/u],
      [{ username: 'two.it', leave_type: '公假', year: 2026, delta_minutes: 1, reason: 'x' }, /leave_type 必須是 事假、病假、特休/u], [{ username: 'boss.admin' }, /username/u]]) {
      const bad = await call('POST', '/leave/adjustments', 'hr.one', body);
      assert.equal(bad.status, 400);
      assert.match(bad.body.error.message, pattern);
    }
    const own = await call('POST', '/leave/adjustments', 'hr.one', { username: 'hr.one', leave_type: '特休', year: 2026, delta_minutes: 6000, reason: '自己加' });
    assert.equal(own.status, 403, '人資不能調整自己的假別時數');
    assert.ok((await call('GET', '/me/leave-balance', 'hr.one')).body.balances.every(/** 被拒絕的調整不寫入。@param {{adjusted_minutes: number}} entry 假別時數。@returns {boolean} 沒有調整時 true。 */ (entry) => entry.adjusted_minutes === 0));
    assert.ok(!captured.join('\n').includes('補發'), '日誌不記錄調整原因');
  }
  await withServer(application, check);
}
test('人資假別時數查詢與調整的權限與驗證', hrBalances);

/**
 * 驗證結構版本 1 的資料庫就地升級到目前版本（4）並保留需求單；帳號表為空時寫入一次測試名冊，之後不再寫入；
 * 通用 ledger 依版本 1 形狀的請假單計算額度與期間重疊；清空需求單時人員資料與調整保留。
 * @returns {Promise<void>}
 */
async function migrationAndSeed() {
  const file = join(scratch, 'v1.db');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE tickets (seq INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL UNIQUE, document TEXT NOT NULL CHECK (json_valid(document))) STRICT;
    CREATE TABLE meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`);
  legacy.pragma(`application_id = ${APPLICATION_ID}`);
  legacy.pragma('user_version = 1');
  legacy.prepare('INSERT INTO tickets (ticket_id, document) VALUES (?, ?)').run('TK-old', JSON.stringify({ ticket_id: 'TK-old', status: 'PENDING' }));
  legacy.close();
  const spec = types.find('leave').ledgerSpec;
  const busySpecs = types.busySpecs();
  const store = createSqliteDataStore({ file, seed: personnel });
  openedStores.push(store);
  assert.equal((await store.find('TK-old')).status, 'PENDING', '升級後保留既有需求單');
  assert.equal((await store.stats()).schemaVersion, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 4);
  assert.equal(store.listAccounts().length, rawAccounts.length, '版本 1 升級後帳號表為空，寫入測試名冊');
  assert.deepEqual(store.findEmployee('one.it'), employees.find('one.it'), 'SQLite 員工資料與記憶體版本形狀相同');
  const balances = await store.ledgerBalances(spec, 'one.it', 2026);
  assert.equal(balances.known, true);
  assert.equal(balances.balances[2].granted, 6720);
  await store.addLedgerAdjustment(spec, { username: 'one.it', category: '特休', period: 2026, delta: -60, reason: '測試', byUserId: 'user-hr.one', at: new Date(NOW).toISOString() });
  await store.insert({ ticket_id: 'TK-leave', status: 'PENDING', requester: { username: 'one.it' }, form: { id: 'leave', fields: { leave_type: '特休', start_at: '2026-12-01T09:00', end_at: '2026-12-01T18:00' }, computed: { minutes: 480, year: 2026 } } });
  assert.equal((await store.ledgerBalances(spec, 'one.it', 2026)).balances[2].remaining, 6720 - 60 - 480);
  /** 在讀取交易內查詢期間內已有申請的帳號。@param {string[]} usernames 帳號。@param {string} startAt 起點。@param {string} endAt 終點。@returns {Promise<string[]>} 帳號。 */
  const busy = async (usernames, startAt, endAt) => [...await store.withLedger(/** 查詢。@param {object} helpers 交易內查詢。@returns {Set<string>} 帳號。 */ (helpers) => helpers.ledgerBusy(busySpecs, usernames, startAt, endAt))];
  assert.deepEqual(await busy(['one.it', 'two.it'], '2026-12-01T17:00', '2026-12-01T19:00'), ['one.it']);
  assert.deepEqual(await busy(['one.it'], '2026-12-01T18:00', '2026-12-01T19:00'), [], '期間相接不算重疊');
  store.close();
  const changed = { accounts: [...rawAccounts, { username: 'new.person', department_id: 'dept-hr-1' }],
    employees: [...rawEmployees.map(/** 改變名冊額度。@param {object} item 員工。@returns {object} 原始形狀。 */ (item) => ({ ...item, entitlements: { 2026: { 特休: 1 }, 2028: { 特休: 600 } } })),
      { username: 'new.person', display_name: '測試員工新', employee_no: 'T-9099', hire_date: '2024-01-01', entitlements: {} }] };
  const reopened = createSqliteDataStore({ file, seed: changed });
  openedStores.push(reopened);
  const prepared = await reopened.prepare({ legacyFile: join(scratch, 'missing-legacy.json') });
  assert.deepEqual(prepared.seeded, { accounts: 0, employees: 0, entitlements: 0 }, '帳號表不是空的時永遠不再寫入名冊');
  assert.equal(reopened.findAccount('new.person'), null);
  const after = (await reopened.ledgerBalances(spec, 'one.it', 2026)).balances[2];
  assert.equal(after.granted, 6720);
  assert.equal(after.adjusted, -60);
  assert.equal((await reopened.ledgerBalances(spec, 'one.it', 2028)).balances[2].granted, 0, '不補上名冊中的新年度');
  assert.deepEqual((await reopened.ledgerLog(spec)).map(/** 取事件與前後剩餘。@param {object} row 紀錄列。@returns {Array} 欄位。 */ (row) => [row.event, row.remaining_before, row.remaining_after]),
    [['ADJUSTED', 6720, 6660]], '人資調整記錄前後剩餘；沒有提供 ledgerSpecOf 的寫入不記錄');
  assert.equal(await reopened.clear(), 2);
  assert.equal((await reopened.ledgerBalances(spec, 'one.it', 2026)).balances[2].remaining, 6660, '清空需求單只刪需求單，額度與調整保留');
  assert.equal((await reopened.ledgerLog(spec)).length, 1, '清空需求單時保留人資調整的紀錄');
  assert.equal((await reopened.ledgerBalances(spec, 'nobody.here', 2026)).known, false);
}
test('結構版本 1 升級到最新版本、全新帳號表才寫入名冊、通用 ledger 讀取舊請假單', migrationAndSeed);

/**
 * 驗證結構版本 3 升級到 4 時以既有資料回填請假額度異動紀錄：需求單歷程（送出、簽核、退回）與人資調整依時間排序重播，
 * 每列記錄異動前後的剩餘；沒有快照的請假版本 1 舊單依當時的欄位回填；轉單與非請假的單不記錄；最後的剩餘與即時計算一致
 * @returns {Promise<void>}
 */
async function ledgerLogBackfill() {
  const file = join(scratch, 'backfill.db');
  const store = createSqliteDataStore({ file, seed: personnel });
  /** 組一張請假單。@param {string} id 單號。@param {object} form 表單。@param {string} status 狀態。@param {Array<object>} history 歷程。@returns {object} 需求單。 */
  const leaveTicket = (id, form, status, history) => ({ ticket_id: id, status, requester: { username: 'one.it' }, form: { id: 'leave', ...form }, history });
  await store.insert(leaveTicket('TK-a', { ledger: { category: '特休', amount: 420, period: 2026, start: '2026-12-01T09:30', end: '2026-12-01T17:30' } }, 'APPROVED', [
    { at: '2026-11-01T01:00:00.000Z', event: 'SUBMITTED', by_username: 'one.it' },
    { at: '2026-11-01T05:00:00.000Z', event: 'TRANSFERRED', by_username: 'hr.one' },
    { at: '2026-11-02T01:00:00.000Z', event: 'APPROVED', by_username: 'hr.one', comment: '同意' }]));
  await store.insert(leaveTicket('TK-b', { ledger: { category: '特休', amount: 480, period: 2026, start: '2026-12-02T09:00', end: '2026-12-02T18:00' } }, 'REJECTED', [
    { at: '2026-11-03T01:00:00.000Z', event: 'SUBMITTED', by_username: 'one.it' },
    { at: '2026-11-04T01:00:00.000Z', event: 'REJECTED', by_username: 'hr.two', comment: '期間有誤' }]));
  await store.insert(leaveTicket('TK-c', { version: 1, fields: { leave_type: '事假', start_at: '2026-12-21T09:00', end_at: '2026-12-21T13:00' }, computed: { minutes: 240, year: 2026 } }, 'PENDING', [
    { at: '2026-11-05T01:00:00.000Z', event: 'SUBMITTED', by_username: 'one.it' }]));
  await store.insert({ ticket_id: 'TK-other', status: 'APPROVED', requester: { username: 'one.it' }, form: { id: 'equipment', fields: {} }, history: [{ at: '2026-11-01T02:00:00.000Z', event: 'SUBMITTED' }] });
  store.close();
  const raw = new Database(file);
  raw.prepare('INSERT INTO leave_adjustments (username, leave_type, year, delta_minutes, reason, by_user_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('one.it', '特休', 2026, -60, '補登調整', 'user-hr.two', '2026-11-02T12:00:00.000Z');
  raw.exec('DROP TABLE leave_log');
  raw.pragma('user_version = 3');
  raw.close();
  const upgraded = createSqliteDataStore({ file, seed: personnel });
  openedStores.push(upgraded);
  assert.equal((await upgraded.stats()).schemaVersion, 4);
  const spec = types.find('leave').ledgerSpec;
  const rows = await upgraded.ledgerLog(spec, { username: 'one.it', period: 2026 });
  assert.deepEqual(rows.map(/** 取重點欄位。@param {object} row 紀錄列。@returns {Array} 欄位。 */ (row) => [row.event, row.category, row.amount, row.remaining_before, row.remaining_after, row.by_username, row.comment, row.ticket_id]), [
    ['SUBMITTED', '特休', 420, 6720, 6300, 'one.it', null, 'TK-a'],
    ['APPROVED', '特休', 420, 6300, 6300, 'hr.one', '同意', 'TK-a'],
    ['ADJUSTED', '特休', -60, 6300, 6240, 'hr.two', '補登調整', null],
    ['SUBMITTED', '特休', 480, 6240, 5760, 'one.it', null, 'TK-b'],
    ['REJECTED', '特休', 480, 5760, 6240, 'hr.two', '期間有誤', 'TK-b'],
    ['SUBMITTED', '事假', 240, 6720, 6480, 'one.it', null, 'TK-c'],
  ]);
  assert.ok(rows.every(/** 是否為回填。@param {object} row 紀錄列。@returns {boolean} 回填時 true。 */ (row) => row.source === 'backfill'));
  assert.deepEqual([rows[0].start_at, rows[0].end_at, rows[5].start_at], ['2026-12-01T09:30', '2026-12-01T17:30', '2026-12-21T09:00']);
  const balances = (await upgraded.ledgerBalances(spec, 'one.it', 2026)).balances;
  assert.equal(balances[2].remaining, 6240, '回填的最後剩餘與即時計算一致（特休）');
  assert.equal(balances[0].remaining, 6480, '回填的最後剩餘與即時計算一致（事假）');
}
test('結構版本 3 升級到 4 時回填請假額度異動紀錄', ledgerLogBackfill);

/**
 * 驗證完整 app 已掛載端點：需求類型清單、自動生成（未登入 401、管理員 403、沒有金鑰時 200 並回 ai_error）、本人假別時數與人資端點的權限。
 * @returns {Promise<void>}
 */
async function mountedEndpoints() {
  const server = app.listen(0, '127.0.0.1');
  /** 等待監聽成功。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function listening(resolve, reject) { server.once('listening', resolve); server.once('error', reject); }
  await new Promise(listening);
  const base = `http://127.0.0.1:${server.address().port}`;
  /** 以實際帳號服務的帳號取得標頭。@param {string} username 帳號。@returns {Promise<object>} 標頭。 */
  async function headersFor(username) {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${(await authService.issue(accountService.find(username))).token}` };
  }
  try {
    const user = await headersFor('racky.huang');
    const admin = await headersFor('alex.admin');
    const formsResponse = await fetch(`${base}/api/forms`, { headers: user });
    assert.equal(formsResponse.status, 200);
    assert.equal(formsResponse.headers.get('Cache-Control'), 'no-store');
    const { types: realTypes } = await formsResponse.json();
    assert.deepEqual(realTypes.map(/** 取 id。@param {{id: string}} type 類型。@returns {string} id。 */ (type) => type.id), ['leave', 'attendance', 'vpn', 'repair', 'equipment', 'purchase', 'general']);
    assert.deepEqual(realTypes.find(/** 找設備申請。@param {{id: string}} type 類型。@returns {boolean} 相符時 true。 */ (type) => type.id === 'equipment').department, { id: 'dept-ga-1', name: '總務與硬體組' });
    assert.equal((await fetch(`${base}/api/forms`)).status, 401);
    assert.equal((await fetch(`${base}/api/forms`, { headers: admin })).status, 403);
    assert.equal((await fetch(`${base}/api/tickets/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"subject":"x"}' })).status, 401);
    assert.equal((await fetch(`${base}/api/tickets/draft`, { method: 'POST', headers: admin, body: '{"subject":"x"}' })).status, 403);
    const draft = await fetch(`${base}/api/tickets/draft`, { method: 'POST', headers: user, body: JSON.stringify({ subject: '下週想請病假' }) });
    assert.equal(draft.status, 200);
    const body = await draft.json();
    assert.equal(body.type.id, 'leave');
    assert.equal(body.ai_error.code, 'AI_UNAVAILABLE');
    assert.deepEqual(body.field_options.agent.map(/** 取帳號。@param {{id: string}} option 選項。@returns {string} 帳號。 */ (option) => option.id), ['kevin.ho'], '資訊管理一部的同部門同事');
    assert.ok(body.reply.startsWith('racky.huang 你好，這邊已經收到你想要請假的需求'));
    const balance = await fetch(`${base}/api/me/leave-balance`, { headers: user });
    assert.equal(balance.status, 200);
    assert.equal((await balance.json()).balances[2].granted_minutes, 6720, '全新資料庫寫入示範名冊的額度');
    assert.equal((await fetch(`${base}/api/leave/balances?username=racky.huang`, { headers: user })).status, 403, '不是人資');
    const hr = await headersFor('emily.wu');
    assert.equal((await fetch(`${base}/api/leave/balances?username=racky.huang`, { headers: hr })).status, 200);
    assert.equal((await fetch(`${base}/api/me/leave-balance`, { method: 'POST', headers: user, body: '{}' })).status, 404);
  } finally { server.closeAllConnections(); server.close(); }
}
test('完整 app 掛載需求類型清單、自動生成與假別時數端點', mountedEndpoints);

/**
 * 組出測試用的「加班申請」定義（全部為假資料）：固定送人資部、自帶加班日曆（平日 18:00～22:00，以 30 分鐘為單位）、
 * 以 work_minutes 計算加班時數，並有一個沿用 colleagues 工具、排除該期間已請假同事的「同行同事」欄位。
 * 這份定義只存在於暫存目錄，用來證明新增需求類型不需要修改任何程式碼。
 * @returns {object} 加班申請的定義檔內容。
 */
function overtimeDefinition() {
  return {
    id: 'overtime', version: 1, name: '加班申請', department_id: 'dept-hr-1',
    ai: { description: '申請平日下班後的加班：需要加班起訖時間、事由，可選同行同事。', examples: ['今晚要加班'], greeting: '{username} 你好，請告訴我加班的起訖時間與事由。',
      ask_order: ['ot_start', 'ot_end', 'reason'], tools: ['colleagues', 'department_directory'] },
    ot_calendar: { timezone_offset: '+08:00', work_windows: [['18:00', '22:00']], workdays: [1, 2, 3, 4, 5], holidays: { 2026: [], 2027: [] },
      unit_minutes: 30, min_minutes: 30, max_days: 1, same_year: true },
    fields: [
      { key: 'worker', label: '加班人', type: 'self' },
      { key: 'ot_start', label: '加班起始時間', type: 'datetime', required: true },
      { key: 'ot_end', label: '加班截止時間', type: 'datetime', required: true, rules: { after: 'ot_start' } },
      { key: 'reason', label: '加班事由', type: 'text', required: true, max_length: 100 },
      { key: 'buddy', label: '同行同事', type: 'account', options_tool: 'colleagues',
        filters: { same_department: true, not_self: true, active: true, not_busy_between: ['ot_start', 'ot_end'] },
        unavailable_message: '這位同事在此期間不在公司', unavailable_reason: '此期間不在公司' },
    ],
    computations: [{ key: 'ot_minutes', label: '加班時數', capability: 'work_minutes', args: { start: 'ot_start', end: 'ot_end', calendar: 'ot_calendar' }, display: 'hours_minutes' }],
    render: { lines: ['[加班人]: {worker}', '[加班日期]: {ot_start|date}', '[加班時段]: {ot_start|time}～{ot_end|time}', '[加班時數]: {ot_minutes|hours_minutes}',
      '[加班事由]: {reason}', '[同行同事]: {buddy|default:無}'] },
    workflow: { route: 'FORM', approver: { department: 'definition', not_requester: true, message: '不能簽核自己提出的加班單' }, transfer: false,
      transfer_error: { code: 'OVERTIME_TICKET_LOCKED', message: '加班單不能轉出人資部' } },
  };
}

/**
 * 驗證只放入一個 JSON 定義檔並在目錄加一筆，就能完整使用新的需求類型（不改任何程式碼）：
 * 1. 把實際的定義檔複製到暫存目錄，加入 overtime.json 與 _catalog.json 的目錄項目，再以 loadRequestTypes({ dir }) 載入；
 * 2. GET /forms 列出新類型（含欄位、計算名稱與 workflow）；
 * 3. 沒有 AI 時以主題關鍵字選到新類型並使用定義的招呼語；
 * 4. 手動編輯驗證：計算加班時數（依定義的日曆與單位進位）、同行同事排除該期間已請假的同事（跨類型使用請假單的期間）、欄位規則；
 * 5. 送出後依定義送達人資部並保存表單；轉單依 transfer_error 拒絕、非送達部門不能簽核、提單人本人不能簽核、其他人資可以核准。
 * @returns {Promise<void>}
 */
async function newTypeFromJsonFile() {
  const dir = join(scratch, 'request-types-with-overtime');
  cpSync(DEFAULT_TYPES_DIR, dir, { recursive: true });
  const catalog = JSON.parse(readFileSync(join(dir, CATALOG_FILE), 'utf8'));
  catalog.types.splice(-1, 0, { id: 'overtime', file: 'overtime.json', name: '加班申請', summary: '平日下班後的加班申請。', keywords: ['加班'] });
  writeFileSync(join(dir, CATALOG_FILE), JSON.stringify(catalog, null, 2));
  writeFileSync(join(dir, 'overtime.json'), JSON.stringify(overtimeDefinition(), null, 2));
  const registry = loadRequestTypes({ dir, departments });
  assert.deepEqual(registry.ids(), ['leave', 'attendance', 'vpn', 'repair', 'equipment', 'purchase', 'overtime', 'general']);
  const { application } = setup('overtime.db', { registry });
  /** 執行檢查。@param {Function} call 呼叫函式。@returns {Promise<void>} */
  async function check(call) {
    const listed = (await call('GET', '/forms', 'one.it')).body.types.find(/** 找加班類型。@param {{id: string}} type 類型。@returns {boolean} 相符時 true。 */ (type) => type.id === 'overtime');
    assert.deepEqual(listed.department, { id: 'dept-hr-1', name: '人力資源部' });
    assert.deepEqual(listed.fields.map(/** 取欄位 key。@param {{key: string}} field 欄位。@returns {string} key。 */ (field) => field.key), ['worker', 'ot_start', 'ot_end', 'reason', 'buddy']);
    assert.deepEqual(listed.computed, [{ key: 'ot_minutes', label: '加班時數', display: 'hours_minutes' }]);
    assert.deepEqual(listed.workflow, { transfer: false, not_requester: true });
    // two.it 在 12/1～12/2 整段請假（已送出的請假單），之後不能當同行同事。
    const leave = await submitType(call, 'two.it', 'leave', leaveFields({ agent: 'three.it', start_at: '2026-12-01T09:00', end_at: '2026-12-02T18:00' }));
    assert.equal(leave.status, 200);
    const first = (await call('POST', '/tickets/draft', 'one.it', { subject: '今晚要加班' })).body;
    assert.equal(first.type.id, 'overtime', '沒有 AI 時依目錄的 keywords 選到新類型');
    assert.ok(first.reply.startsWith('one.it 你好，請告訴我加班的起訖時間與事由\n'), '定義檔的招呼語含「。」時，回應出口依共用標點規範去掉');
    assertNoFullStop(first);
    assert.deepEqual(first.missing, ['ot_start', 'ot_end', 'reason']);
    /**
     * 組出手動編輯驗證的加班 state（全部欄位鎖定）。
     * @param {Record<string, string>} fields 欄位值。
     * @returns {object} state。
     */
    const stateWith = (fields) => ({ type_id: 'overtime', department_id: 'dept-hr-1', handler_id: null, fields, locked: Object.keys(fields) });
    const fields = { ot_start: '2026-12-01T18:00', ot_end: '2026-12-01T20:10', reason: '上線前驗證', buddy: 'two.it' };
    const busy = (await call('POST', '/tickets/draft', 'one.it', { subject: '加班', state: stateWith(fields) })).body;
    assert.deepEqual(busy.field_options.buddy, [{ id: 'two.it', name: 'two.it', available: false, reason: '此期間不在公司' }, { id: 'three.it', name: 'three.it', available: true }]);
    assert.deepEqual(busy.invalid, [{ key: 'buddy', message: '這位同事在此期間不在公司' }]);
    assert.deepEqual(busy.computed, [{ key: 'ot_minutes', label: '加班時數', value: 150, text: '2 小時 30 分鐘' }], '130 分鐘依 30 分鐘單位進位');
    const invalid = (await call('POST', '/tickets/draft', 'one.it', { subject: '加班', state: stateWith({ ...fields, ot_end: '2026-12-01T17:00', buddy: '' }) })).body;
    assert.equal(invalid.complete, false);
    assert.equal(invalid.invalid[0].key, 'ot_end');
    const okFields = { ...fields, buddy: 'three.it' };
    const ok = (await call('POST', '/tickets/draft', 'one.it', { subject: '加班', state: stateWith(okFields) })).body;
    assert.equal(ok.complete, true, ok.prompt);
    assert.equal(ok.rendered_content, '[加班人]: one.it\n[加班日期]: 2026-12-01（週二）\n[加班時段]: 18:00～20:10\n[加班時數]: 2 小時 30 分鐘\n[加班事由]: 上線前驗證\n[同行同事]: three.it');
    const submitted = await call('POST', '/tickets', 'one.it', { subject: '加班', content: ok.rendered_content, form: { id: 'overtime', version: 1, fields: okFields } });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.route, 'FORM');
    assert.equal(submitted.body.department, '人力資源部');
    assert.deepEqual(submitted.body.form, { id: 'overtime', version: 1, name: '加班申請', computed: { ot_minutes: 150 } });
    const ticketId = submitted.body.ticket_id;
    const transfer = await call('POST', `/tickets/${ticketId}/transfer`, 'hr.one', { department_id: 'dept-fin-1' });
    assert.equal(transfer.status, 409);
    assert.deepEqual(transfer.body.error, { code: 'OVERTIME_TICKET_LOCKED', message: '加班單不能轉出人資部' });
    assert.equal((await call('POST', `/tickets/${ticketId}/decision`, 'ga.one', { action: 'APPROVE' })).status, 403, '不是送達部門不能簽核');
    const approved = await call('POST', `/tickets/${ticketId}/decision`, 'hr.one', { action: 'APPROVE' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.ticket.status, 'APPROVED');
    assert.equal(approved.body.ticket.form.labels.ot_minutes, '加班時數', '保存的表單帶有欄位與計算名稱');
    const ownFields = { ...okFields, buddy: 'hr.two' };
    const own = (await call('POST', '/tickets/draft', 'hr.one', { subject: '加班', state: stateWith(ownFields) })).body;
    assert.equal(own.complete, true, own.prompt);
    const mine = await call('POST', '/tickets', 'hr.one', { subject: '加班', content: own.rendered_content, form: { id: 'overtime', version: 1, fields: ownFields } });
    assert.equal(mine.status, 200);
    const self = await call('POST', `/tickets/${mine.body.ticket_id}/decision`, 'hr.one', { action: 'APPROVE' });
    assert.equal(self.status, 403);
    assert.equal(self.body.error.message, '不能簽核自己提出的加班單');
    assert.equal((await call('POST', `/tickets/${mine.body.ticket_id}/decision`, 'hr.two', { action: 'APPROVE' })).status, 200, '由另一位人資簽核');
  }
  await withServer(application, check);
}
test('只放入 JSON 定義檔與目錄項目就能完整使用新的需求類型（不改程式碼）', newTypeFromJsonFile);
