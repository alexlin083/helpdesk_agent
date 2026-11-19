import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupTestEnv } from './helpers/testEnv.js';

setupTestEnv();
const { createKnowledgeBase, getKnowledgeBase, searchEntries } = await import('../src/services/knowledge/knowledgeBase.js');
const { executeTool } = await import('../src/services/requestTypes/capabilities.js');
const { getRequestTypes, loadRequestTypes } = await import('../src/services/requestTypes/registry.js');
const { buildFill, createGeminiAssistant, fillSchema, PROPOSALS_MAX, SUGGESTIONS_MAX } = await import('../src/services/requestTypes/aiAssistant.js');
const { claudeFillSchema, createClaudeAssistant } = await import('../src/services/requestTypes/claudeAssistant.js');
const { proposalInputs, proposalView, userBackedSuggestions } = await import('../src/services/requestTypes/draftEngine.js');
const { departmentService } = await import('../src/services/departmentService.js');
const { env } = await import('../src/config/env.js');
const { createDraftEngine, parseDraftRequest } = await import('../src/services/requestTypes/draftEngine.js');
const { accountService } = await import('../src/services/personnel/accountService.js');
const { dataStore } = await import('../src/services/storage/dataStore.js');
const { createUsageService } = await import('../src/services/usageService.js');
const { createMemoryLimitStore } = await import('../src/services/storage/limitStore.js');

const LISTS = Object.freeze({ typeIds: ['leave', 'general'], departmentIds: ['dept-hr-1'], keys: ['leave_type', 'start_at', 'end_at', 'agent'] });

/**
 * 組出一筆格式正確的知識庫資料
 * @param {object} [overrides={}] 覆寫的欄位
 * @returns {object} 資料
 */
function entryOf(overrides = {}) {
  return { id: 'KB-T-001', policy_id: 'POL-T-01', doc_name: '測試規章', articles: ['第 1 條'], section_title: '主題', content: '課堂模擬規章，內容', summary: '摘要', department_id: 'dept-hr-1',
    request_types: ['general'], keywords: ['關鍵字'], enforcement: 'INFO', related_fields: [], sample_questions: ['問題一', '問題二'], version: '1.0', updated_at: '2026-11-15', source_url: null, data_status: 'SIMULATED', ...overrides };
}

test('規章知識庫：正式檔案可以載入；每筆的需求類型與部門都是現有的 id；格式錯誤時指出位置', () => {
  const base = getKnowledgeBase();
  assert.equal(base.entries.length, 8, '7 筆範例加上第 11 條（3e 收錄，待組員確認）');
  const typeIds = getRequestTypes().ids();
  for (const entry of base.entries) {
    for (const id of entry.request_types) assert.ok(typeIds.includes(id), `${entry.id} 的需求類型 ${id}`);
    assert.ok(departmentService.findDepartment(entry.department_id), `${entry.id} 的部門 ${entry.department_id}`);
    assert.equal(entry.data_status, 'SIMULATED');
  }
  assert.throws(() => createKnowledgeBase({ raw: { entries: [entryOf({ doc_name: '' })] } }), /entries\[0\]\.doc_name/);
  assert.throws(() => createKnowledgeBase({ raw: { entries: [entryOf(), entryOf()] } }), /重複的 id/);
  assert.throws(() => createKnowledgeBase({ raw: { entries: [entryOf({ keywords: [] })] } }), /entries\[0\]\.keywords/);
  assert.throws(() => createKnowledgeBase({ raw: {} }), { code: 'KNOWLEDGE_INVALID' });
  assert.throws(() => createKnowledgeBase({ raw: { entries: [entryOf({ content: '規'.repeat(601) })] } }), /entries\[0\]\.content：最多 600 字/);
  assert.throws(() => createKnowledgeBase({ raw: { entries: [entryOf({ summary: '摘'.repeat(121) })] } }), /entries\[0\]\.summary：最多 120 字/);
  assert.equal(createKnowledgeBase({ raw: { entries: [entryOf({ content: '規'.repeat(600), summary: '摘'.repeat(120) })] } }).entries.length, 1, '剛好上限可以');
  assert.match(base.entries.find(/** 找設備申請 @param {{id: string}} entry 規章 @returns {boolean} 是時 true */ (entry) => entry.id === 'KB-GA-001').content, /由採購部處理（系統尚未檢查）/, '規章標【待實作】的條文照其他筆加註');
  const notice = base.entries.find(/** 找第 11 條 @param {{id: string}} entry 規章 @returns {boolean} 是時 true */ (entry) => entry.id === 'KB-HR-004');
  const leave = getRequestTypes().find('leave');
  assert.ok([leave.ai.description, leave.ai.greeting].every(/** 寫成建議 @param {string} text 文字 @returns {boolean} 是時 true */ (text) => /建議至少提早 1 個工作天/.test(text) && !/工作日前提出/.test(text)), 'AI 說明與招呼語也寫成建議');
  const leaveChecksNotice = leave.checks.some(/** 提早提出的檢查 @param {{capability: string}} check 檢查 @returns {boolean} 是時 true */ (check) => check.capability === 'notice_workdays');
  assert.equal(leaveChecksNotice, false, '請假定義不檢查提早提出');
  assert.deepEqual([notice.enforcement, /建議至少提早 1 個工作天/.test(notice.content), /工作日前提出/.test(notice.content)], ['INFO', true, false], '知識庫和請假定義一致：寫成建議、不寫成系統檢查的規定');
});

