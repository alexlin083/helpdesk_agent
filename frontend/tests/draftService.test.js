import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDraft, normalizeDraftResponse, normalizeRequestType, normalizeRequestTypes, loadRequestTypes, prepareHistory, prepareState, DRAFT_LIMITS, DESCRIPTION_FIELD, DESCRIPTION_MAX } from '../src/services/draftService.js';
import { MESSAGES, DRAFT_REQUEST_TIMEOUT_MS } from '../src/services/ticketService.js';
import { leaveResponse, completeLeaveResponse, generalResponse, equipmentResponse, RENDERED, HR, IT, GA, LEAVE_TYPE, EQUIPMENT_TYPE, LEAVE_MINUTES, LEAVE_SUMMARY } from './helpers/draftFixtures.js';

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.sessionStorage;
/** 建立有效的前端登入狀態（假帳號、假憑證），不呼叫後端。@returns {void} */
function setupSession() {
  const session = { user: { username: 'tina.test', userID: 'user-tina.test', department: { id: 'dept-hr-test', name: '測試人資部' } }, token: 'test-token', expiresAt: Date.now() + 60000 };
  globalThis.sessionStorage = {
    /** 讀取工作階段。@returns {string} 序列化登入資料。 */
    getItem() { return JSON.stringify(session); },
  };
}
/** 還原 fetch 與儲存體。@returns {void} */
function restore() { globalThis.fetch = originalFetch; globalThis.sessionStorage = originalStorage; }
test.beforeEach(setupSession);
test.afterEach(restore);

/**
 * 建立記錄請求本文並回傳固定回應的 fetch 替身。
 * @param {object} reply 要回傳的 JSON。
 * @param {Array<object>} bodies 記錄本文的陣列。
 * @returns {Function} fetch 替身。
 */
function recordingFetch(reply, bodies) {
  /**
   * 檢查網址與方法、記錄本文並回傳 JSON。
   * @param {string} url 網址。
   * @param {RequestInit} options 設定。
   * @returns {Promise<Response>} 回應。
   */
  async function fakeFetch(url, options) {
    assert.equal(url, 'http://localhost:3000/api/tickets/draft');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    bodies.push(JSON.parse(options.body));
    return Response.json(reply);
  }
  return fakeFetch;
}

/**
 * 驗證三種呼叫的本文：第一次只帶主題；聊天帶訊息、對話紀錄與面板狀態；驗證只帶面板狀態。主題與訊息去除首尾空白。
 * @returns {Promise<void>}
 */
async function requestBodies() {
  const bodies = [];
  globalThis.fetch = recordingFetch(leaveResponse(), bodies);
  const state = { type_id: 'leave', department_id: HR.id, handler_id: '', fields: { leave_type: '事假', agent: 3 }, locked: ['agent', 'agent', ''] };
  await requestDraft({ subject: ' 我要請假 ' });
  await requestDraft({ subject: '我要請假', message: ' 12/1 請事假 ', history: [{ role: 'assistant', text: '你好' }, { role: 'system', text: '略過' }], state });
  await requestDraft({ subject: '我要請假', message: '   ', state });
  assert.deepEqual(bodies[0], { subject: '我要請假' });
  const cleanState = { type_id: 'leave', department_id: HR.id, handler_id: null, fields: { leave_type: '事假' }, locked: ['agent'] };
  assert.deepEqual(bodies[1], { subject: '我要請假', message: '12/1 請事假', history: [{ role: 'assistant', text: '你好' }], state: cleanState });
  assert.deepEqual(bodies[2], { subject: '我要請假', state: cleanState }, '空白訊息視為只驗證，不送 message');
}
test('草稿請求三種呼叫的本文', requestBodies);

/**
 * 驗證對話紀錄只送最近 6 則、每則截到 300 字，本文超過 16 KB 時從最舊的紀錄開始捨棄。
 * @returns {Promise<void>}
 */
