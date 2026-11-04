import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestEnv } from './helpers/testEnv.js';

setupTestEnv();

const { loadRequestTypes, getRequestTypes, DEFAULT_TYPES_DIR, CATALOG_FILE } = await import('../src/services/requestTypes/registry.js');
const { computeWorkMinutes, normalizeCalendar, executeTool, parseToolParams, applyAccess } = await import('../src/services/requestTypes/capabilities.js');
const { normalizeFieldValue, fieldError, clientField } = await import('../src/services/requestTypes/fieldTypes.js');
const { compileTemplate, renderSegments } = await import('../src/services/requestTypes/renderer.js');
const { evaluateForm, renderContent, buildPrompt, parseFormInput } = await import('../src/services/requestTypes/evaluator.js');
const { createGeminiAssistant, buildFill, buildClassification, fillSchema, toolDeclaration, DRAFT_TIMEOUT_MS } = await import('../src/services/requestTypes/aiAssistant.js');
const { parseDraftRequest, greetingFor } = await import('../src/services/requestTypes/draftEngine.js');
const { createDepartmentService } = await import('../src/services/departmentService.js');
const { createAccountService } = await import('../src/services/personnel/accountService.js');
const { LEDGER_TABLES } = await import('../src/services/storage/database.js');

// 測試用部門與帳號；全部為假資料，與實際環境無關。
const departments = createDepartmentService({ departments: [
  { id: 'dept-it-1', name: '資訊管理一部', duty: 'IT資訊服務台', business: ['IT資訊服務台'] },
  { id: 'dept-hr-1', name: '人力資源部', duty: '人事', business: ['人事'] },
  { id: 'dept-ga-1', name: '總務與硬體組', duty: '辦公設備', business: ['辦公設備'] },
  { id: 'dept-fin-1', name: '財務部', duty: '報帳', business: ['報帳'] },
  { id: 'dept-pur-1', name: '採購部', duty: '採購', business: ['採購'] },
] });
const accounts = createAccountService({ departments, accounts: [
  { username: 'one.it', department_id: 'dept-it-1' }, { username: 'two.it', department_id: 'dept-it-1' }, { username: 'three.it', department_id: 'dept-it-1' },
  { username: 'hr.one', department_id: 'dept-hr-1' }, { username: 'ga.one', department_id: 'dept-ga-1' }, { username: 'boss.admin', department_id: 'dept-it-1', role: 'ADMIN' },
] });
const user = accounts.find('one.it');
const realFiles = Object.fromEntries(readdirSync(DEFAULT_TYPES_DIR).filter(/** 只取 JSON。@param {string} name 檔名。@returns {boolean} JSON 時 true。 */ (name) => name.endsWith('.json'))
  .map(/** 讀出原始內容。@param {string} name 檔名。@returns {[string, string]} [檔名, 內容]。 */ (name) => [name, readFileSync(join(DEFAULT_TYPES_DIR, name), 'utf8')]));
const types = loadRequestTypes({ departments });

/**
 * 以記憶體中的檔案載入目錄（不寫入磁碟）：先複製實際定義，再套用修改。
 * @param {(files: Record<string, object|string>) => void} mutate 修改函式，收到「檔名 → 解析後物件（或字串，表示原樣寫入）」。
 * @returns {object} 需求類型目錄。
 * @throws {Error} 定義檔驗證失敗。
 */