test('規章查詢：只看目前的需求類型，依關鍵字與相鄰兩字計分，最多 3 筆並附來源；不相關的問題回空陣列與「照實說沒有找到」', () => {
  const base = getKnowledgeBase();
  const ids = (query, typeId) => base.search(query, typeId).entries.map(/** 取 id @param {{id: string}} entry 規章 @returns {string} id */ (entry) => entry.id);
  assert.deepEqual(ids('我到職一年半，特休有幾天？', 'leave'), ['KB-HR-001']);
  assert.deepEqual(ids('代理人可以找別的部門的人嗎', 'leave'), ['KB-HR-002']);
  assert.deepEqual(ids('VPN 可以用個人電腦嗎', 'vpn'), ['KB-IT-001']);
  assert.equal(ids('事假要提前多久申請', 'leave')[0], 'KB-HR-004', '提早提出的建議查得到依據');
  assert.deepEqual(ids('特休', 'vpn'), [], '不同需求類型的規章不列');
  const none = base.search('今天午餐吃什麼', 'leave');
  assert.deepEqual(none.entries, []);
  assert.match(none.note, /照實告訴使用者沒有找到，不要自行編造/);
  assert.match(none.note, /使用者沒問就不用提/, '使用者沒問到規定時，查不到不必特地說');
  const found = base.search('年假', 'leave');
  assert.deepEqual(Object.keys(found.entries[0]), ['id', 'doc_name', 'articles', 'section_title', 'content', 'enforcement', 'data_status'], '只給 AI 需要的欄位');
  assert.match(found.note, /附上 doc_name 與 articles/);
  assert.match(found.note, /只引用跟使用者這次情況有關的條文/, '不要把查到的條文全部列出來');
  assert.deepEqual(ids('打卡補登每個月可以補幾次', 'attendance'), ['KB-HR-003'], '請假以外的類型也查得到自己的規章');
  assert.equal(ids('設備冒煙怎麼辦', 'repair')[0], 'KB-GA-002', '報修查得到安全處理的規章');
  const many = Array.from({ length: 5 }, /** 五筆同主題 @param {unknown} _ 未用 @param {number} index 位置 @returns {object} 資料 */ (_, index) => entryOf({ id: `KB-T-00${index}`, keywords: ['報銷'] }));
  assert.equal(searchEntries(many, '報銷', 'general').entries.length, 3, '最多 3 筆');
  assert.deepEqual(searchEntries(many, '', 'general').entries, []);
});

test('policy_lookup 工具：預設查目前的需求類型，可以指定其他類型；知識庫無法讀取時回 error', async () => {
  const types = getRequestTypes();
  const leave = types.find('leave');
  const tool = types.toolsFor(leave).find(/** 找工具 @param {{id: string}} item 工具 @returns {boolean} 是時 true */ (item) => item.id === 'policy_lookup');
  assert.equal(tool.access, 'all');
  const own = await executeTool(tool, { query: '特休有幾天' }, { user: { username: 'racky.huang' }, type: leave });
  assert.deepEqual(own.result.entries.map(/** 取 id @param {{id: string}} entry 規章 @returns {string} id */ (entry) => entry.id), ['KB-HR-001']);
  const other = await executeTool(tool, { query: 'VPN 個人電腦', type_id: 'vpn' }, { user: { username: 'racky.huang' }, type: leave });
  assert.deepEqual(other.result.entries.map(/** 取 id @param {{id: string}} entry 規章 @returns {string} id */ (entry) => entry.id), ['KB-IT-001']);
  const broken = { /** 讀不到 @returns {never} 一律拋出 */ search() { throw new Error('x'); } };
  assert.match((await executeTool(tool, { query: '特休' }, { user: { username: 'racky.huang' }, type: leave, knowledge: broken })).error, /規章資料暫時無法使用/);
  assert.match((await executeTool(tool, {}, { user: { username: 'racky.huang' }, type: leave })).error, /缺少參數 query/);
});

