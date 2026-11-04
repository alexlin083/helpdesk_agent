import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/testEnv.js';

setupTestEnv();

const { createClaudeAssistant, claudeClassifySchema, claudeTool } = await import('../src/services/requestTypes/claudeAssistant.js');
const { fallbackParams } = await import('../src/services/ai/claudeShared.js');
const { createClaudeTicketJudge, claudeJudgeSchema } = await import('../src/services/ai/ticketJudgeClaude.js');
const { createDraftAssistant, createJudge, providerOrder, FALLBACK_COOLDOWN_MS, PRIMARY_DRAFT_TIMEOUT_MS, FALLBACK_DRAFT_TIMEOUT_MS, PRIMARY_JUDGE_TIMEOUT_MS, FALLBACK_JUDGE_TIMEOUT_MS } = await import('../src/services/ai/providers.js');
const { createDepartmentService } = await import('../src/services/departmentService.js');
const { createLogger } = await import('../src/utils/logger.js');

// 測試用部門；全部為假資料。
const departments = createDepartmentService({ departments: [
  { id: 'dept-it-1', name: '資訊管理一部', duty: 'IT資訊服務台', business: ['IT資訊服務台'] },
  { id: 'dept-ga-1', name: '總務與硬體組', duty: '辦公設備', business: ['辦公設備'] },
] });
const lists = { typeIds: ['repair', 'general'], departmentIds: ['dept-it-1', 'dept-ga-1'], keys: ['asset', 'description'] };

/**
 * 建立假的 Anthropic client：依序回傳準備好的回應（或拋出錯誤），並記錄每次呼叫的參數與選項。
 * @param {Array<object|Error>} replies 依序回傳的回應；Error 物件會被拋出。
 * @returns {{client: object, calls: Array<{params: object, options: object}>}} 假 client 與呼叫紀錄。
 */
function fakeClient(replies) {
  const calls = [];
  const queue = [...replies];
  const client = { beta: { messages: {
    /**
     * 記錄參數並回傳下一個準備好的回應；參數以深拷貝保存，避免之後被呼叫端修改。
     * @param {object} params 請求參數。
     * @param {object} options 請求選項。
     * @returns {Promise<object>} 回應。
     * @throws {Error} 準備好的錯誤。
     */
    async create(params, options) {
      calls.push({ params: structuredClone(params), options });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  } } };
  return { client, calls };
}

/**
 * 建立一則 Claude 回應：開頭有一個空白的思考區塊（Sonnet 5.5 預設不顯示思考內容），再接上指定的區塊。
 * @param {object[]} blocks 內容區塊。
 * @param {string} [stopReason='end_turn'] 停止原因。
 * @returns {object} 回應。
 */
function reply(blocks, stopReason = 'end_turn') {
  return { stop_reason: stopReason, content: [{ type: 'thinking', thinking: '', signature: 'sig' }, ...blocks], usage: { input_tokens: 10, output_tokens: 5 } };
}

/**
 * 建立結構化輸出的文字回應。
 * @param {object} value 要序列化成 JSON 的內容。
 * @returns {object} 回應。
 */
function jsonReply(value) {
  return reply([{ type: 'text', text: JSON.stringify(value) }]);
}

/**
 * 斷言 Promise 以帶指定 draftReason 的錯誤失敗。
 * @param {Promise<unknown>} promise 要檢查的 Promise。
 * @param {string} reason 預期的 draftReason。
 * @returns {Promise<void>}
 */
async function rejectsWith(promise, reason) {
  await assert.rejects(promise, /** 檢查原因。@param {object} error 錯誤。@returns {boolean} 相符時 true。 */ (error) => error.draftReason === reason);
}

/**
 * 驗證 Claude 分類：送出的參數符合 Sonnet 5.5 的規則（不送 temperature 與 tool_choice、effort low、json_schema 結構化輸出、
 * 伺服器端 fallback），回應中的思考區塊被略過，只採信清單內的 id；schema 的物件都設 additionalProperties: false 且沒有數值範圍。
 * @returns {Promise<void>}
 */
async function classifyRequest() {
  const { client, calls } = fakeClient([jsonReply({ intent: '螢幕故障', type_id: 'repair', department_id: 'dept-x', confidence_score: 90, reply: '收到' })]);
  const assistant = createClaudeAssistant({ getAI: () => client, model: 'claude-sonnet-5-5' });
  const result = await assistant.classify({ instructions: '系統指示', context: { subject: '螢幕壞了' }, lists });
  assert.deepEqual([result.typeId, result.departmentId, result.confidence, result.reply, result.model], ['repair', null, 90, '收到', 'claude-sonnet-5-5']);
  assert.deepEqual(result.toolsUsed, []);
  const { params, options } = calls[0];
  assert.equal(params.model, 'claude-sonnet-5-5');
  assert.equal(params.system, '系統指示');
  assert.deepEqual(params.messages, [{ role: 'user', content: JSON.stringify({ subject: '螢幕壞了' }) }]);
  assert.deepEqual(params.output_config, { effort: 'low', format: { type: 'json_schema', schema: claudeClassifySchema(lists) } });
  assert.deepEqual([params.betas, params.fallbacks], [['server-side-fallback-2026-07-01'], 'default']);
  for (const name of ['temperature', 'tool_choice', 'thinking']) assert.ok(!(name in params), `不送 ${name}`);
  assert.equal(options.timeout, 20000);
  assert.ok(options.signal instanceof AbortSignal);
  const schema = claudeClassifySchema(lists);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.type_id, { anyOf: [{ type: 'string', enum: ['repair', 'general'] }, { type: 'null' }] });
  assert.ok(!JSON.stringify(schema).includes('minimum') && !JSON.stringify(claudeJudgeSchema).includes('maximum'), 'Claude 結構化輸出不支援數值範圍');
  assert.deepEqual(fallbackParams('claude-haiku-5-5'), {}, '沒有伺服器端 fallback 的模型不送參數');
}
test('Claude 分類送出符合 Sonnet 5.5 規則的結構化輸出請求', classifyRequest);