async function historyLimits() {
  const turns = [];
  for (let index = 0; index < 9; index += 1) turns.push({ role: index % 2 ? 'user' : 'assistant', text: `第 ${index} 則` });
  const trimmed = prepareHistory(turns);
  assert.equal(trimmed.length, DRAFT_LIMITS.historyTurns);
  assert.equal(trimmed[0].text, '第 3 則');
  assert.equal(prepareHistory([{ role: 'user', text: ` ${'😀'.repeat(400)} ` }])[0].text, '😀'.repeat(300));
  assert.deepEqual(prepareHistory('nope'), []);
  const bodies = [];
  globalThis.fetch = recordingFetch(leaveResponse(), bodies);
  const long = [];
  for (let index = 0; index < 6; index += 1) long.push({ role: 'user', text: '字'.repeat(300) });
  const fields = { note: '字'.repeat(2000), extra: '字'.repeat(2000) };
  await requestDraft({ subject: '我要請假', message: '好', history: long, state: { fields } });
  assert.ok(new TextEncoder().encode(JSON.stringify(bodies[0])).length <= DRAFT_LIMITS.bodyBytes);
  assert.ok(bodies[0].history.length < 6, '超過 16 KB 時捨棄較舊的紀錄');
}
test('對話紀錄的則數、字數與本文大小限制', historyLimits);

/**
 * 驗證前端先擋下無效的主題、訊息與過大的本文，不送出請求。
 * @returns {Promise<void>}
 */
async function localValidation() {
  let calls = 0;
  /** 計算送出次數。@returns {Promise<Response>} 回應。 */
  async function fakeFetch() { calls += 1; return Response.json(leaveResponse()); }
  globalThis.fetch = fakeFetch;
  await assert.rejects(requestDraft({ subject: '  ' }), { code: 'INVALID_PAYLOAD', message: '請先填寫主題' });
  await assert.rejects(requestDraft({ subject: 'a'.repeat(101) }), { code: 'INVALID_PAYLOAD', message: '主題最多 100 字，目前 101 字' });
  await assert.rejects(requestDraft({ subject: 'a', message: '😀'.repeat(301) }), { code: 'INVALID_PAYLOAD', message: '訊息最多 300 字，目前 301 字' });
  await assert.rejects(requestDraft({ subject: 'a', state: { fields: { a: '字'.repeat(6000) } } }), { code: 'INVALID_PAYLOAD', message: MESSAGES.tooLarge });
  assert.equal(calls, 0);
}
test('草稿請求的前端驗證先於網路', localValidation);

/**
 * 驗證草稿 HTTP 錯誤保留狀態碼、代碼與倒數秒數（限流倒數、額度不倒數、503 顯示後端訊息）。
 * @returns {Promise<void>}
 */
async function httpErrors() {
  const replies = [
    [429, { error: { code: 'RATE_LIMITED', message: '請求太頻繁', retry_after: 12 } }],
    [429, { error: { code: 'DAILY_QUOTA_EXCEEDED', retry_after: 999 } }],
    [503, { error: { code: 'DATABASE_UNAVAILABLE', message: '資料庫暫時無法使用' } }],
  ];
  /** 依序回傳錯誤。@returns {Promise<Response>} 錯誤回應。 */
  async function fakeFetch() { const [status, body] = replies.shift(); return Response.json(body, { status }); }
  globalThis.fetch = fakeFetch;
  await assert.rejects(requestDraft({ subject: 'a' }), { status: 429, code: 'RATE_LIMITED', retryAfter: 12, message: '請求太頻繁' });
  await assert.rejects(requestDraft({ subject: 'a' }), { status: 429, code: 'DAILY_QUOTA_EXCEEDED', retryAfter: 0, message: MESSAGES.quota });
  await assert.rejects(requestDraft({ subject: 'a' }), { status: 503, message: '資料庫暫時無法使用' });
}
test('草稿請求的 HTTP 錯誤對應', httpErrors);

/**
 * 驗證固定部門類型回應的整理：欄位、部門（來源 system 視為固定）、欄位候選（不可選時保留原因，未標示 available 視為可選）、
 * 計算結果與摘要、使用的工具，以及完成時才保留整理好的內容。
 * @returns {void}
 */