test('每回合工具上限：目錄共用預設 3（省略時也是 3）；請假在定義檔設 5，其他類型照目錄；不是 1～5 的整數時啟動失敗', () => {
  const types = getRequestTypes();
  assert.equal(types.catalog.assistant.maxToolCalls, 3, '目錄共用預設');
  assert.equal(types.find('leave').ai.maxToolCalls, 5, '請假');
  for (const id of types.ids().filter(/** 請假以外 @param {string} id 類型 id @returns {boolean} 是時 true */ (id) => id !== 'leave')) assert.equal(types.find(id).ai.maxToolCalls, null, `${id} 照目錄`);
  /**
   * 改掉某個定義檔的內容再載入
   * @param {string} name 檔名
   * @param {(data: object) => void} change 修改方式
   * @returns {object} 需求類型目錄
   */
  const withChange = (name, change) => loadRequestTypes({ read: /** 讀檔 @param {string|URL} file 檔案 @param {string} encoding 編碼 @returns {string} 內容 */ (file, encoding) => {
    const text = readFileSync(file, encoding);
    if (!String(file instanceof URL ? file.pathname : file).endsWith(name)) return text;
    const data = JSON.parse(text);
    change(data);
    return JSON.stringify(data);
  } });
  assert.equal(withChange('_catalog.json', /** 目錄改 4 @param {object} data 目錄 @returns {void} */ (data) => { data.assistant.max_tool_calls = 4; }).catalog.assistant.maxToolCalls, 4);
  for (const value of [0, 6, 2.5, '3']) {
    assert.throws(() => withChange('_catalog.json', /** 目錄寫錯 @param {object} data 目錄 @returns {void} */ (data) => { data.assistant.max_tool_calls = value; }), /assistant\.max_tool_calls/, String(value));
    assert.throws(() => withChange('leave.json', /** 定義檔寫錯 @param {object} data 定義 @returns {void} */ (data) => { data.ai.max_tool_calls = value; }), /leave\.json ai\.max_tool_calls/, String(value));
  }
});

test('AI 的方案：最多 3 個、沒有標題的略過、欄位只採信清單內的 key、文字依標點規範去掉句號；缺少時是空陣列；兩家的 schema 都要求 proposals', () => {
  const base = { intent: '安排休假', type_id: 'leave', department_id: 'dept-hr-1', confidence_score: 90, updates: [], handler_id: null, reply: '好' };
  const built = buildFill({ ...base, proposals: [
    { title: '週二請一天。', summary: '整天。', reasons: ['額度足夠。', 3, '', '第三', '第四'], updates: [{ key: 'leave_type', value: '事假' }, { key: 'hacked', value: 'x' }], basis: ['my_leave_balance', 7] },
    { title: '', summary: '沒有標題', reasons: [], updates: [], basis: [] },
    { title: '二', summary: '', reasons: [], updates: [], basis: [] }, { title: '三', summary: '', reasons: [], updates: [], basis: [] }, { title: '四', summary: '', reasons: [], updates: [], basis: [] },
  ] }, LISTS);
  assert.equal(built.proposals.length, PROPOSALS_MAX);
  assert.deepEqual(built.proposals[0], { title: '週二請一天', summary: '整天', reasons: ['額度足夠', '第三', '第四'], updates: [{ key: 'leave_type', value: '事假' }], basis: ['my_leave_balance'] });
  assert.deepEqual(built.proposals.map(/** 取標題 @param {{title: string}} item 方案 @returns {string} 標題 */ (item) => item.title), ['週二請一天', '二', '三']);
  assert.deepEqual(buildFill(base, LISTS).proposals, []);
  assert.ok(fillSchema(LISTS).required.includes('proposals'));
  assert.ok(claudeFillSchema(LISTS).required.includes('proposals'));
  assert.equal(claudeFillSchema(LISTS).properties.proposals.items.additionalProperties, false);
});