/**
 * 驗證 Claude 填寫：工具階段把助手回應（含思考區塊）原樣接回對話、以 tool_result 回覆每個 tool_use（錯誤加 is_error），
 * 整回合最多執行 3 次工具（第 4 次只回錯誤、不列入 toolsUsed），模型不再呼叫工具時進入整理階段；整理階段附上工具結果做一次結構化輸出。
 * 工具定義的名稱、說明與參數 schema 取自目錄。
 * @returns {Promise<void>}
 */
async function fillWithTools() {
  const toolUse = /** 建立工具呼叫區塊。@param {string} id 呼叫 id。@param {string} name 工具。@param {object} input 參數。@returns {object} 區塊。 */ (id, name, input) => ({ type: 'tool_use', id, name, input });
  const { client, calls } = fakeClient([
    reply([toolUse('call-1', 'department_members', { department_id: 'dept-ga-1' }), toolUse('call-2', 'department_directory', {})], 'tool_use'),
    reply([toolUse('call-3', 'department_members', { department_id: 'dept-x' }), toolUse('call-4', 'department_members', { department_id: 'dept-it-1' })], 'tool_use'),
    jsonReply({ intent: '報修', type_id: 'repair', department_id: 'dept-ga-1', confidence_score: 95, updates: [{ key: 'asset', value: '螢幕' }, { key: 'unknown', value: 'x' }], handler_id: null, reply: '請問位置？' }),
  ]);
  const tools = [
    { id: 'department_members', description: '列出部門成員', returns: '成員陣列', params: { department_id: { type: 'string', description: '部門 id', required: true } } },
    { id: 'department_directory', description: '列出部門', returns: '部門陣列', params: {} },
  ];
  const ran = [];
  /** 工具執行替身：dept-x 回錯誤，其他回結果。@param {string} id 工具。@param {object} args 參數。@returns {Promise<object>} 結果。 */
  const runTool = async (id, args) => { ran.push([id, args]); return args.department_id === 'dept-x' ? { error: '找不到部門' } : { result: [{ id: 'ga.one' }] }; };
  const assistant = createClaudeAssistant({ getAI: () => client, model: 'claude-sonnet-5-5' });
  const result = await assistant.fill({ instructions: '指示', context: { subject: '螢幕壞了' }, lists, tools, runTool });
  assert.deepEqual(result.toolsUsed, ['department_members', 'department_directory', 'department_members']);
  assert.equal(ran.length, 3, '第 4 次呼叫超過上限，不執行');
  assert.deepEqual(result.updates, [{ key: 'asset', value: '螢幕' }]);
  assert.equal(calls.length, 3, '兩次工具階段加一次整理階段');
  assert.deepEqual(calls[0].params.tools, tools.map(claudeTool));
  assert.deepEqual(calls[0].params.tools[0].input_schema, { type: 'object', properties: { department_id: { type: 'string', description: '部門 id' } }, required: ['department_id'], additionalProperties: false });
  assert.ok(calls[0].params.system.endsWith('現在是工具階段：只在需要資料時呼叫工具；不需要時直接回覆 OK。'));
  assert.ok(!('tool_choice' in calls[0].params) && calls[0].params.output_config.effort === 'low');
  const second = calls[1].params.messages;
  assert.equal(second[1].role, 'assistant');
  assert.equal(second[1].content[0].type, 'thinking', '助手回應原樣接回（含思考區塊）');
  assert.deepEqual(second[2].content.map(/** 取回覆。@param {object} item tool_result。@returns {object} 摘要。 */ (item) => [item.tool_use_id, Boolean(item.is_error)]), [['call-1', false], ['call-2', false]]);
  const final = calls[2].params;
  assert.equal(final.output_config.format.type, 'json_schema');
  assert.equal(final.messages.length, 1);
  const finalContext = JSON.parse(final.messages[0].content);
  assert.equal(finalContext.tool_results.length, 3);
  assert.deepEqual(finalContext.tool_results[2], { tool: 'department_members', args: { department_id: 'dept-x' }, error: '找不到部門' });
}
test('Claude 填寫的工具階段與整理階段', fillWithTools);