function typedNormalization() {
  const pending = normalizeDraftResponse(leaveResponse({ field_options: { agent: [{ id: 'a', name: ' a ' }, { id: 'b', name: 'b', available: false, reason: ' 請假中 ' }, { id: 'a', name: 'dup' }, { name: 'x' }],
    unknown: [{ id: 'z', name: 'z' }], note: 'not-a-list' } }));
  assert.equal(pending.type.id, 'leave');
  assert.equal(pending.type.version, 2);
  assert.deepEqual(pending.fields.map(keyOf), ['applicant', 'leave_type', 'start_at', 'end_at', 'agent', 'note']);
  assert.deepEqual(pending.department, HR);
  assert.equal(pending.departmentFixed, true, '處理部門來源為 system 時視為固定');
  assert.deepEqual(pending.fieldOptions, { agent: [{ id: 'a', name: 'a', available: true, reason: '' }, { id: 'b', name: 'b', available: false, reason: '請假中' }] });
  assert.equal(pending.complete, false);
  assert.equal(pending.rendered, null);
  assert.equal(pending.aiAvailable, true);
  assert.equal(pending.aiError, null);
  const done = normalizeDraftResponse(completeLeaveResponse());
  assert.equal(done.complete, true);
  assert.equal(done.rendered, RENDERED);
  assert.deepEqual(done.computed, [LEAVE_MINUTES]);
  assert.deepEqual(done.summaries, [LEAVE_SUMMARY]);
  assert.deepEqual(done.toolsUsed, ['colleagues', 'my_leave_balance']);
  assert.equal(done.sources.leave_type, 'ai');
  assert.equal(normalizeDraftResponse(completeLeaveResponse({ department: null, sources: {} })).complete, false, '沒有處理部門不能套用');
  assert.equal(normalizeDraftResponse(completeLeaveResponse({ missing: ['agent'] })).complete, false);
  assert.equal(normalizeDraftResponse(completeLeaveResponse({ invalid: [{ key: 'agent', message: '這位同事在此期間也有請假，不能擔任代理人' }] })).complete, false);
  assert.equal(normalizeDraftResponse(completeLeaveResponse({ rendered_content: ' ' })).complete, false);
  const extra = normalizeDraftResponse(leaveResponse({ values: { leave_type: 3, unknown: 'x' }, sources: { leave_type: 'robot' }, missing: ['unknown', 'agent', 'agent', 'department_id'],
    invalid: [{ key: 'unknown', message: 'x' }, { key: 'handler_id', message: ' 不屬於部門 ' }, { key: 'agent' }],
    computed: [{ key: 'k', label: ' 名稱 ', value: 5 }, { key: 'x' }, { key: 'y', label: 'Y', value: {}, text: ' 文字 ' }], summaries: [' 一行 ', '', 3], tools_used: ['a', 1] }));
  assert.equal(extra.values.leave_type, '3', '數字值轉成文字');
  assert.equal(Object.hasOwn(extra.values, 'unknown'), false);
  assert.equal(Object.hasOwn(extra.sources, 'leave_type'), false);
  assert.deepEqual(extra.missing, ['agent', 'department_id']);
  assert.deepEqual(extra.invalid, [{ key: 'handler_id', message: '不屬於部門' }]);
  assert.deepEqual(extra.computed, [{ key: 'k', label: '名稱', value: 5, text: '5' }, { key: 'y', label: 'Y', value: null, text: '文字' }]);
  assert.deepEqual(extra.summaries, ['一行']);
  assert.deepEqual(extra.toolsUsed, ['a']);
  const equipment = normalizeDraftResponse(equipmentResponse({ department: null }));
  assert.equal(equipment.departmentFixed, true, 'type.department 有值時視為固定');
  assert.deepEqual(equipment.department, GA, '回應沒有部門時採用類型的固定部門');
  const legacy = normalizeDraftResponse({ ...leaveResponse(), type: undefined, form: LEAVE_TYPE });
  assert.equal(legacy.type.id, 'leave', '也接受舊名稱 form');
}
/**
 * 取出欄位代號。
 * @param {{key: string}} field 欄位。
 * @returns {string} 欄位代號。
 */