test('AI 的建議選項：最多 3 個、沒有文字或文字重複的略過、文字去句號並截到 20 字、欄位只採信清單內的 key；缺少時是空陣列；兩家的 schema 都要求 suggestions', () => {
  const base = { intent: '安排休假', type_id: 'leave', department_id: 'dept-hr-1', confidence_score: 90, updates: [], handler_id: null, reply: '想請哪一天？', proposals: [] };
  const built = buildFill({ ...base, suggestions: [
    { label: '12/1（二）整天。', updates: [{ key: 'start_at', value: '2026-12-01T09:00' }, { key: 'hacked', value: 'x' }] },
    { label: '   ', updates: [] }, { label: 7, updates: [] }, { label: '12/1（二）整天', updates: [] },
    { label: '一二三四五六七八九十一二三四五六七八九十多出來', updates: 'x' }, { label: '其他日期', updates: [] }, { label: '第四個', updates: [] },
  ] }, LISTS);
  assert.deepEqual(built.suggestions, [
    { label: '12/1（二）整天', updates: [{ key: 'start_at', value: '2026-12-01T09:00' }] },
    { label: '一二三四五六七八九十一二三四五六七八九十', updates: [] },
    { label: '其他日期', updates: [] },
  ]);
  assert.equal(built.suggestions.length, SUGGESTIONS_MAX);
  assert.deepEqual(buildFill(base, LISTS).suggestions, []);
  assert.ok(fillSchema(LISTS).required.includes('suggestions'));
  assert.ok(claudeFillSchema(LISTS).required.includes('suggestions'));
  assert.equal(claudeFillSchema(LISTS).properties.suggestions.items.additionalProperties, false);
});

test('建議選項的數字要是使用者講過的：數字欄位的值不在使用者的話裡（千分位逗號不影響比對）就整個不列，不是數字欄位或只有文字的照列', () => {
  const purchase = getRequestTypes().find('purchase');
  const list = [
    { label: '預算 3,000 元', updates: [{ key: 'budget', value: '3000' }] },
    { label: '預算大約 5,000 元', updates: [{ key: 'budget', value: '5000' }] },
    { label: '數量 10 箱', updates: [{ key: 'quantity', value: '10' }] },
    { label: '數量 1 箱', updates: [{ key: 'quantity', value: '1' }] },
    { label: '月底前', updates: [{ key: 'needed_by', value: '2026-11-30' }] },
    { label: '其他金額', updates: [] },
  ];
  const kept = userBackedSuggestions(list, purchase, ['想買 10 箱影印紙', '', '預算 3,000 元']);
  assert.deepEqual(kept.map(/** 取文字 @param {{label: string}} item 選項 @returns {string} 文字 */ (item) => item.label), ['預算 3,000 元', '數量 10 箱', '月底前', '其他金額'], '5000 沒講過、1 只出現在 10 裡面，都不列');
  assert.deepEqual(userBackedSuggestions(undefined, purchase, ['x']), []);
});

test('引擎處理建議選項：先套在目前的欄位上驗證、不寫進欄位；要填的欄位有錯的不列，只有文字的照列；鎖定與本人欄位不套用；文字去句號、id 依留下的順序', async () => {
  const clock = /** 固定在台北 2026-11-01（週日）上午 @returns {number} epoch 毫秒 */ () => Date.UTC(2026, 10, 1, 2, 0);
  const config = { ...env, aiApiKey: 'test-key-not-real' };
  const assistant = {
    /** 不應被呼叫 @returns {never} @throws {Error} 意外呼叫 */
    classify() { throw new Error('must not classify'); },
    /** 回五個建議選項：一個正確、兩個會讓欄位出錯、一個只填鎖定的欄位、一個只有文字 @param {object} request 參數 @returns {Promise<object>} 結果 */
    async fill(request) {
      return { intent: '請假', typeId: request.context.request_type.id, departmentId: 'dept-hr-1', confidence: 90, handlerId: null, reply: '想請哪一天？', model: 'test-model',
        updates: [], toolsUsed: [], toolsSucceeded: [], proposals: [],
        suggestions: [
          { label: '11/3（二）整天。', updates: [{ key: 'start_at', value: '2026-11-03T09:00' }, { key: 'end_at', value: '2026-11-03T18:00' }, { key: 'applicant', value: 'someone.else' }] },
          { label: '時間顛倒', updates: [{ key: 'start_at', value: '2026-11-03T09:00' }, { key: 'end_at', value: '2026-11-03T08:00' }] },
          { label: '找不存在的人', updates: [{ key: 'agent', value: 'nobody.x' }] },
          { label: '改成病假', updates: [{ key: 'leave_type', value: '病假' }] },
          { label: '其他日期', updates: [] },
        ] };
    },
  };
  const types = getRequestTypes();
  const engine = createDraftEngine({ types, departments: departmentService, accounts: accountService, store: dataStore, usage: createUsageService({ store: createMemoryLimitStore(), config, clock }), assistant, config, clock });
  const department = departmentService.findDepartment('dept-hr-1');
  const user = { username: 'emily.wu', userID: 'user-emily.wu', role: 'USER', department: { id: department.id, name: department.name } };
  const request = parseDraftRequest({ subject: '想請假', message: '下週想請一天', state: { type_id: 'leave', department_id: 'dept-hr-1', fields: { leave_type: '特休' }, locked: ['leave_type'] } }, { types, departments: departmentService });
  const body = await engine.run(user, request);
  assert.deepEqual(body.suggestions, [
    { id: 's1', label: '11/3（二）整天', updates: [{ key: 'start_at', value: '2026-11-03T09:00' }, { key: 'end_at', value: '2026-11-03T18:00' }] },
    { id: 's2', label: '改成病假', updates: [] },
    { id: 's3', label: '其他日期', updates: [] },
  ], '時間顛倒、找不存在的人不列；本人欄位與鎖定的欄位不套用');
  assert.deepEqual([body.values.start_at, body.values.end_at, body.values.leave_type], ['', '', '特休'], '選項不寫進欄位');
});