/**
 * 驗證 Claude 助手的錯誤對應：沒有工具時直接整理；refusal → AI_UPSTREAM_ERROR；max_tokens 截斷、非 JSON → AI_INVALID_RESPONSE；
 * 上游 429 → RATE_LIMIT_EXCEEDED（retryAfter 10）；500 → AI_UPSTREAM_ERROR；超過期限 → AI_TIMEOUT；未設定 ANTHROPIC_API_KEY → AI_UNAVAILABLE。
 * @returns {Promise<void>}
 */
async function assistantErrors() {
  /** 以單一回應建立助手。@param {object|Error} response 回應或錯誤。@param {number} [timeoutMs=20000] 期限。@returns {object} 助手。 */
  const withReply = (response, timeoutMs = 20000) => createClaudeAssistant({ getAI: () => fakeClient([response]).client, timeoutMs });
  const request = { instructions: 'x', context: {}, lists };
  const plain = fakeClient([jsonReply({ intent: '', type_id: null, department_id: null, confidence_score: 0, updates: [], handler_id: null, reply: '好' })]);
  const answered = await createClaudeAssistant({ getAI: () => plain.client }).fill({ ...request, tools: [], runTool: async () => ({}) });
  assert.deepEqual([answered.reply, answered.toolsUsed, plain.calls.length], ['好', [], 1], '沒有工具時略過工具階段');
  await rejectsWith(withReply(reply([], 'refusal')).classify(request), 'AI_UPSTREAM_ERROR');
  await rejectsWith(withReply(reply([{ type: 'text', text: '{"intent":' }], 'max_tokens')).classify(request), 'AI_INVALID_RESPONSE');
  await rejectsWith(withReply(reply([{ type: 'text', text: 'not json' }])).classify(request), 'AI_INVALID_RESPONSE');
  await assert.rejects(withReply(Object.assign(new Error('rate limited'), { status: 429 })).classify(request), (error) => error.draftReason === 'RATE_LIMIT_EXCEEDED' && error.retryAfter === 10);
  await rejectsWith(withReply(Object.assign(new Error('overloaded'), { status: 529 })).classify(request), 'AI_UPSTREAM_ERROR');
  const never = { beta: { messages: { create: () => new Promise(() => {}) } } };
  await rejectsWith(createClaudeAssistant({ getAI: () => never, timeoutMs: 20 }).classify(request), 'AI_TIMEOUT');
  await rejectsWith(createClaudeAssistant().classify(request), 'AI_UNAVAILABLE');
}
test('Claude 助手的錯誤對應', assistantErrors);

/**
 * 驗證 Claude 部門判斷：送出需求單與部門名錄、結構化輸出（effort low、fallback）；依 75 分分流；
 * refusal 視為格式異常（500，不洩漏原因）、上游 429 → 429 RATE_LIMIT_EXCEEDED、未設定金鑰 → 500「尚未設定 Anthropic API 金鑰」。
 * @returns {Promise<void>}
 */