function loadVariant(mutate) {
  const files = Object.fromEntries(Object.entries(realFiles).map(/** 解析實際內容。@param {[string, string]} entry 檔案。@returns {[string, object]} 解析後內容。 */ ([name, text]) => [name, JSON.parse(text)]));
  mutate(files);
  /**
   * 讀檔替身：依檔名回傳記憶體內容，不存在時拋出 ENOENT。
   * @param {string} path 路徑。
   * @returns {string} 內容。
   * @throws {Error} ENOENT。
   */
  function read(path) {
    const name = path.split(/[\\/]/u).pop();
    if (!(name in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return typeof files[name] === 'string' ? files[name] : JSON.stringify(files[name]);
  }
  return loadRequestTypes({ departments, read });
}

/**
 * 建立交易內 ledger 查詢的替身：額度固定、期間重疊依設定的帳號判斷，並記錄呼叫。
 * @param {object} [options={}] 設定。
 * @param {Set<string>} [options.busy=new Set()] 期間內已有申請的帳號。
 * @param {number} [options.remaining=6720] 每個類別的剩餘額度。
 * @returns {object} helpers 替身與 calls 紀錄。
 */
function fakeHelpers({ busy = new Set(), remaining = 6720 } = {}) {
  const calls = [];
  return {
    calls,
    /** 回傳固定額度。@param {object} spec 規格。@param {string} username 帳號。@param {number} period 期間。@returns {object[]} 額度。 */
    ledgerBalances(spec, username, period) { calls.push(['balances', username, period]); return spec.categories.map(/** 建立額度。@param {string} category 類別。@returns {object} 額度。 */ (category) => ({ category, granted: remaining, adjusted: 0, used: 0, pending: 0, remaining })); },
    /** 本人重疊判斷。@param {object} spec 規格。@param {string} username 帳號。@returns {boolean} 重疊時 true。 */
    ledgerOverlaps(spec, username) { calls.push(['overlap', username]); return busy.has(username); },
    /** 期間內已有申請的帳號。@param {object[]} specs 規格。@param {string[]} usernames 帳號。@returns {Set<string>} 帳號。 */
    ledgerBusy(specs, usernames) { calls.push(['busy', ...usernames]); return new Set(usernames.filter(/** 是否忙碌。@param {string} name 帳號。@returns {boolean} 忙碌時 true。 */ (name) => busy.has(name))); },
    /** 員工存在。@returns {boolean} true。 */
    employeeExists() { return true; },
  };
}

/**
 * 以預設參數執行 evaluateForm。
 * @param {object} type 需求類型。
 * @param {Record<string, string>} input 欄位值。
 * @param {object} [extra={}] 覆寫參數。
 * @returns {object} 驗證結果。
 */
function evaluate(type, input, extra = {}) {
  return evaluateForm({ type, input, user, department: { id: type.departmentId ?? 'dept-it-1', name: 'x' }, registry: types, accounts, departments,
    helpers: fakeHelpers(), today: '2026-11-01', phase: 'draft', ...extra });
}

/**
 * 驗證實際定義檔可載入：目錄、七種類型（目錄順序即關鍵字備援的比對順序）、對外形狀、版本與期間規格；設定檔內容與規格書約定的值一致。
 * @returns {void}
 */
function realDefinitions() {
  assert.deepEqual(types.ids(), ['leave', 'attendance', 'vpn', 'repair', 'equipment', 'purchase', 'general']);
  assert.equal(types.defaultType().id, 'general');
  const leave = types.find('leave');
  assert.equal(leave.version, 2);
  assert.equal(leave.departmentId, 'dept-hr-1');
  assert.deepEqual(leave.ai.tools, ['colleagues', 'my_leave_balance', 'department_directory']);
  assert.deepEqual(types.busySpecs(), [{ typeId: 'leave', startField: 'start_at', endField: 'end_at' }]);
  assert.deepEqual(Object.keys(types.forClient(leave)), ['id', 'version', 'name', 'summary', 'department', 'fields', 'computed', 'workflow']);
  assert.deepEqual(types.forClient(leave).computed, [{ key: 'minutes', label: '請假時數', display: 'hours_minutes' }]);
  assert.deepEqual(types.forClient(leave).workflow, { transfer: false, not_requester: true });
  assert.deepEqual(types.forClient(types.find('equipment')).workflow, { transfer: true, not_requester: true });
  assert.deepEqual(types.draftView(leave).department, { id: 'dept-hr-1', name: '人力資源部' });
  assert.equal(types.draftView(types.find('general')).department, null);
  assert.deepEqual(types.forClient(leave).fields[4], { key: 'agent', label: '代理人', type: 'account', required: true });
  assert.deepEqual(types.forClient(types.find('equipment')).fields[2], { key: 'quantity', label: '數量', type: 'number', required: true, min: 1, max: 50, integer: true });
  assert.deepEqual(types.forClient(types.find('equipment')).department, { id: 'dept-ga-1', name: '總務與硬體組' });
  assert.equal(types.forClient(types.find('general')).department, null);
  assert.ok(!JSON.stringify(types.forClient(leave)).includes('greeting'), '對外形狀不含 AI 專用文字');
  assert.equal(types.match('12 月想請特休').id, 'leave');
  assert.equal(types.match('想申請螢幕').id, 'equipment');
  assert.equal(types.match('印表機卡紙').id, 'general', '沒有相符時為預設類型');
  for (const type of types.list()) {
    assert.equal(type.handler, null, `${type.id} 不提供指定處理人（提出需求單頁已移除這個欄位）`);
    assert.ok(!type.ai.tools.includes('department_members'), `${type.id} 不開放查部門成員`);
  }
  assert.equal(types.ledgerOwner('leave_entitlements').id, 'leave');
  const view = types.aiView(leave);
  assert.ok(!view.fields.some(/** 是否含申請人。@param {object} field 欄位。@returns {boolean} self 時 true。 */ (field) => field.type === 'self'));
  assert.deepEqual(view.rules_data.calendar.work_windows, ['09:00-12:00', '13:00-18:00']);
  assert.equal(getRequestTypes().ids().length, 7, '預設目錄（實際部門設定）可載入');
  assert.equal(DRAFT_TIMEOUT_MS, 20000);
}
test('實際需求類型目錄與定義檔可載入', realDefinitions);

/**
 * 驗證定義檔錯誤會讓載入失敗，訊息含檔名與鍵路徑：JSON 語法、未知欄位型別、未知能力、錯誤的佔位文字、不存在的部門、
 * 工具參照、額度資料表允許清單、存取規則、未知的頂層鍵與目錄的預設類型。
 * @returns {void}
 */
function invalidDefinitions() {
  const cases = [
    [/** JSON 語法錯誤。@param {object} files 檔案。@returns {void} */ (files) => { files['leave.json'] = '{ "id": '; }, /^leave\.json 不是有效的 JSON/u],
    [/** 未知欄位型別。@param {object} files 檔案。@returns {void} */ (files) => { files['leave.json'].fields[1].type = 'color'; }, /^leave\.json fields\[1\]\.type 未知的欄位型別「color」/u],
    [/** 未知計算能力。@param {object} files 檔案。@returns {void} */ (files) => { files['leave.json'].computations[0].capability = 'magic'; }, /^leave\.json computations\[0\]\.capability 未知的計算能力「magic」/u],
    [/** 未知檢查能力。@param {object} files 檔案。@returns {void} */ (files) => { files['leave.json'].checks[0].capability = 'quota'; }, /^leave\.json checks\[0\]\.capability 未知的檢查能力/u],
    [/** 未知工具能力。@param {object} files 檔案。@returns {void} */ (files) => { files['_catalog.json'].tools[0].capability = 'sql'; }, /^_catalog\.json tools\[0\]\.capability 未知的工具能力/u],
    [/** 錯誤的佔位文字。@param {object} files 檔案。@returns {void} */ (files) => { files['leave.json'].render.lines[2] = '[x]: {nope}'; }, /^leave\.json render\.lines\[2\] 的佔位文字「\{nope\}」/u],
    [/** 未知篩選器。@param {object} files 檔案。@returns {void} */ (files) => { files['equipment.json'].render.lines[4] = '[d]: {needed_by|upper}'; }, /^equipment\.json render\.lines\[4\] 使用了未知的篩選器「upper」/u],
    [/** 大括號不成對。@param {object} files 檔案。@returns {void} */ (files) => { files['general.json'].render.lines[0] = '[x]: {description'; }, /^general\.json render\.lines\[0\] 「\{」沒有對應的「\}」/u],
    [/** 不存在的部門。@param {object} files 檔案。@returns {void} */ (files) => { files['equipment.json'].department_id = 'dept-x'; }, /^equipment\.json department_id 「dept-x」不是部門設定檔中存在的部門 id/u],
    [/** 不存在的工具。@param {object} files 檔案。@returns {void} */ (files) => { files['leave.json'].ai.tools.push('payroll'); }, /^leave\.json ai\.tools 參照的工具「payroll」/u],
    [/** 不允許的額度表。@param {object} files 檔案。@returns {void} */ (files) => { files['leave.json'].ledger.entitlement_table = 'accounts'; }, /^leave\.json ledger\.entitlement_table 「accounts」不在允許的額度資料表/u],
    [/** 額度表不允許的類別。@param {object} files 檔案。@returns {void} */ (files) => { files['leave.json'].fields[1].options.push('公假'); }, /^leave\.json ledger\.category_field 的選項 公假 不是 leave_entitlements 允許的類別/u],
    [/** 存取規則太寬。@param {object} files 檔案。@returns {void} */ (files) => { files['_catalog.json'].tools[3].access = 'all'; }, /^_catalog\.json tools\[3\]\.access 能力 my_ledger_balance 必須使用 self_only/u],
    [/** 拼錯的頂層鍵。@param {object} files 檔案。@returns {void} */ (files) => { files['equipment.json'].workflo = {}; }, /^equipment\.json workflo 是未知的鍵/u],
    [/** 預設類型不存在。@param {object} files 檔案。@returns {void} */ (files) => { files['_catalog.json'].default_type = 'misc'; }, /^_catalog\.json default_type 必須是 types 中的 id/u],
    [/** 名稱與目錄不同。@param {object} files 檔案。@returns {void} */ (files) => { files['equipment.json'].name = '其他'; }, /^equipment\.json name 必須與 _catalog\.json 的 name「設備申請」相同/u],
    [/** 檔案不存在。@param {object} files 檔案。@returns {void} */ (files) => { delete files['general.json']; }, /^general\.json 無法讀取（ENOENT）/u],
    [/** 日曆錯誤。@param {object} files 檔案。@returns {void} */ (files) => { files['leave.json'].calendar.work_windows = [['12:00', '09:00']]; }, /^leave\.json calendar\.work_windows\[0\] 的起始時間必須早於結束時間/u],
    [/** after 參照錯誤。@param {object} files 檔案。@returns {void} */ (files) => { files['leave.json'].fields[3].rules.after = 'note'; }, /^leave\.json fields\[3\]\.rules\.after 必須參照另一個相同型別的日期欄位/u],
    [/** options_tool 型別不符。@param {object} files 檔案。@returns {void} */ (files) => { files['leave.json'].fields[4].options_tool = 'department_directory'; }, /^leave\.json fields\[4\]\.options_tool 工具「department_directory」不能提供 account 選項/u],
    [/** FORM 需要固定部門。@param {object} files 檔案。@returns {void} */ (files) => { files['general.json'].workflow.route = 'FORM'; }, /^general\.json workflow\.route FORM 需要固定的 department_id/u],
    [/** 數字範圍。@param {object} files 檔案。@returns {void} */ (files) => { files['equipment.json'].fields[2].min = 100; }, /^equipment\.json fields\[2\]\.min 不可大於 max/u],
    [/** 工具參數不符合能力合約。@param {object} files 檔案。@returns {void} */ (files) => { delete files['_catalog.json'].tools[2].params.end_at; }, /^_catalog\.json tools\[2\]\.params 必須符合能力 colleagues 的參數合約/u],
  ];
  for (const [mutate, pattern] of cases) {
    /** 載入有錯的變體。@returns {object} 目錄。@throws {Error} 驗證失敗。 */
    function load() { return loadVariant(mutate); }
    assert.throws(load, /** 檢查錯誤代碼與訊息。@param {Error} error 錯誤。@returns {boolean} 符合時 true。 */ (error) => error.code === 'REQUEST_TYPES_INVALID' && pattern.test(error.message), pattern.source);
  }
  assert.equal(CATALOG_FILE, '_catalog.json');
}
test('定義檔錯誤時清楚指出檔名與鍵路徑', invalidDefinitions);

/**
 * 驗證工作日曆的時數計算（與原本請假規則相同）：上班時段、午休、週末、假日、跨日、跨年度、天數上限、單位進位與定義的訊息。
 * @returns {void}
 */
function workMinutes() {
  const leave = types.find('leave');
  const calendar = normalizeCalendar({ timezone_offset: '+08:00', work_windows: [['09:00', '12:00'], ['13:00', '18:00']], workdays: [1, 2, 3, 4, 5],
    holidays: { 2026: ['2026-12-25'], 2027: [] }, unit_minutes: 1, min_minutes: 1, max_days: 14 }, 'test.calendar');
  const { messages } = leave.computations[0];
  assert.deepEqual(computeWorkMinutes('2026-12-01T09:30', '2026-12-01T17:30', calendar), { ok: true, minutes: 420, year: 2026 }, '規格範例：週二 09:30～17:30 為 420 分鐘');
  assert.equal(computeWorkMinutes('2026-12-01T09:00', '2026-12-01T18:00', calendar).minutes, 480);
  assert.equal(computeWorkMinutes('2026-12-01T08:00', '2026-12-01T20:00', calendar).minutes, 480, '上班時段外不計');
  assert.equal(computeWorkMinutes('2026-12-01T13:00', '2026-12-03T12:00', calendar).minutes, 960, '跨日：300 + 480 + 180');
  assert.equal(computeWorkMinutes('2026-12-04T09:00', '2026-12-07T18:00', calendar).minutes, 960, '週末不計');
  /** 檢查失敗結果。@param {string} start 起始。@param {string} end 截止。@param {string} arg 參數。@param {RegExp} pattern 訊息。@returns {void} */
  function fails(start, end, arg, pattern) {
    const result = computeWorkMinutes(start, end, calendar, messages);
    assert.equal(result.ok, false, `${start}～${end}`);
    assert.equal(result.arg, arg);
    assert.match(result.message, pattern);
  }
  fails('2026-12-01T12:00', '2026-12-01T13:00', 'end', /^請假期間沒有落在上班時段$/u);
  fails('2026-12-25T09:00', '2026-12-25T18:00', 'end', /沒有落在上班時段/u);
  fails('2026-12-31T09:00', '2027-01-04T18:00', 'end', /^請假期間不可跨年度，請分開申請$/u);
  fails('2026-11-02T09:00', '2026-11-17T09:00', 'end', /^請假期間最多 14 天$/u);
  fails('2028-01-03T09:00', '2028-01-03T18:00', 'start', /^2028 年度尚未開放請假$/u);
  assert.match(computeWorkMinutes('2026-12-05T09:00', '2026-12-06T18:00', calendar).message, /^期間沒有落在上班時段$/u, '沒有覆寫時使用通用訊息');
  const coarse = normalizeCalendar({ timezone_offset: '+08:00', work_windows: [['09:00', '18:00']], workdays: [1, 2, 3, 4, 5], holidays: { 2026: [] }, unit_minutes: 30, min_minutes: 30, max_days: 1 }, 'c');
  assert.equal(computeWorkMinutes('2026-12-01T09:00', '2026-12-01T09:10', coarse).minutes, 30, '依單位向上取整');
  const result = evaluate(leave, { leave_type: '特休', start_at: '2026-12-01T09:30', end_at: '2026-12-01T17:30', agent: 'two.it' });
  assert.deepEqual(result.computed, [{ key: 'minutes', label: '請假時數', value: 420, text: '7 小時 0 分鐘' }], '實際定義的計算結果');
}
test('work_minutes 依定義的工作日曆計算', workMinutes);

/**
 * 驗證欄位型別的整理與檢查：datetime／date 正規化、number 範圍與整數、not_before_today、after、enum、text 與帳號篩選。
 * @returns {void}
 */
function fieldRules() {
  const leave = types.find('leave');
  const equipment = types.find('equipment');
  assert.equal(normalizeFieldValue(leave.fieldsByKey.get('start_at'), ' 2026-12-01 09:30 '), '2026-12-01T09:30');
  assert.equal(normalizeFieldValue(leave.fieldsByKey.get('start_at'), '2026/12/1 9:30'), '2026-12-01T09:30');
  assert.equal(normalizeFieldValue(equipment.fieldsByKey.get('needed_by'), '2026/12/5'), '2026-12-05');
  assert.equal(normalizeFieldValue(leave.fieldsByKey.get('note'), ' 第一行\n 第二行 '), '第一行 第二行');
  assert.equal(normalizeFieldValue(types.find('general').fieldsByKey.get('description'), ' 第一行\r\n第二行 '), '第一行\n第二行', 'multiline 保留換行');
  /** 取第一個錯誤。@param {object} type 類型。@param {object} input 欄位。@param {object} [extra] 參數。@returns {string|undefined} 訊息。 */
  const firstError = (type, input, extra) => evaluate(type, input, extra).invalid[0]?.message;
  const goodEquipment = { item: '27 吋螢幕', quantity: '2', purpose: '雙螢幕開發', needed_by: '2026-11-20', location: '3F A 區' };
  assert.deepEqual(evaluate(equipment, goodEquipment).invalid, []);
  assert.equal(firstError(equipment, { ...goodEquipment, quantity: '0' }), '數量不可小於 1');
  assert.equal(firstError(equipment, { ...goodEquipment, quantity: '51' }), '數量不可大於 50');
  assert.equal(firstError(equipment, { ...goodEquipment, quantity: '2.5' }), '數量必須是整數');
  assert.equal(firstError(equipment, { ...goodEquipment, quantity: '兩台' }), '數量必須是數字');
  assert.equal(firstError(equipment, { ...goodEquipment, needed_by: '2026-10-31' }), '需要日期不可早於今天');
  assert.equal(firstError(equipment, { ...goodEquipment, needed_by: '2026-02-30' }), '需要日期格式需為 YYYY-MM-DD');
  assert.equal(firstError(equipment, { ...goodEquipment, item: '字'.repeat(51) }), '設備品項最多 50 字');
  assert.deepEqual(evaluate(equipment, {}).missing, ['item', 'quantity', 'purpose', 'needed_by', 'location']);
  const goodLeave = { leave_type: '特休', start_at: '2026-12-01T09:30', end_at: '2026-12-01T17:30', agent: 'two.it' };
  assert.equal(firstError(leave, { ...goodLeave, leave_type: '公假' }), '假別請從「事假、病假、特休」擇一');
  assert.equal(firstError(leave, { ...goodLeave, end_at: '2026-12-01T09:00' }), '請假截止時間必須晚於請假起始時間');
  assert.equal(firstError(leave, { ...goodLeave, start_at: '12/01 09:30' }), '請假起始時間格式需為 YYYY-MM-DDTHH:mm');
  assert.equal(firstError(leave, { ...goodLeave, agent: 'one.it' }), '代理人不能是請假人本人');
  assert.equal(firstError(leave, { ...goodLeave, agent: 'hr.one' }), '代理人必須與請假人同部門');
  assert.equal(firstError(leave, { ...goodLeave, agent: 'boss.admin' }), '代理人必須是系統內的一般帳號');
  assert.equal(firstError(leave, goodLeave, { helpers: fakeHelpers({ busy: new Set(['two.it']) }) }), '這位同事在此期間也有請假，不能擔任代理人');
  const busyOptions = evaluate(leave, goodLeave, { helpers: fakeHelpers({ busy: new Set(['two.it']) }) }).fieldOptions.agent;
  assert.deepEqual(busyOptions, [{ id: 'two.it', name: 'two.it', available: false, reason: '此期間已有請假' }, { id: 'three.it', name: 'three.it', available: true }]);
  assert.deepEqual(evaluate(leave, goodLeave, { helpers: fakeHelpers({ busy: new Set(['one.it']) }) }).failures, [{ key: 'start_at', code: 'LEAVE_OVERLAP', message: '這段時間已有請假單' }], '本人重疊');
  assert.equal(firstError(leave, { ...goodLeave, note: '字'.repeat(201) }), '備註最多 200 字');
  const short = evaluate(leave, goodLeave, { helpers: fakeHelpers({ remaining: 300 }) });
  assert.deepEqual(short.failures, [{ key: 'leave_type', code: 'LEAVE_BALANCE_INSUFFICIENT', message: '假別剩餘時數不足' }]);
  assert.deepEqual(short.summaries, ['特休剩餘時數：5 小時 0 分鐘 → -2 小時 0 分鐘']);
  assert.deepEqual(short.ledger, { category: '特休', amount: 420, period: 2026, start: '2026-12-01T09:30', end: '2026-12-01T17:30' });
  assert.deepEqual(evaluate(leave, { ...goodLeave, leave_type: '' }).summaries, [], '尚未選類別時沒有摘要');
  assert.deepEqual(parseFormInput({ applicant: 'someone.else', note: '  a  b ' }, leave), { note: 'a b' }, 'self 欄位一律由後端決定');
  for (const [raw, pattern] of [[[], /必須是物件/u], [{ unknown: 'x' }, /只能包含/u], [{ note: 5 }, /必須是字串/u], [{ note: 'x'.repeat(501) }, /最多 500/u]]) {
    /** 嘗試解析無效欄位。@returns {object} 欄位。@throws {Error} 無效。 */
    function parse() { return parseFormInput(raw, leave); }
    assert.throws(parse, pattern);
  }
  assert.equal(fieldError({ key: 'd', label: '部門', type: 'department' }, 'dept-x', { departments }), '部門必須是存在的部門');
  assert.deepEqual(clientField(leave.fieldsByKey.get('leave_type')), { key: 'leave_type', label: '假別', type: 'enum', required: true, options: ['事假', '病假', '特休'] });
}
test('欄位型別的整理、規則與帳號篩選', fieldRules);

/**
 * 驗證渲染：實際定義的固定格式（單日、跨日、預覽骨架）、設備與一般需求，以及篩選器。
 * @returns {void}
 */
function rendering() {
  const leave = types.find('leave');
  const values = { applicant: 'one.it', leave_type: '特休', start_at: '2026-12-01T09:30', end_at: '2026-12-01T17:30', agent: 'two.it', note: '' };
  assert.equal(renderContent(leave, { values, computedMap: { minutes: 420 }, department: null, handler: null, departments }), [
    '[請假人]: one.it', '[請假日期]: 2026-12-01（週二）', '[請假起始時間]: 09:30', '[請假截止時間]: 17:30', '[假別]: 特休', '[請假時數]: 7 小時 0 分鐘', '[代理人]: two.it', '[備註]: 無',
  ].join('\n'));
  assert.equal(renderContent(leave, { values: { ...values, end_at: '2026-12-03T12:00', note: '家庭因素' }, computedMap: { minutes: 1050 }, department: null, handler: null, departments }).split('\n').slice(1, 6).join('\n'),
    '[請假日期]: 2026-12-01（週二）～ 2026-12-03（週四）\n[請假起始時間]: 09:30\n[請假截止時間]: 12:00\n[假別]: 特休\n[請假時數]: 17 小時 30 分鐘');
  assert.equal(renderContent(leave, { values: { applicant: 'one.it' }, computedMap: {}, department: null, handler: null, departments }),
    '[請假人]: one.it\n[請假日期]: \n[請假起始時間]: \n[請假截止時間]: \n[假別]: \n[請假時數]: \n[代理人]: \n[備註]: 無', '預覽骨架');
  assert.equal(renderContent(types.find('equipment'), { values: { applicant: 'one.it', item: '螢幕', quantity: '2', purpose: '開發', needed_by: '2026-11-20', location: '3F' }, computedMap: {}, department: null, handler: null, departments }),
    '[申請人]: one.it\n[設備品項]: 螢幕\n[數量]: 2\n[用途說明]: 開發\n[需要日期]: 2026-11-20（週五）\n[送交地點]: 3F');
  const general = types.find('general');
  assert.equal(renderContent(general, { values: { description: '印表機卡紙\n無法列印' }, computedMap: {}, department: { name: '資訊管理一部' }, handler: null, departments }),
    '[需求說明]: 印表機卡紙\n無法列印\n[處理部門]: 資訊管理一部');
  assert.equal(renderContent(general, { values: { description: '' }, computedMap: {}, department: null, handler: null, departments }), '[需求說明]: \n[處理部門]: ', '一般需求不再有指定處理人一行');
  const names = new Set(['a', 'b', 'n']);
  const segments = compileTemplate('{a|default:無}/{n|hours_minutes}/{a|date}/{b|time}', { names, fieldKeys: names, where: 'x' });
  /** 取值替身。@param {string} name 名稱。@returns {unknown} 值。 */
  const raw = (name) => ({ a: '', b: '2026-12-01T08:05', n: 61 })[name];
  assert.equal(renderSegments(segments, { raw, display: String }), '無/1 小時 1 分鐘//08:05');
  assert.equal(buildPrompt({ type: types.find('leave'), department: { name: '人力資源部' }, missing: ['leave_type', 'agent'], invalid: [], complete: false }), '這份需求單將送到「人力資源部」；還需要提供：假別、代理人');
  assert.equal(buildPrompt({ type: general, department: null, missing: ['department_id', 'description'], invalid: [], complete: false }), '請在右側選擇處理部門；還需要提供：需求說明');
}
test('需求內容依定義的 render.lines 渲染', rendering);

/**
 * 驗證新增的四種類型（打卡補登、VPN 申請、報修、採購申請）只靠 JSON 定義就能使用：
 * 1. 送達部門與對外的 workflow（能否轉單、本人不能簽核）；
 * 2. 有效輸入沒有缺漏與錯誤，並渲染出定義的固定文字（選填欄位以 default 篩選器補上「無」或「未指定」）；
 * 3. 數字範圍與整數、日期不可早於今天、截止日期必須晚於起始日期、選項擇一等規則的錯誤訊息；
 * 4. 沒有 AI 時的關鍵字備援：依目錄順序比對，故障類主題選報修、VPN 申請與 VPN 故障分開、補打卡不會選到請假；
 * 5. 第一回合的招呼語以帳號稱呼使用者並說明處理部門。
 * 今天固定為 2026-11-01（週日）。
 * @returns {void}
 */
function addedDefinitions() {
  const expectations = {
    attendance: { department: 'dept-hr-1', transfer: false },
    vpn: { department: 'dept-it-1', transfer: false },
    repair: { department: 'dept-ga-1', transfer: true },
    purchase: { department: 'dept-pur-1', transfer: false },
  };
  for (const [id, expected] of Object.entries(expectations)) {
    const type = types.find(id);
    assert.equal(type.departmentId, expected.department, `${id} 送達部門`);
    assert.deepEqual(types.forClient(type).workflow, { transfer: expected.transfer, not_requester: true }, `${id} workflow`);
  }
  /** 取錯誤訊息。@param {object} result evaluateForm 的結果。@returns {string[]} 訊息。 */
  const messages = (result) => result.invalid.map(/** 取訊息。@param {{message: string}} entry 錯誤。@returns {string} 訊息。 */ (entry) => entry.message);
  /** 渲染驗證後的值。@param {object} type 類型。@param {object} result evaluateForm 的結果。@returns {string} 內容。 */
  const render = (type, result) => renderContent(type, { values: result.values, computedMap: {}, department: null, handler: null, departments });

  const purchase = types.find('purchase');
  const bought = evaluate(purchase, { item: '影印紙', quantity: '10', budget: '3500', purpose: '部門日常列印', needed_by: '2026-11-20' });
  assert.deepEqual([bought.missing, bought.invalid], [[], []]);
  assert.equal(render(purchase, bought), '[申請人]: one.it\n[採購品項]: 影印紙\n[數量]: 10\n[預估總金額]: 新台幣 3500 元\n[採購用途]: 部門日常列印\n[需要日期]: 2026-11-20（週五）\n[建議供應商]: 未指定');
  assert.deepEqual(evaluate(purchase, {}).missing, ['item', 'quantity', 'budget', 'purpose', 'needed_by'], '建議供應商為選填');
  assert.deepEqual(messages(evaluate(purchase, { item: '筆電', quantity: '0', budget: '12.5', purpose: '新人', needed_by: '2026-10-01' })),
    ['數量不可小於 1', '預估總金額必須是整數', '需要日期不可早於今天']);

  const vpn = types.find('vpn');
  const remote = evaluate(vpn, { start_date: '2026-11-05', end_date: '2026-12-05', target: '檔案伺服器 fs01', purpose: '出差時存取部門文件', device: '公司配發電腦' });
  assert.deepEqual([remote.missing, remote.invalid], [[], []]);
  assert.equal(render(vpn, remote), '[申請人]: one.it\n[使用期間]: 2026-11-05（週四）～ 2026-12-05（週六）\n[連線對象]: 檔案伺服器 fs01\n[用途]: 出差時存取部門文件\n[使用電腦]: 公司配發電腦');
  assert.deepEqual(messages(evaluate(vpn, { start_date: '2026-11-10', end_date: '2026-11-10', target: 'ERP', purpose: '測試', device: '平板' })),
    ['使用截止日期必須晚於使用起始日期', '使用電腦請從「公司配發電腦、個人電腦」擇一']);
  assert.deepEqual(messages(evaluate(vpn, { start_date: '2026-10-31', end_date: '2026-11-30', target: 'ERP', purpose: '測試', device: '個人電腦' })), ['使用起始日期不可早於今天']);

  const attendance = types.find('attendance');
  const punched = evaluate(attendance, { punch_kind: '下班', punch_at: '2026-10-30T18:10', reason: '忘記打卡' });
  assert.deepEqual([punched.missing, punched.invalid], [[], []]);
  assert.equal(render(attendance, punched), '[申請人]: one.it\n[補登類別]: 下班\n[實際打卡時間]: 2026-10-30（週五） 18:10\n[補登原因]: 忘記打卡\n[說明]: 無');
  assert.deepEqual(messages(evaluate(attendance, { punch_kind: '中午', punch_at: '2026-10-30T12:00', reason: '睡過頭' })),
    ['補登類別請從「上班、下班」擇一', '補登原因請從「忘記打卡、打卡機故障、因公外出、其他」擇一']);

  const repair = types.find('repair');
  const broken = evaluate(repair, { asset: '螢幕', location: '3F 開發區', symptom: '畫面閃爍\n偶爾黑屏', urgency: '一般' });
  assert.deepEqual([broken.missing, broken.invalid], [[], []]);
  assert.equal(render(repair, broken), '[報修人]: one.it\n[故障設備]: 螢幕\n[所在位置]: 3F 開發區\n[故障狀況]: 畫面閃爍\n偶爾黑屏\n[緊急程度]: 一般');
  assert.deepEqual(messages(evaluate(repair, { asset: '冷氣', location: '會議室', symptom: '不冷', urgency: '超急' })), ['緊急程度請從「一般、急件」擇一']);

  for (const [subject, id] of [['昨天下班忘記打卡', 'attendance'], ['想申請 VPN', 'vpn'], ['VPN 連不上', 'general'], ['螢幕壞了', 'repair'], ['滑鼠故障', 'repair'],
    ['想申請螢幕', 'equipment'], ['想採購影印紙', 'purchase'], ['明天請特休', 'leave']]) {
    assert.equal(types.match(subject).id, id, `關鍵字備援：${subject}`);
  }
  const greeting = greetingFor({ types, type: repair, department: { id: 'dept-ga-1', name: '總務與硬體組' }, username: 'one.it' });
  assert.ok(greeting.startsWith('one.it 你好') && greeting.includes('總務與硬體組'));
}
test('新增的打卡補登、VPN 申請、報修與採購申請只靠 JSON 定義運作', addedDefinitions);

/**
 * 驗證只新增 JSON 就能加入新的需求類型：在目錄加一筆、提供定義檔，不改任何程式碼即可驗證欄位、產生選項與渲染內容。
 * 新類型使用 enum、number、date、department 與 account（department_members）欄位。
 * @returns {void}
 */
function newTypeByJsonOnly() {
  const registry = loadVariant(/** 加入新的會議室預約類型。@param {object} files 檔案。@returns {void} */ (files) => {
    files['_catalog.json'].types.push({ id: 'room', file: 'room.json', name: '會議室預約', summary: '預約會議室與設備。', keywords: ['會議室'] });
    files['room.json'] = {
      id: 'room', version: 1, name: '會議室預約', department_id: 'dept-ga-1',
      handler: { options_tool: 'department_members', not_self: true },
      ai: { description: '預約會議室：需要日期、人數與樓層。', examples: ['明天借會議室'], tools: ['department_directory'] },
      fields: [
        { key: 'booker', label: '預約人', type: 'self' },
        { key: 'floor', label: '樓層', type: 'enum', options: ['3F', '5F'], required: true },
        { key: 'day', label: '日期', type: 'date', required: true, rules: { not_before_today: true } },
        { key: 'people', label: '人數', type: 'number', required: true, min: 2, max: 20, integer: true },
        { key: 'owner_department', label: '使用部門', type: 'department', options_tool: 'department_directory' },
        { key: 'contact', label: '聯絡人', type: 'account', options_tool: 'department_members', filters: { active: true } },
      ],
      render: { lines: ['[預約人]: {booker}', '[樓層]: {floor}', '[日期]: {day|date}', '[人數]: {people}', '[使用部門]: {owner_department|default:未指定}', '[部門名稱]: {owner_department}', '[聯絡人]: {contact|default:無}'] },
      workflow: { route: 'FORM', approver: { department: 'definition', not_requester: true }, transfer: true },
    };
  });
  const room = registry.find('room');
  assert.equal(registry.match('想借會議室').id, 'room');
  assert.deepEqual(registry.forClient(room).fields.map(/** 取型別。@param {object} field 欄位。@returns {string} 型別。 */ (field) => field.type), ['self', 'enum', 'date', 'number', 'department', 'account']);
  const ok = evaluateForm({ type: room, input: { floor: '5F', day: '2026-11-03', people: '6', owner_department: 'dept-fin-1', contact: 'ga.one' }, user, department: { id: 'dept-ga-1', name: '總務與硬體組' },
    registry, accounts, departments, helpers: fakeHelpers(), today: '2026-11-01', phase: 'draft' });
  assert.deepEqual(ok.invalid, []);
  assert.deepEqual(ok.missing, []);
  assert.deepEqual(ok.fieldOptions.contact, [{ id: 'ga.one', name: 'ga.one', available: true }]);
  assert.equal(ok.fieldOptions.owner_department.length, 5);
  assert.equal(renderContent(room, { values: ok.values, computedMap: {}, department: null, handler: null, departments }),
    '[預約人]: one.it\n[樓層]: 5F\n[日期]: 2026-11-03（週二）\n[人數]: 6\n[使用部門]: dept-fin-1\n[部門名稱]: 財務部\n[聯絡人]: ga.one');
  const bad = evaluateForm({ type: room, input: { floor: '9F', day: '2026-10-01', people: '1', owner_department: 'dept-x', contact: 'boss.admin' }, user, department: null,
    registry, accounts, departments, helpers: fakeHelpers(), today: '2026-11-01', phase: 'draft' });
  assert.deepEqual(bad.invalid.map(/** 取訊息。@param {{message: string}} entry 錯誤。@returns {string} 訊息。 */ (entry) => entry.message),
    ['樓層請從「3F、5F」擇一', '日期不可早於今天', '人數不可小於 2', '使用部門必須是存在的部門', '聯絡人必須是系統內的一般帳號']);
}
test('只新增 JSON 定義就能加入新的需求類型', newTypeByJsonOnly);

/**
 * 驗證工具的伺服器端存取規則：my_leave_balance 只查本人（模型帶入其他帳號也無效）、colleagues 固定本人部門且只有名稱、
 * department_members 只回傳 id 與 name、參數驗證、沒有 ledger 的類型與不存在的類型回傳錯誤資料。
 * @returns {Promise<void>}
 */
async function toolPermissions() {
  const leave = types.find('leave');
  const equipment = types.find('equipment');
  const balanceCalls = [];
  const store = {
    /** 記錄額度查詢。@param {object} spec 規格。@param {string} username 帳號。@param {number} period 期間。@returns {Promise<object>} 額度。 */
    async ledgerBalances(spec, username, period) { balanceCalls.push({ username, period }); return { known: true, balances: [{ category: '特休', granted: 6720, adjusted: 0, used: 0, pending: 420, remaining: 6300 }] }; },
    /** 在替身交易內執行。@param {Function} fn 同步函式。@returns {Promise<*>} 結果。 */
    async withLedger(fn) { return fn(fakeHelpers({ busy: new Set(['two.it']) })); },
  };
  const context = { user, type: leave, registry: types, accounts, departments, store, clock: /** 固定時間。@returns {number} 毫秒。 */ () => Date.UTC(2026, 10, 1, 2) };
  const balance = await executeTool(types.tool('my_leave_balance'), { period: 2026, username: 'hr.one' }, context);
  assert.deepEqual(balanceCalls, [{ username: 'one.it', period: 2026 }], '只查本人，忽略模型提供的其他帳號');
  assert.deepEqual(balance.result.balances[0].remaining_text, '105 小時 0 分鐘');
  assert.equal(balance.result.unit, 'minutes');
  await executeTool(types.tool('my_leave_balance'), {}, context);
  assert.equal(balanceCalls[1].period, 2026, '省略年度時為台北今天的年度');
  assert.deepEqual(await executeTool(types.tool('my_leave_balance'), {}, { ...context, type: equipment }), { error: '這個需求類型沒有額度資料' });
  const colleagues = await executeTool(types.tool('colleagues'), { start_at: '2026-12-01T09:00', end_at: '2026-12-01T18:00', department_id: 'dept-hr-1' }, context);
  assert.deepEqual(colleagues.result, [{ id: 'two.it', name: 'two.it', available: false, reason: '此期間已有其他申請' }, { id: 'three.it', name: 'three.it', available: true }], '固定本人部門、排除本人、只有名稱');
  assert.match((await executeTool(types.tool('colleagues'), { start_at: '2026-12-01T09:00' }, context)).error, /同時提供/u);
  const members = await executeTool(types.tool('department_members'), { department_id: 'dept-hr-1' }, context);
  assert.deepEqual(members.result, [{ id: 'hr.one', name: 'hr.one' }]);
  assert.deepEqual(await executeTool(types.tool('department_members'), {}, context), { error: '缺少參數 department_id' });
  assert.deepEqual(await executeTool(types.tool('department_members'), { department_id: 'dept-x' }, context), { error: '找不到這個部門' });
  assert.deepEqual(applyAccess('names_only', [{ id: 'a.b', name: 'a.b', employee_no: 'T-1', balance: 9 }]), [{ id: 'a.b', name: 'a.b' }], 'names_only 移除其他欄位');
  assert.equal((await executeTool(types.tool('department_directory'), {}, context)).result.length, 5);
  assert.equal((await executeTool(types.tool('request_type_definition'), { type_id: 'equipment' }, context)).result.id, 'equipment');
  assert.deepEqual(await executeTool(types.tool('request_type_definition'), { type_id: 'nope' }, context), { error: '找不到這個需求類型' });
  assert.deepEqual(parseToolParams(types.tool('my_leave_balance'), { period: '2026' }), { ok: false, error: '參數 period 必須是 integer' });
}
test('工具在伺服器端套用目錄的存取規則', toolPermissions);

/**
 * 驗證引擎沒有需求類型專屬的程式：掃描通用引擎與控制器原始碼，不得出現任何需求類型的 id、欄位 key 或領域用語。
 * 人員資料、資料庫結構與人資假別 API（schema 與 HR 專用端點）不在掃描範圍，理由寫在 EXEMPT。
 * @returns {void}
 */
function noDomainStrings() {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  // 不掃描的檔案：資料庫結構與額度表允許清單、人員資料驗證與示範名冊、人資專用的假別時數 API。
  const EXEMPT = new Set(['services/storage/database.js', 'services/personnel/personnel.js', 'services/personnel/demoPersonnel.js', 'services/personnel/employeeService.js', 'services/storage/dataStore.js',
    'controllers/leaveController.js', 'routes/leaveRoutes.js', 'routes/meRoutes.js']);
  const forbidden = [/請假/u, /事假/u, /病假/u, /特休/u, /假別/u, /代理人/u, /設備/u, /\bleave_type\b/u, /\bstart_at\b/u, /\bend_at\b/u, /['"`]agent['"`]/u, /\.agent\b/u,
    /['"`]leave['"`]/u, /['"`]equipment['"`]/u, /['"`]general['"`]/u, /\bneeded_by\b/u, /\bquantity\b/u];
  // 個別檔案允許的字串：colleagues 工具 API 的期間參數名稱（目錄 params 合約），與任何需求類型的欄位無關。
  const ALLOWED = { 'services/requestTypes/capabilities.js': [/\bstart_at\b/u, /\bend_at\b/u] };
  const scanned = [];
  /** 遞迴掃描目錄。@param {string} dir 目錄。@returns {void} */
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      const relative = path.slice(root.length).split('\\').join('/');
      if (!name.endsWith('.js') || EXEMPT.has(relative)) continue;
      const text = readFileSync(path, 'utf8');
      scanned.push(relative);
      for (const pattern of forbidden) {
        if (ALLOWED[relative]?.some(/** 是否為允許的字串。@param {RegExp} allowed 允許規則。@returns {boolean} 相同時 true。 */ (allowed) => allowed.source === pattern.source)) continue;
        assert.ok(!pattern.test(text), `${relative} 不可包含 ${pattern.source}`);
      }
    }
  }
  walk(root);
  for (const required of ['services/requestTypes/draftEngine.js', 'services/requestTypes/evaluator.js', 'controllers/requestTypeController.js', 'controllers/ticketController.js']) {
    assert.ok(scanned.includes(required), `${required} 必須被掃描`);
  }
}
test('通用引擎與控制器沒有需求類型專屬字串', noDomainStrings);

/**
 * 驗證自動生成請求與招呼語：type_id 與舊名 form_id、欄位上限依定義、招呼語佔位文字。
 * @returns {void}
 */
function requestParsing() {
  const services = { types, departments };
  assert.deepEqual(parseDraftRequest({ subject: ' 請假 ', message: '   ' }, services), { subject: '請假', message: null, history: [], state: null });
  const parsed = parseDraftRequest({ subject: 'x', state: { form_id: 'leave', department_id: 'dept-hr-1', fields: { agent: 'two.it' }, locked: ['agent'] } }, services);
  assert.equal(parsed.state.typeId, 'leave', '接受舊名 form_id');
  assert.equal(parseDraftRequest({ subject: 'x', state: { type_id: 'general', fields: { description: 'x'.repeat(1000) } } }, services).state.fields.description.length, 1000);
  const invalid = [
    [{}, /subject/u], [{ subject: 'x', message: 5 }, /message 必須是字串/u], [{ subject: 'x', history: [{ role: 'system', text: 'a' }] }, /role/u],
    [{ subject: 'x', state: { type_id: 'nope' } }, /找不到指定的需求類型/u], [{ subject: 'x', state: { department_id: 'dept-x' } }, /找不到指定的部門/u],
    [{ subject: 'x', state: { type_id: 'leave', fields: { note: 'a'.repeat(501) } } }, /最多 500/u], [{ subject: 'x', state: { fields: { 'Bad-Key': 'a' } } }, /欄位名稱/u],
    [{ subject: 'x', state: { locked: 'agent' } }, /locked/u],
  ];
  for (const [body, pattern] of invalid) {
    /** 嘗試解析無效請求。@returns {object} 請求。@throws {HttpError} 400。 */
    function parse() { return parseDraftRequest(body, services); }
    assert.throws(parse, /** 是否為預期的 400。@param {HttpError} error 錯誤。@returns {boolean} 符合時 true。 */ (error) => error.status === 400 && pattern.test(error.message), JSON.stringify(body));
  }
  assert.match(greetingFor({ types, type: types.find('leave'), department: null, username: 'racky.huang' }), /^racky\.huang 你好，這邊已經收到你想要請假的需求，根據您的需求您的業務將會由人資部進行處理/u);
  assert.match(greetingFor({ types, type: types.find('general'), department: null, username: 'fin.one' }), /^fin\.one 你好，這邊已經收到你的需求，請告訴我需求的詳細狀況/u);
}
test('自動生成請求與招呼語', requestParsing);

/**
 * 驗證 Gemini 助手：分類一次結構化輸出；填寫先在工具階段以原生 function calling 執行工具（最多 3 次），再附上工具結果做一次結構化輸出；
 * 沒有工具時只呼叫一次；輸出整理只採信清單內的值；上游錯誤轉成帶 draftReason 的錯誤。
 * @returns {Promise<void>}
 */
async function assistantPipeline() {
  const lists = { typeIds: ['leave', 'general'], departmentIds: ['dept-hr-1'], keys: ['leave_type', 'agent', 'description'] };
  const requests = [];
  const queue = [];
  /** 依序回傳排好的回應。@param {object} request SDK 請求。@returns {Promise<object>} 回應。 */
  async function generateContent(request) { requests.push(structuredClone({ ...request, config: { ...request.config, abortSignal: undefined } })); return queue.shift(); }
  /** 回傳模擬 SDK。@returns {object} client。 */
  const getAI = () => ({ models: { generateContent } });
  const assistant = createGeminiAssistant({ getAI, model: 'test-model' });
  queue.push({ text: JSON.stringify({ intent: '請假', type_id: 'leave', department_id: 'dept-hr-1', confidence_score: 95, reply: '好的' }) });
  const classified = await assistant.classify({ instructions: '指示', context: { subject: 's' }, lists });
  assert.deepEqual({ ...classified }, { intent: '請假', typeId: 'leave', departmentId: 'dept-hr-1', confidence: 95, reply: '好的', toolsUsed: [], model: 'test-model' });
  assert.equal(requests[0].config.responseMimeType, 'application/json');
  assert.equal(requests[0].config.httpOptions.timeout, 20000);
  const tools = [types.tool('colleagues'), types.tool('my_leave_balance')];
  const ran = [];
  /** 工具執行替身。@param {string} id 工具 id。@param {object} args 參數。@returns {Promise<object>} 結果。 */
  async function runTool(id, args) { ran.push([id, args]); return { result: [{ id: 'two.it', name: 'two.it', available: true }] }; }
  /** 建立函式呼叫回應。@param {object[]} calls 呼叫。@returns {object} 回應。 */
  const callResponse = (calls) => ({ functionCalls: calls, candidates: [{ content: { role: 'model', parts: calls.map(/** 轉成片段。@param {object} call 呼叫。@returns {object} 片段。 */ (call) => ({ functionCall: call })) } }] });
  queue.push(callResponse([{ id: 'c1', name: 'colleagues', args: {} }, { id: 'c2', name: 'my_leave_balance', args: { period: 2026 } }]));
  queue.push(callResponse([{ id: 'c3', name: 'colleagues', args: { start_at: 'x' } }, { id: 'c4', name: 'colleagues', args: {} }]));
  queue.push({ text: JSON.stringify({ intent: '請假', type_id: 'leave', department_id: 'dept-hr-1', confidence_score: 90, updates: [{ key: 'agent', value: 'two.it' }, { key: 'applicant', value: 'x' }], handler_id: null, reply: '可以請 two.it 代理' }) });
  const filled = await assistant.fill({ instructions: '指示', context: { subject: 's' }, lists, tools, runTool });
  assert.deepEqual(filled.toolsUsed, ['colleagues', 'my_leave_balance', 'colleagues'], '最多執行 3 次工具');
  assert.equal(ran.length, 3);
  assert.deepEqual(filled.updates, [{ key: 'agent', value: 'two.it' }], '清單外的 key 被捨棄');
  assert.equal(requests.length, 4, '分類 1 次＋工具階段 2 次＋整理 1 次');
  assert.deepEqual(requests[1].config.tools[0].functionDeclarations.map(/** 取名稱。@param {{name: string}} item 宣告。@returns {string} 名稱。 */ (item) => item.name), ['colleagues', 'my_leave_balance']);
  const toolTurn = requests[2].contents.at(-1).parts;
  assert.equal(toolTurn[0].functionResponse.id, 'c1');
  const final = JSON.parse(requests[3].contents);
  assert.equal(final.tool_results.length, 3, '整理階段附上工具結果');
  assert.equal(requests[3].config.tools, undefined, '整理階段不帶工具');
  assert.deepEqual(requests[3].config.responseSchema, fillSchema(lists));
  queue.length = 0;
  queue.push({ text: JSON.stringify({ intent: '', type_id: null, department_id: null, confidence_score: 0, updates: [], handler_id: null, reply: '' }) });
  const plain = await assistant.fill({ instructions: '指示', context: {}, lists, tools: [], runTool });
  assert.equal(plain.reply, null);
  assert.equal(requests.length, 5, '沒有工具時只呼叫一次');
  assert.deepEqual(toolDeclaration(types.tool('department_members')).parameters.required, ['department_id']);
  assert.deepEqual(buildClassification({ intent: 5, type_id: 'x', department_id: 'y', confidence_score: 80.5, reply: ' 嗨 ' }, lists), { intent: '', typeId: null, departmentId: null, confidence: 0, reply: '嗨' });
  /** 建立以指定 generateContent 運作的助手。@param {Function} generate 函式。@param {number} [timeoutMs] 期限。@returns {object} 助手。 */
  function withGenerate(generate, timeoutMs) {
    /** 回傳模擬 SDK。@returns {object} client。 */
    function client() { return { models: { generateContent: generate } }; }
    return createGeminiAssistant({ getAI: client, timeoutMs });
  }
  /** 產生比對原因代碼的檢查。@param {string} reason 原因。@returns {Function} 檢查函式。 */
  function reasonIs(reason) {
    /** 比對原因。@param {HttpError} error 錯誤。@returns {boolean} 相符時 true。 */
    return function matches(error) { return error.draftReason === reason; };
  }
  /** 不是 JSON 的輸出。@returns {Promise<object>} 回應。 */
  async function notJson() { return { text: 'not json' }; }
  /** 上游 429。@returns {Promise<never>} @throws {object} 上游錯誤。 */
  async function limited() { throw { status: 429, message: 'secret-upstream' }; }
  /** 上游 503。@returns {Promise<never>} @throws {object} 上游錯誤。 */
  async function unavailable() { throw { status: 503, message: 'secret-upstream' }; }
  /** 永不回應。@returns {Promise<never>} 永遠擱置。 */
  function never() { return new Promise(/** 不呼叫任何回呼。@returns {void} */ () => {}); }
  await assert.rejects(withGenerate(notJson).classify({ instructions: 'x', context: {}, lists }), reasonIs('AI_INVALID_RESPONSE'));
  await assert.rejects(withGenerate(limited).classify({ instructions: 'x', context: {}, lists }), /** 429 轉換。@param {HttpError} error 錯誤。@returns {boolean} 符合時 true。 */ (error) => error.status === 429 && error.retryAfter === 10 && !error.message.includes('secret'));
  await assert.rejects(withGenerate(unavailable).fill({ instructions: 'x', context: {}, lists, tools, runTool }), reasonIs('AI_UPSTREAM_ERROR'));
  await assert.rejects(withGenerate(never, 20).fill({ instructions: 'x', context: {}, lists, tools, runTool }), reasonIs('AI_TIMEOUT'));
  await assert.rejects(createGeminiAssistant().classify({ instructions: 'x', context: {}, lists }), reasonIs('AI_UNAVAILABLE'), '未設定金鑰');
  assert.throws(/** 結構不符。@returns {object} 結果。 */ () => buildFill({ updates: {}, reply: 'x' }, lists), /** 格式異常。@param {HttpError} error 錯誤。@returns {boolean} 符合時 true。 */ (error) => error.draftReason === 'AI_INVALID_RESPONSE');
  assert.ok(Object.isFrozen(LEDGER_TABLES), '額度資料表允許清單不可修改');
}
test('Gemini 助手的分類、工具階段與整理階段', assistantPipeline);

/**
 * 驗證實際類型不接受指定處理人：送出時帶 handler_id 回 400「「設備申請」不提供指定處理人」；沒有帶時為 null。
 * @returns {Promise<void>}
 */
async function noHandlerOnRealTypes() {
  const { submissionHandler } = await import('../src/services/requestTypes/workflow.js');
  const equipment = types.find('equipment');
  const department = { id: 'dept-ga-1', name: '總務與硬體組' };
  assert.equal(submissionHandler({ type: equipment, handlerId: null, department, user, accounts }), null);
  assert.throws(() => submissionHandler({ type: equipment, handlerId: 'ga.one', department, user, accounts }), { status: 400, message: '「設備申請」不提供指定處理人' });
}
test('實際需求類型送出時不接受指定處理人', noHandlerOnRealTypes);