test('每回合工具上限由呼叫端指定：Gemini 與 Claude 都照 request.maxToolCalls 執行，超過的呼叫只回錯誤', async () => {
  const tools = [{ id: 'policy_lookup', description: '查規章', returns: '規章', params: { query: { type: 'string', description: '問題', required: true } } }];
  const final = { intent: 'x', type_id: 'leave', department_id: 'dept-hr-1', confidence_score: 90, updates: [], handler_id: null, reply: '好', proposals: [] };
  const queue = [];
  for (let round = 0; round < 4; round += 1) queue.push({ functionCalls: [{ id: `c${round}`, name: 'policy_lookup', args: { query: '特休' } }], candidates: [{ content: { role: 'model', parts: [] } }] });
  queue.push({ functionCalls: [{ id: 'c4', name: 'policy_lookup', args: { query: '特休' } }, { id: 'c5', name: 'policy_lookup', args: { query: '病假' } }], candidates: [{ content: { role: 'model', parts: [] } }] });
  queue.push({ text: JSON.stringify(final) });
  const gemini = createGeminiAssistant({ getAI: () => ({ models: { /** 依序回應 @returns {Promise<object>} 回應 */ async generateContent() { return queue.shift(); } } }), model: 'test-model' });
  let geminiRuns = 0;
  const geminiResult = await gemini.fill({ instructions: '指示', context: {}, lists: LISTS, tools, maxToolCalls: 5, runTool: /** 計次，第 3 次回錯誤 @returns {Promise<object>} 結果 */ async () => { geminiRuns += 1; return geminiRuns === 3 ? { error: '暫時無法讀取' } : { result: {} }; } });
  assert.equal(geminiRuns, 5, '第 6 個呼叫超過上限，不執行');
  assert.equal(geminiResult.toolsUsed.length, 5);
  assert.equal(geminiResult.toolsSucceeded.length, 4, '回錯誤的呼叫不算成功');

  const call = (id) => ({ type: 'tool_use', id, name: 'policy_lookup', input: { query: '特休' } });
  const replies = [{ stop_reason: 'tool_use', content: [call('a'), call('b'), call('c')], usage: { input_tokens: 1, output_tokens: 1 } }, { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(final) }], usage: { input_tokens: 1, output_tokens: 1 } }];
  const sent = [];
  const claude = createClaudeAssistant({ getAI: () => ({ beta: { messages: { /** 依序回應 @returns {Promise<object>} 回應 */ async create(body) { sent.push(body); return replies.shift(); } } } }), model: 'claude-sonnet-5-5' });
  let claudeRuns = 0;
  const claudeResult = await claude.fill({ instructions: '指示', context: {}, lists: LISTS, tools, maxToolCalls: 2, runTool: /** 計次，第 2 次回錯誤 @returns {Promise<object>} 結果 */ async () => { claudeRuns += 1; return claudeRuns === 2 ? { error: '暫時無法讀取' } : { result: {} }; } });
  assert.equal(claudeRuns, 2, '上限 2 時第三次不執行');
  assert.equal(claudeResult.toolsUsed.length, 2);
  assert.deepEqual(claudeResult.toolsSucceeded, ['policy_lookup'], '回錯誤的呼叫不算成功');
  assert.equal(sent.length, 2, '用完上限後不再進工具階段，直接產生結果');
  assert.deepEqual(claudeResult.proposals, []);
});