async function judgeWithClaude() {
  const { client, calls } = fakeClient([jsonReply({ department_id: 'dept-ga-1', confidence_score: 88, basis: '屬於辦公設備報修。' })]);
  const decision = await createClaudeTicketJudge({ getAI: () => client, departments, model: 'claude-sonnet-5-5' })({ subject: '螢幕壞了', content: '螢幕一直閃爍' });
  assert.deepEqual([decision.route, decision.department.id, decision.confidence, decision.basis, decision.model], ['DEPARTMENT', 'dept-ga-1', 88, '屬於辦公設備報修', 'claude-sonnet-5-5']);
  const payload = JSON.parse(calls[0].params.messages[0].content);
  assert.deepEqual(payload.ticket, { subject: '螢幕壞了', content: '螢幕一直閃爍' });
  assert.equal(payload.departments.length, 2);
  assert.deepEqual(calls[0].params.output_config, { effort: 'low', format: { type: 'json_schema', schema: claudeJudgeSchema } });
  assert.equal(calls[0].params.fallbacks, 'default');
  const low = fakeClient([jsonReply({ department_id: 'dept-it-1', confidence_score: 40, basis: '不確定' })]);
  assert.equal((await createClaudeTicketJudge({ getAI: () => low.client, departments })({ subject: 'a', content: 'b' })).route, 'FALLBACK');
  const refused = fakeClient([reply([], 'refusal')]);
  await assert.rejects(createClaudeTicketJudge({ getAI: () => refused.client, departments })({ subject: 'a', content: 'b' }), { status: 500, message: 'AI 回應格式異常，請稍後再試' });
  const limited = fakeClient([Object.assign(new Error('rate'), { status: 429 })]);
  await assert.rejects(createClaudeTicketJudge({ getAI: () => limited.client, departments })({ subject: 'a', content: 'b' }), { status: 429, code: 'RATE_LIMIT_EXCEEDED' });
  await assert.rejects(createClaudeTicketJudge({ departments })({ subject: 'a', content: 'b' }), { status: 500, message: '尚未設定 Anthropic API 金鑰' });
}
test('Claude 版需求單部門判斷', judgeWithClaude);

/**
 * 驗證供應商選擇：anthropic 建立 Claude 助手與判斷器、gemini 建立 Gemini 版（以未設定金鑰時的錯誤訊息區分）；
 * 日誌遮蔽 Anthropic 格式（sk-ant-）的金鑰與設定的多把金鑰。
 * @returns {Promise<void>}
 */
async function providerSelection() {
  const request = { instructions: 'x', context: {}, lists };
  await assert.rejects(createDraftAssistant({ aiProvider: 'anthropic' }).classify(request), { message: '尚未設定 Anthropic API 金鑰' });
  await assert.rejects(createDraftAssistant({ aiProvider: 'gemini' }).classify(request), { message: '尚未設定 Gemini API 金鑰' });
  await assert.rejects(createJudge({ aiProvider: 'anthropic' })({ subject: 'a', content: 'b' }), { message: '尚未設定 Anthropic API 金鑰' });
  await assert.rejects(createJudge({ aiProvider: 'gemini' })({ subject: 'a', content: 'b' }), { message: '尚未設定 Gemini API 金鑰' });
  const lines = [];
  /** 收集輸出。@param {string} line 日誌。@returns {void} */
  const collect = (line) => { lines.push(line); };
  const log = createLogger({ level: 'info', sink: { log: collect, warn: collect, error: collect }, secret: ['test-gemini-secret', 'test-claude-secret'] });
  log('info', 'demo', { note: 'a sk-ant-api03-abcDEF_123 b test-gemini-secret c test-claude-secret' });
  assert.equal(JSON.parse(lines[0]).note, 'a [REDACTED] b [REDACTED] c [REDACTED]');
}
test('依 AI_PROVIDER 選擇供應商，日誌遮蔽兩家的金鑰', providerSelection);

/**
 * 驗證供應商順序：有主要金鑰與備援時兩家都用；只有備援金鑰時只用備援；沒有備援時只有主要供應商。
 * @returns {void}
 */
function order() {
  assert.deepEqual(providerOrder({ aiProvider: 'gemini', aiApiKey: 'k', aiFallbackProvider: 'anthropic' }), ['gemini', 'anthropic']);
  assert.deepEqual(providerOrder({ aiProvider: 'gemini', aiApiKey: '', aiFallbackProvider: 'anthropic' }), ['anthropic'], '沒有 Gemini 金鑰時直接用 Claude');
  assert.deepEqual(providerOrder({ aiProvider: 'gemini', aiApiKey: 'k', aiFallbackProvider: null }), ['gemini']);
  assert.deepEqual(providerOrder({ aiProvider: 'gemini', aiApiKey: '', aiFallbackProvider: null }), ['gemini']);
}
test('AI 供應商的使用順序', order);