function keyOf(field) { return field.key; }
test('需求類型草稿回應的整理與完成條件', typedNormalization);

/**
 * 驗證沒有固定部門的類型、AI 無法使用的代碼與文字長度上限、type 為 null 時的備用欄位，以及無法辨識的回應。
 * @returns {void}
 */
function generalNormalization() {
  const result = normalizeDraftResponse(generalResponse({ ai_available: false, ai_error: { code: 'AI_UNAVAILABLE', message: ' 目前 AI 助手尚未啟用 ', retry_after: 0 }, reply: '字'.repeat(500), intent: '意'.repeat(90),
    department_options: [HR, IT, { id: '' }, HR], handler: { id: 'u-1', name: ' hana.test ' }, field_options: { description: [{ id: 'x', name: 'x' }] } }));
  assert.equal(result.type.id, 'general');
  assert.equal(result.departmentFixed, false);
  assert.deepEqual(result.values, { description: '' });
  assert.deepEqual(result.departmentOptions, [HR, IT]);
  assert.deepEqual(result.handler, { id: 'u-1', name: 'hana.test' });
  assert.equal(result.aiAvailable, false);
  assert.deepEqual(result.aiError, { code: 'AI_UNAVAILABLE', message: '目前 AI 助手尚未啟用', retryAfter: null });
  assert.equal(result.preview, '[需求說明]: \n[處理部門]: \n[指定處理人]: 未指定');
  assert.deepEqual(normalizeDraftResponse(generalResponse({ ai_error: { code: 'SERVICE_BUSY', message: '忙碌', retry_after: 12 } })).aiError, { code: 'SERVICE_BUSY', message: '忙碌', retryAfter: 12 });
  assert.deepEqual(normalizeDraftResponse(generalResponse({ ai_error: 'AI_TIMEOUT' })).aiError, { code: 'AI_TIMEOUT', message: '', retryAfter: null }, '舊格式的純文字代碼');
  assert.equal(normalizeDraftResponse(generalResponse({ ai_error: { message: '沒有代碼' } })).aiError, null);
  assert.equal(Array.from(result.reply).length, DRAFT_LIMITS.reply);
  assert.equal(Array.from(result.intent).length, DRAFT_LIMITS.intent);
  const done = normalizeDraftResponse(generalResponse({ department: IT, values: { description: '申請新筆電' }, missing: [], complete: true, rendered_content: '[需求說明]: 申請新筆電' }));
  assert.equal(done.complete, true);
  const untyped = normalizeDraftResponse(generalResponse({ type: null }));
  assert.equal(untyped.type, null);
  assert.deepEqual(untyped.fields, [DESCRIPTION_FIELD], '沒有類型時保留可自由填寫的欄位');
  assert.equal(DESCRIPTION_FIELD.max_length, DESCRIPTION_MAX);
  for (const data of [null, [], { type: { id: 'x' } }, { type: { id: 'x', version: 0, name: 'n', fields: [] } },
    { type: { id: 'x', version: 1, name: 'n', fields: [{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'text' }] } },
    { type: { id: 'x', version: 1, name: 'n', fields: [{ key: 'a', type: 'text' }] } }]) {
    /** 嘗試整理無法辨識的回應。@returns {object} 結果。@throws {TicketServiceError} 無法辨識。 */
    function run() { return normalizeDraftResponse(data); }
    assert.throws(run, { code: 'INVALID_RESPONSE', message: MESSAGES.draftUnreadable });
  }
  assert.deepEqual(normalizeRequestType({ id: 'x', version: 2, name: ' 名稱 ', department: { id: 'd', name: ' D ' }, fields: [
    { key: 'a', label: ' A ', type: 'enum', options: ['1', 2], required: true, max_length: -1 },
    { key: 'n', label: 'N', type: 'number', min: 1, max: '9', integer: true },
  ] }), { id: 'x', version: 2, name: '名稱', department: { id: 'd', name: 'D' }, fields: [
    { key: 'a', label: 'A', type: 'enum', required: true, options: ['1'], max_length: null, min: null, max: null, integer: false, rules: { after: null, not_before_today: false } },
    { key: 'n', label: 'N', type: 'number', required: false, options: [], max_length: null, min: 1, max: null, integer: true, rules: { after: null, not_before_today: false } },
  ], calendars: [] });
}
test('沒有固定部門的類型與無法辨識的回應', generalNormalization);