test('引擎處理方案：只採信這個類型可填、沒鎖定的欄位；能不能送依後端驗證；問題寫出欄位與原因；依據只留本回合成功回傳的工具', () => {
  const leave = getRequestTypes().find('leave');
  const proposals = [{ title: '週二', summary: '整天', reasons: ['理由。'], updates: [{ key: 'leave_type', value: '事假' }, { key: 'applicant', value: 'someone.else' }, { key: 'agent', value: 'two.it' }, { key: 'nope', value: 'x' }], basis: ['my_leave_balance', 'calendar_busy'] }];
  const [draft] = proposalInputs({ type: leave, input: { leave_type: '特休' }, locked: new Set(['agent']), proposals });
  assert.deepEqual(draft.updates, [{ key: 'leave_type', value: '事假' }], '本人欄位、鎖定欄位與不存在的欄位都不套用');
  assert.deepEqual(draft.input, { leave_type: '事假' });
  const result = { missing: ['start_at'], invalid: [{ key: 'end_at', message: '格式不對。' }], failures: [{ key: 'leave_type', message: '剩餘時數不足' }] };
  const view = proposalView({ ...draft, result }, 0, { type: leave, hasDepartment: true, toolsSucceeded: ['my_leave_balance'] });
  assert.equal(view.id, 'p1');
  assert.equal(view.valid, false);
  assert.deepEqual(view.basis, ['my_leave_balance'], '沒有成功回傳的 calendar_busy 不能當依據');
  assert.deepEqual(view.reasons, ['理由']);
  assert.equal(view.problems.length, 3);
  assert.match(view.problems[0].message, /^缺少「.+」$/);
  assert.deepEqual(view.problems.slice(1), [{ key: 'end_at', message: '格式不對' }, { key: 'leave_type', message: '剩餘時數不足' }]);
  const ok = proposalView({ ...draft, result: { missing: [], invalid: [], failures: [] } }, 1, { type: leave, hasDepartment: true, toolsSucceeded: [] });
  assert.deepEqual([ok.id, ok.valid, ok.problems, ok.basis], ['p2', true, [], []]);
  assert.equal(proposalView({ ...draft, result: { missing: [], invalid: [], failures: [] } }, 0, { type: leave, hasDepartment: false, toolsSucceeded: [] }).valid, false, '沒有處理部門不能送');
});