/**
 * 建立會記錄呼叫的假助手：依 outcomes 依序回傳結果或拋出錯誤；每次呼叫會把時鐘往前推 elapsed 毫秒。
 * @param {string} name 助手名稱（寫進結果的 model）。
 * @param {Array<'ok'|object>} outcomes 依序的結果：'ok' 回傳成功結果，物件則當成錯誤拋出。
 * @param {{now: number}} time 共用的假時鐘。
 * @param {number} [elapsed=10] 每次呼叫耗時（毫秒）。
 * @returns {{assistant: object, calls: string[]}} 假助手與呼叫紀錄。
 */
function fakeAssistant(name, outcomes, time, elapsed = 10) {
  const calls = [];
  /** 依序產生結果。@param {string} method 方法。@returns {Promise<object>} 結果。@throws {object} 準備好的錯誤。 */
  const next = async (method) => {
    calls.push(method);
    time.now += elapsed;
    const outcome = outcomes.shift() ?? 'ok';
    if (outcome !== 'ok') throw outcome;
    return { model: name, typeId: 'general', toolsUsed: [] };
  };
  return { calls, assistant: { classify: () => next('classify'), fill: () => next('fill') } };
}

/**
 * 驗證自動生成的備援切換：
 * 1. 有備援時主要供應商期限 10 秒、備援 15 秒；沒有備援時主要供應商維持 20 秒；
 * 2. Gemini 這回合不論是限流、上游錯誤（含 503 過載、404）、回應格式異常或逾時，同一個請求都改由 Claude 處理，使用者拿到 Claude 的結果；
 * 3. 切換後 60 秒內的分類與填寫直接交給 Claude，冷卻結束後重新先試 Gemini；
 * 4. 不是 AI 的錯誤（例如資料庫無法讀取，沒有 draftReason）不切換、原樣拋出；Claude 也失敗時拋出 Claude 的錯誤。
 * @returns {Promise<void>}
 */
async function draftFallback() {
  const time = { now: 1000000 };
  const clock = () => time.now;
  const config = { aiProvider: 'gemini', aiApiKey: 'k', aiFallbackProvider: 'anthropic' };
  const built = [];
  /**
   * 依名稱與期限建立假助手並記錄期限。
   * @param {Record<string, object>} pair gemini 與 claude 的假助手。
   * @returns {(name: string, timeoutMs: number) => object} build 函式。
   */
  const builder = (pair) => (name, timeoutMs) => { built.push([name, timeoutMs]); return (name === 'gemini' ? pair.gemini : pair.claude).assistant; };
  for (const failure of [{ draftReason: 'RATE_LIMIT_EXCEEDED' }, { draftReason: 'AI_UPSTREAM_ERROR', upstreamStatus: 503 }, { draftReason: 'AI_UPSTREAM_ERROR', upstreamStatus: 404 },
    { draftReason: 'AI_INVALID_RESPONSE' }, { draftReason: 'AI_TIMEOUT' }]) {
    const pair = { gemini: fakeAssistant('gemini', [failure], time), claude: fakeAssistant('claude', [], time) };
    const assistant = createDraftAssistant(config, { clock, build: builder(pair) });
    assert.equal((await assistant.fill({})).model, 'claude', `${failure.draftReason} ${failure.upstreamStatus ?? ''} 時改用 Claude`);
  }
  assert.deepEqual(built.slice(0, 2), [['gemini', PRIMARY_DRAFT_TIMEOUT_MS], ['anthropic', FALLBACK_DRAFT_TIMEOUT_MS]]);
  assert.equal(PRIMARY_DRAFT_TIMEOUT_MS + FALLBACK_DRAFT_TIMEOUT_MS < 30000, true, '兩段加起來在前端 30 秒等待上限內');

  const pair = { gemini: fakeAssistant('gemini', [{ draftReason: 'AI_INVALID_RESPONSE' }, 'ok'], time), claude: fakeAssistant('claude', [], time) };
  const cooled = createDraftAssistant(config, { clock, build: builder(pair) });
  assert.equal((await cooled.classify({})).model, 'claude');
  assert.equal((await cooled.fill({})).model, 'claude', '冷卻期間直接用 Claude');
  assert.deepEqual([pair.gemini.calls, pair.claude.calls], [['classify'], ['classify', 'fill']]);
  time.now += FALLBACK_COOLDOWN_MS;
  assert.equal((await cooled.classify({})).model, 'gemini', '冷卻結束後重新先試 Gemini');

  const storeDown = { gemini: fakeAssistant('gemini', [{ status: 503, code: 'TICKET_STORE_UNAVAILABLE' }], time), claude: fakeAssistant('claude', [], time) };
  await assert.rejects(createDraftAssistant(config, { clock, build: builder(storeDown) }).fill({}), { code: 'TICKET_STORE_UNAVAILABLE' });
  assert.deepEqual(storeDown.claude.calls, [], '不是 AI 的錯誤不切換');

  const both = { gemini: fakeAssistant('gemini', [{ draftReason: 'AI_TIMEOUT' }], time), claude: fakeAssistant('claude', [{ draftReason: 'AI_UPSTREAM_ERROR' }], time) };
  await assert.rejects(createDraftAssistant(config, { clock, build: builder(both) }).classify({}), { draftReason: 'AI_UPSTREAM_ERROR' }, '兩家都失敗時才回錯誤');

  built.length = 0;
  const only = fakeAssistant('gemini', [], time);
  assert.equal(createDraftAssistant({ ...config, aiFallbackProvider: null }, { clock, build: (name, timeoutMs) => { built.push([name, timeoutMs]); return only.assistant; } }), only.assistant);
  assert.deepEqual(built, [['gemini', 20000]], '沒有備援時直接使用主要供應商，期限 20 秒');
}
test('自動生成在 Gemini 這回合失敗時一律改用 Claude', draftFallback);