/**
 * 驗證日期類欄位的規則與工作日曆摘要的整理：規則只保留 after（文字）與 not_before_today（true）；日曆整理時間、星期、假日與年度，
 * 略過格式不符的項目，缺少起訖欄位、有效時段或工作日的整筆略過，時區格式不符時改用台北。
 * @returns {void}
 */
function pickerData() {
  const type = normalizeRequestType({ id: 'x', version: 1, name: 'n', fields: [
    { key: 'from_at', label: 'F', type: 'datetime', rules: { not_before_today: 'yes' } },
    { key: 'to_at', label: 'T', type: 'datetime', rules: { after: 'from_at', not_before_today: true } },
  ], calendars: [
    { start: 'from_at', end: 'to_at', timezone_offset: '+8', work_windows: [['09:00', '12:00'], ['13:00', '12:00'], ['25:00', '26:00'], 'x'], workdays: [1, 1, 7, 5],
      holidays: ['2026-11-11', '11/12'], open_years: [2026, '2027'] },
    { start: 'from_at', end: 'to_at', work_windows: [], workdays: [1] },
    { end: 'to_at', work_windows: [['09:00', '18:00']], workdays: [1] },
  ] });
  assert.deepEqual(type.fields.map(/** 取規則。@param {{rules: object}} field 欄位。@returns {object} 規則。 */ (field) => field.rules),
    [{ after: null, not_before_today: false }, { after: 'from_at', not_before_today: true }]);
  assert.deepEqual(type.calendars, [{ start: 'from_at', end: 'to_at', workWindows: [['09:00', '12:00']], workdays: [1, 5], holidays: ['2026-11-11'], openYears: [2026], timezoneOffset: '+08:00' }]);
}
test('日期類欄位的規則與工作日曆摘要', pickerData);

/**
 * 驗證面板狀態的整理：空白 id 轉 null、只保留文字欄位值、鎖定清單去重；type_id 也接受舊名稱 form_id。
 * @returns {void}
 */
function stateNormalization() {
  assert.deepEqual(prepareState(null), { type_id: null, department_id: null, handler_id: null, fields: {}, locked: [] });
  assert.deepEqual(prepareState({ type_id: 'leave', intent: ` ${'意'.repeat(90)} `, locked: ['agent', 'department_id', 'handler_id'] }),
    { type_id: 'leave', department_id: null, handler_id: null, intent: '意'.repeat(DRAFT_LIMITS.intent), fields: {}, locked: ['agent', 'department_id', 'handler_id'] }, 'intent 截到 80 字，鎖定可含部門與處理人');
  assert.equal(prepareState({ form_id: 'legacy' }).type_id, 'legacy', '接受舊名稱 form_id');
  assert.equal(Object.hasOwn(prepareState({ intent: '  ' }), 'intent'), false, '空白 intent 不送');
  assert.deepEqual(prepareState({ type_id: ' ', department_id: 'd', handler_id: 'h', fields: [], locked: 'x' }), { type_id: null, department_id: 'd', handler_id: 'h', fields: {}, locked: [] });
}
test('面板狀態的整理', stateNormalization);

/**
 * 驗證需求類型目錄（GET /api/forms）的請求與整理：保留名稱、版本、固定部門、欄位、選填的 summary／computed／workflow；
 * 格式不符或重複的類型略過；回應不是 { types: [] } 時視為格式不正確。
 * @returns {Promise<void>}
 */