test('引擎整合：方案經驗證、不寫進欄位，AI 同時寫進 updates 的方案欄位也略過；依據只留成功的工具；同樣的查詢只查一次；工具上限照類型；行事曆工具只交給 tools/list 有列出的人；連接狀態不連外部服務', async () => {
  const clock = /** 固定在台北 2026-11-01（週日）上午 @returns {number} epoch 毫秒 */ () => Date.UTC(2026, 10, 1, 2, 0);
  const config = { ...env, aiApiKey: 'test-key-not-real' };
  const ranges = [];
  const listed = [];
  const failures = { count: 0 };
  const calendar = {
    /** 只有 emily.wu 連接了行事曆 @param {string} username 帳號 @returns {Promise<string[]>} 可用的工具 */
    async listAvailable(username) { listed.push(username); return username === 'emily.wu' ? ['calendar_busy', 'calendar_events'] : []; },
    /** 記錄查詢期間；failures.count 大於 0 時這次回錯誤 @param {string} username 帳號 @param {string} tool 工具 @param {object} range 期間 @returns {Promise<object>} 結果 */
    async call(username, tool, range) {
      ranges.push({ username, tool, range });
      if (failures.count > 0) { failures.count -= 1; return { error: 'Google 暫時無法回應' }; }
      return { result: { busy: [] } };
    },
  };
  const statuses = { 'emily.wu': { name: 'Google 行事曆', status: 'ACTIVE', tools: ['calendar_busy', 'calendar_events'] }, 'frank.liu': { name: 'Google 行事曆', status: 'NEEDS_RECONNECT', tools: [] } };
  const connectors = {
    /** 只讀連接狀態 @param {string} username 帳號 @param {string} connectorId 連接器 id @returns {{status: string, tools: string[]}} 狀態 @throws {Error} 模擬連接器設定檔壞掉 */
    statusOf(username, connectorId) {
      assert.equal(connectorId, 'google_calendar');
      if (username === 'cindy.wang') throw new Error('connectors.json 壞掉');
      return statuses[username] ?? { name: 'Google 行事曆', status: 'NOT_CONNECTED', tools: [] };
    },
  };
  const requests = [];
  const assistant = {
    /** 不應被呼叫 @returns {never} @throws {Error} 意外呼叫 */
    classify() { throw new Error('must not classify'); },
    /** 呼叫工具（同樣的行事曆查詢兩次）後回兩個方案，updates 也寫了方案的欄位 @param {object} request 參數 @returns {Promise<object>} 結果 */
    async fill(request) {
      requests.push(request);
      const range = { start_at: '2026-11-03T09:00', end_at: '2026-11-03T18:00' };
      const calls = [['calendar_busy', range], ['calendar_busy', range], ['policy_lookup', { query: '特休' }]];
      const outputs = [];
      for (const [id, args] of calls) outputs.push(await request.runTool(id, args));
      return { intent: '請特休', typeId: request.context.request_type.id, departmentId: 'dept-hr-1', confidence: 90, handlerId: null, reply: '整理了兩個方案', model: 'test-model',
        updates: [{ key: 'leave_type', value: '事假' }, { key: 'note', value: '家中有事' }],
        toolsUsed: calls.map(/** 取 id @param {Array} item 呼叫 @returns {string} id */ ([id]) => id), outputs,
        toolsSucceeded: calls.filter(/** 成功的呼叫 @param {Array} item 呼叫 @param {number} index 位置 @returns {boolean} 是時 true */ (item, index) => !outputs[index].error).map(/** 取 id @param {Array} item 呼叫 @returns {string} id */ ([id]) => id),
        proposals: [
          { title: '週二請一天', summary: '整天', reasons: ['當天沒有行程'], updates: [{ key: 'leave_type', value: '特休' }, { key: 'start_at', value: '2026-11-03T09:00' }, { key: 'end_at', value: '2026-11-03T18:00' }], basis: ['calendar_busy', 'my_leave_balance'] },
          { title: '只填假別', summary: '時間再決定', reasons: [], updates: [{ key: 'leave_type', value: '病假' }], basis: ['policy_lookup'] },
        ] };
    },
  };
  const types = getRequestTypes();
  const engine = createDraftEngine({ types, departments: departmentService, accounts: accountService, store: dataStore, usage: createUsageService({ store: createMemoryLimitStore(), config, clock }), assistant, config, clock, calendar, connectors });
  const department = departmentService.findDepartment('dept-hr-1');
  const userOf = /** 人資部的憑證身分 @param {string} username 帳號 @returns {object} 身分 */ (username) => ({ username, userID: `user-${username}`, role: 'USER', department: { id: department.id, name: department.name } });
  const request = parseDraftRequest({ subject: '想請特休', message: '下週二請一天', state: { type_id: 'leave', department_id: 'dept-hr-1', fields: {} } }, { types, departments: departmentService });

  const body = await engine.run(userOf('emily.wu'), request);
  const [sent] = requests;
  assert.equal(sent.maxToolCalls, 5, '請假定義檔的 ai.max_tool_calls');
  assert.deepEqual(sent.tools.map(/** 取 id @param {{id: string}} tool 工具 @returns {string} id */ (tool) => tool.id), ['colleagues', 'my_leave_balance', 'my_pending_tickets', 'department_directory', 'calendar_busy', 'calendar_events', 'policy_lookup']);
  assert.deepEqual(ranges, [{ username: 'emily.wu', tool: 'calendar_busy', range: { start: '2026-11-03T09:00:00+08:00', end: '2026-11-03T18:00:00+08:00' } }], '期間照類型時區轉成 RFC 3339；同樣的查詢第二次由快取回，不再查 Google');
  assert.deepEqual(body.connections, [{ id: 'google_calendar', name: 'Google 行事曆', status: 'ACTIVE', tools: ['calendar_busy', 'calendar_events'] }]);
  assert.deepEqual(body.tools_used, ['calendar_busy', 'calendar_busy', 'policy_lookup']);
  assert.equal(body.values.leave_type, '', '方案不寫進欄位，AI 同時寫進 updates 的方案欄位也略過');
  assert.equal(body.values.note, '家中有事', '方案沒有的欄位照常採用');
  assert.deepEqual(body.proposals.map(/** 取摘要 @param {{id: string, title: string, basis: string[]}} item 方案 @returns {Array} 摘要 */ (item) => [item.id, item.title, item.basis]), [['p1', '週二請一天', ['calendar_busy']], ['p2', '只填假別', ['policy_lookup']]], '依據只留本回合成功回傳的工具');
  assert.deepEqual(body.proposals.map(/** 取依據名稱 @param {{basis_labels: string[]}} item 方案 @returns {string[]} 名稱 */ (item) => item.basis_labels), [['行事曆忙碌時段'], ['公司規章']], '依據附目錄的顯示名稱');
  assert.equal(typeof body.proposals[0].valid, 'boolean');
  assert.equal(body.proposals[1].valid, false);
  assert.ok(body.proposals[1].problems.some(/** 缺起點 @param {{key: string}} problem 問題 @returns {boolean} 是時 true */ (problem) => problem.key === 'start_at'), '缺少的欄位列在 problems');

  const other = await engine.run(userOf('frank.liu'), request);
  assert.deepEqual(requests[1].tools.map(/** 取 id @param {{id: string}} tool 工具 @returns {string} id */ (tool) => tool.id), ['colleagues', 'my_leave_balance', 'my_pending_tickets', 'department_directory', 'policy_lookup'], '沒連接的人 AI 看不到行事曆工具');
  assert.deepEqual(other.connections, [{ id: 'google_calendar', name: 'Google 行事曆', status: 'NEEDS_RECONNECT', tools: [] }], '分得出需要重新連接');
  assert.deepEqual(other.tools_used, ['calendar_busy', 'calendar_busy', 'policy_lookup']);
  assert.deepEqual(other.proposals[0].basis, [], 'calendar_busy 回錯誤（沒連接），不能當依據');
  assert.equal(ranges.length, 1);
  assert.deepEqual(listed, ['emily.wu', 'frank.liu'], '只有呼叫 AI 時才經 MCP 列工具');

  const manual = parseDraftRequest({ subject: '想請特休', state: { type_id: 'leave', department_id: 'dept-hr-1', fields: { leave_type: '特休' } } }, { types, departments: departmentService });
  const checked = await engine.run(userOf('emily.wu'), manual);
  assert.equal(requests.length, 2, '手動編輯的驗證不呼叫 AI');
  assert.equal(listed.length, 2, '也不經 MCP、不連 Google');
  assert.deepEqual(checked.connections, [{ id: 'google_calendar', name: 'Google 行事曆', status: 'ACTIVE', tools: ['calendar_busy', 'calendar_events'] }]);
  assert.deepEqual(checked.proposals, []);
  assert.deepEqual((await engine.run(userOf('cindy.wang'), manual)).connections, [{ id: 'google_calendar', name: 'google_calendar', status: 'UNAVAILABLE', tools: [] }], '連接器設定檔壞掉時當成不能連接，請求照常，名稱用 id');

  const general = parseDraftRequest({ subject: '一個問題', message: '請幫我看看', state: { type_id: 'general', department_id: 'dept-it-1', fields: {} } }, { types, departments: departmentService });
  const generalBody = await engine.run(userOf('emily.wu'), general);
  assert.equal(requests.at(-1).maxToolCalls, 3, '沒有設定的類型照目錄的 3');
  assert.deepEqual(generalBody.connections, [], '沒有需要連接的工具');

  failures.count = 1;
  const retried = await engine.run(userOf('emily.wu'), request);
  assert.equal(ranges.length, 3, '第一次回錯誤不留快取，第二次同樣的查詢再向 Google 查');
  assert.deepEqual(retried.proposals[0].basis, ['calendar_busy'], '第二次查到了，可以當依據');
});