/**
 * 驗證需求單部門判斷的備援切換：有備援時主要期限 6 秒、備援 12 秒；Gemini 回 429 或 500（過載、上游錯誤、格式異常、逾時）都改用 Claude；
 * 其他狀態（例如 400）不切換。
 * @returns {Promise<void>}
 */
async function judgeFallback() {
  const time = { now: 0 };
  const config = { aiProvider: 'gemini', aiApiKey: 'k', aiFallbackProvider: 'anthropic' };
  const calls = [];
  const timeouts = [];
  /**
   * 建立假判斷器。
   * @param {string} name 名稱。
   * @param {object|null} error 要拋出的錯誤，null 表示成功。
   * @returns {Function} 判斷函式。
   */
  const judge = (name, error) => async () => { calls.push(name); if (error) throw error; return { route: 'DEPARTMENT', model: name }; };
  /**
   * 以 Gemini 的錯誤建立判斷器（Claude 一律成功）。
   * @param {object} error Gemini 的錯誤。
   * @returns {Function} 判斷函式。
   */
  const withGeminiError = (error) => createJudge(config, { clock: () => time.now,
    build: /** 依名稱建立並記錄期限。@param {string} name 供應商。@param {number} timeoutMs 期限。@returns {Function} 判斷器。 */ (name, timeoutMs) => { timeouts.push([name, timeoutMs]); return name === 'gemini' ? judge('gemini', error) : judge('claude', null); } });
  for (const error of [Object.assign(new Error('busy'), { status: 429, code: 'RATE_LIMIT_EXCEEDED' }), Object.assign(new Error('down'), { status: 500, code: 'SERVER_ERROR', upstreamStatus: 503 }),
    Object.assign(new Error('bad'), { status: 500, code: 'SERVER_ERROR' })]) {
    assert.equal((await withGeminiError(error)({ subject: 'a', content: 'b' })).model, 'claude', `${error.status} 時改用 Claude`);
  }
  assert.deepEqual(timeouts.slice(0, 2), [['gemini', PRIMARY_JUDGE_TIMEOUT_MS], ['anthropic', FALLBACK_JUDGE_TIMEOUT_MS]]);
  assert.equal(PRIMARY_JUDGE_TIMEOUT_MS + FALLBACK_JUDGE_TIMEOUT_MS < 20000, true, '兩段加起來在送單 20 秒等待上限內');
  await assert.rejects(withGeminiError(Object.assign(new Error('bad request'), { status: 400, code: 'INVALID_PAYLOAD' }))({ subject: 'a', content: 'b' }), { status: 400 });
}
test('AI 判斷部門在 Gemini 失敗時改用 Claude', judgeFallback);