async function requestTypes() {
  const urls = [];
  const body = { types: [
    { ...EQUIPMENT_TYPE, summary: ' 申請設備 ', workflow: { transfer: true, not_requester: 'yes' } },
    { ...LEAVE_TYPE, department: HR, computed: [{ key: 'minutes', label: '請假時數', display: 'hours_minutes' }, { key: 'bad' }] },
    { id: 'broken', version: 1, name: '壞掉', fields: [{ key: 'a' }] },
    { ...EQUIPMENT_TYPE, name: '重複' },
  ] };
  /** 記錄網址並回傳目錄。@param {string} url 網址。@returns {Promise<Response>} 回應。 */
  async function fakeFetch(url) { urls.push(url); return Response.json(body); }
  globalThis.fetch = fakeFetch;
  const types = await loadRequestTypes();
  assert.deepEqual(urls, ['http://localhost:3000/api/forms']);
  assert.deepEqual(types.map(keyOfType), ['equipment', 'leave']);
  assert.equal(types[0].summary, '申請設備');
  assert.deepEqual(types[0].department, GA);
  assert.deepEqual(types[0].workflow, { transfer: true, not_requester: null });
  assert.deepEqual(types[1].computed, [{ key: 'minutes', label: '請假時數', display: 'hours_minutes' }]);
  assert.deepEqual(types[1].workflow, { transfer: null, not_requester: null });
  for (const data of [null, { types: 'x' }]) {
    /** 嘗試整理格式不正確的目錄。@returns {object} 結果。@throws {TicketServiceError} 格式不正確。 */
    function run() { return normalizeRequestTypes(data); }
    assert.throws(run, { code: 'INVALID_RESPONSE', message: MESSAGES.listInvalid });
  }
}
/**
 * 取出需求類型 id。
 * @param {{id: string}} type 需求類型。
 * @returns {string} id。
 */
function keyOfType(type) { return type.id; }
test('需求類型目錄的請求與整理', requestTypes);

/**
 * 驗證後端的即時預覽與助理 history 的 400 字上限。
 * @returns {void}
 */
function previewAndHistory() {
  assert.equal(normalizeDraftResponse(leaveResponse({ preview_content: '預覽' })).preview, '預覽');
  assert.equal(normalizeDraftResponse(leaveResponse()).preview, '', '沒有 preview_content 時為空字串');
  const turns = prepareHistory([{ role: 'assistant', text: '助'.repeat(450) }, { role: 'user', text: '使'.repeat(450) }]);
  assert.equal(Array.from(turns[0].text).length, DRAFT_LIMITS.assistantText);
  assert.equal(Array.from(turns[1].text).length, DRAFT_LIMITS.historyText);
}
test('後端預覽與助理對話上限', previewAndHistory);

/**
 * 驗證「自動生成」請求的等待上限比後端整個回合的 20 秒期限長（30 秒），一般請求（需求類型目錄）維持 20 秒，
 * 避免前端在後端回傳備援結果前先放棄。以替身記錄 AbortSignal.timeout 收到的毫秒數，不連線。
 * @returns {Promise<void>}
 */
async function draftTimeout() {
  const original = AbortSignal.timeout;
  const waits = [];
  /**
   * 記錄等待毫秒數並回傳不會觸發的訊號。
   * @param {number} ms 等待毫秒數。
   * @returns {AbortSignal} 訊號。
   */
  AbortSignal.timeout = (ms) => { waits.push(ms); return new AbortController().signal; };
  try {
    globalThis.fetch = recordingFetch(leaveResponse(), []);
    await requestDraft({ subject: '請假' });
    /** 需求類型目錄的 fetch 替身。@returns {Promise<Response>} 空目錄。 */
    globalThis.fetch = async () => Response.json({ types: [] });
    assert.deepEqual(await loadRequestTypes(), []);
  } finally { AbortSignal.timeout = original; }
  assert.equal(waits[0], DRAFT_REQUEST_TIMEOUT_MS);
  assert.ok(DRAFT_REQUEST_TIMEOUT_MS > 20000, '比後端的 20 秒回合期限長');
  assert.equal(waits[1], 20000);
}
test('自動生成請求的等待上限比後端回合期限長', draftTimeout);