test('有備援時兩段期限：加起來在前端的等待上限內（留 5 秒給驗證與網路），也在自動生成的並行租約內', async () => {
  const { PRIMARY_DRAFT_TIMEOUT_MS, FALLBACK_DRAFT_TIMEOUT_MS } = await import('../src/services/ai/providers.js');
  const frontend = readFileSync(new URL('../../frontend/src/services/ticketService.js', import.meta.url), 'utf8');
  const wait = Number(/export const DRAFT_REQUEST_TIMEOUT_MS = (\d+);/.exec(frontend)?.[1]);
  assert.equal(wait, 70000, '前端自動生成的等待上限');
  const total = PRIMARY_DRAFT_TIMEOUT_MS + FALLBACK_DRAFT_TIMEOUT_MS;
  assert.ok(total + 5000 <= wait, `兩段共 ${total} 毫秒，前端等 ${wait} 毫秒`);
  const time = { now: Date.UTC(2026, 10, 1, 2, 0) };
  const usage = createUsageService({ store: createMemoryLimitStore(), config: env, clock: /** 可調整的時間 @returns {number} epoch 毫秒 */ () => time.now });
  await usage.reserveDraft('user-lease-check');
  time.now += total;
  await assert.rejects(usage.reserveDraft('user-lease-check'), { code: 'REQUEST_IN_PROGRESS' }, '兩段都用完時租約還在，同一帳號不能同時再送');
});
