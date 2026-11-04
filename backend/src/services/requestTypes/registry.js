import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { departmentService } from '../departmentService.js';
import { LEDGER_TABLES } from '../storage/database.js';
import { CHECK_CAPABILITIES, CHECK_PHASES, COMPUTATION_CAPABILITIES, TOOL_CAPABILITIES, ACCESS_RULES, describeCalendar } from './capabilities.js';
import { clientField, definitionError, FIELD_KEY_PATTERN, isPlainObject, nonempty, normalizeFieldDefinition, RESERVED_KEYS } from './fieldTypes.js';
import { compileTemplate, FILTERS } from './renderer.js';

export const DEFAULT_TYPES_DIR = fileURLToPath(new URL('../../../data/requestTypes/', import.meta.url));
export const CATALOG_FILE = '_catalog.json';
const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const FILE_PATTERN = /^[a-z][a-z0-9_-]*\.json$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const PARAM_TYPES = Object.freeze(['string', 'integer', 'number', 'boolean']);
const GREETING_MAX = 600;
const SUMMARY_MAX = 300;
// 定義檔允許的頂層鍵；計算參數引用的物件（例如工作日曆）另外允許。其他鍵視為拼字錯誤，啟動失敗。
const DEFINITION_KEYS = Object.freeze(['id', 'version', 'name', 'department_id', 'department', 'handler', 'ai', 'fields', 'computations', 'ledger', 'checks', 'render', 'workflow']);
const ROUTES = Object.freeze(['FORM', 'DEPARTMENT']);

/**
 * 讀取並解析一個 JSON 檔；錯誤只回報檔名與原因（語法錯誤時附位置），不輸出檔案內容。
 * @param {string} dir 定義檔目錄。
 * @param {string} file 檔名。
 * @param {Function} [read=readFileSync] 讀檔函式（測試可注入）。
 * @returns {unknown} 解析結果。
 * @throws {Error} REQUEST_TYPES_INVALID：檔案無法讀取或不是有效的 JSON。
 */
function readJson(dir, file, read = readFileSync) {
  let text;
  try { text = read(join(dir, file), 'utf8'); } catch (error) { throw definitionError(file, `無法讀取（${error.code || error.name}）`); }
  try { return JSON.parse(text.replace(/^﻿/u, '')); } catch (error) {
    const position = /position (\d+)/u.exec(String(error.message))?.[1];
    throw definitionError(file, `不是有效的 JSON${position ? `（位置 ${position}）` : ''}`);
  }
}

/**
 * 驗證需求類型目錄 _catalog.json 並整理成固定形狀。規則：version 為正整數；assistant.instructions 為非空字串陣列、
 * assistant.fallback_greeting 為最多 600 字的非空白字串；types 為非空陣列，每筆 id（小寫英數）與 file（*.json）唯一，name、summary（最多 300 字）非空白，
 * keywords 為字串陣列；default_type 必須是 types 之一；tools 每筆 id 唯一、description／returns 非空白、capability 為已知工具能力、
 * access 為已知存取規則且符合該能力要求、params 為 { 名稱: { type, description, required } }。
 * @param {unknown} raw 解析後的目錄。
 * @returns {object} version、assistant、types、defaultType、tools（Map）。
 * @throws {Error} REQUEST_TYPES_INVALID：任一項不符，訊息含「_catalog.json 鍵路徑」。
 */
export function normalizeCatalog(raw) {
  const file = CATALOG_FILE;
  if (!isPlainObject(raw)) throw definitionError(file, '必須是物件');
  if (!Number.isSafeInteger(raw.version) || raw.version < 1) throw definitionError(`${file} version`, '必須是正整數');
  const assistant = raw.assistant;
  if (!isPlainObject(assistant)) throw definitionError(`${file} assistant`, '必須是物件');
  if (!Array.isArray(assistant.instructions) || !assistant.instructions.length || !assistant.instructions.every(nonempty)) throw definitionError(`${file} assistant.instructions`, '必須是非空的字串陣列');
  if (!nonempty(assistant.fallback_greeting) || Array.from(assistant.fallback_greeting).length > GREETING_MAX) throw definitionError(`${file} assistant.fallback_greeting`, `必須是 1～${GREETING_MAX} 字的字串`);
  if (!Array.isArray(raw.types) || !raw.types.length) throw definitionError(`${file} types`, '必須是非空陣列');
  const ids = new Set();
  const files = new Set();
  const types = raw.types.map(/** 驗證一筆類型目錄。@param {unknown} item 項目。@param {number} index 索引。@returns {object} 整理後的項目。 */ (item, index) => {
    const where = `${file} types[${index}]`;
    if (!isPlainObject(item)) throw definitionError(where, '必須是物件');
    if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) throw definitionError(`${where}.id`, '必須是小寫英數、底線或連字號');
    if (ids.has(item.id)) throw definitionError(`${where}.id`, `重複（${item.id}）`);
    if (typeof item.file !== 'string' || !FILE_PATTERN.test(item.file) || item.file === file) throw definitionError(`${where}.file`, '必須是同目錄下的 .json 檔名');
    if (files.has(item.file)) throw definitionError(`${where}.file`, `重複（${item.file}）`);
    if (!nonempty(item.name)) throw definitionError(`${where}.name`, '必須是非空白字串');
    if (!nonempty(item.summary) || Array.from(item.summary).length > SUMMARY_MAX) throw definitionError(`${where}.summary`, `必須是 1～${SUMMARY_MAX} 字的字串`);
    if (!Array.isArray(item.keywords) || !item.keywords.every(nonempty)) throw definitionError(`${where}.keywords`, '必須是字串陣列');
    ids.add(item.id);
    files.add(item.file);
    return { id: item.id, file: item.file, name: item.name, summary: item.summary, keywords: [...item.keywords] };
  });
  if (!ids.has(raw.default_type)) throw definitionError(`${file} default_type`, '必須是 types 中的 id');
  if (!Array.isArray(raw.tools)) throw definitionError(`${file} tools`, '必須是陣列');
  const tools = new Map();
  for (const [index, tool] of raw.tools.entries()) {
    const where = `${file} tools[${index}]`;
    if (!isPlainObject(tool)) throw definitionError(where, '必須是物件');
    if (typeof tool.id !== 'string' || !FIELD_KEY_PATTERN.test(tool.id)) throw definitionError(`${where}.id`, '必須是小寫英數與底線');
    if (tools.has(tool.id)) throw definitionError(`${where}.id`, `重複（${tool.id}）`);
    for (const name of ['description', 'returns']) if (!nonempty(tool[name])) throw definitionError(`${where}.${name}`, '必須是非空白字串');
    const capability = TOOL_CAPABILITIES[tool.capability];
    if (!capability) throw definitionError(`${where}.capability`, `未知的工具能力「${String(tool.capability)}」，只接受 ${Object.keys(TOOL_CAPABILITIES).join('、')}`);
    if (!ACCESS_RULES.includes(tool.access)) throw definitionError(`${where}.access`, `只接受 ${ACCESS_RULES.join('、')}`);
    if (!capability.access.includes(tool.access)) throw definitionError(`${where}.access`, `能力 ${tool.capability} 必須使用 ${capability.access.join('、')}`);
    if (!isPlainObject(tool.params)) throw definitionError(`${where}.params`, '必須是物件');
    const params = {};
    for (const [name, spec] of Object.entries(tool.params)) {
      if (!FIELD_KEY_PATTERN.test(name)) throw definitionError(`${where}.params.${name}`, '名稱必須是小寫英數與底線');
      if (!isPlainObject(spec) || !PARAM_TYPES.includes(spec.type) || !nonempty(spec.description) || typeof spec.required !== 'boolean') {
        throw definitionError(`${where}.params.${name}`, `必須是 { type（${PARAM_TYPES.join('、')}）, description, required（布林值）}`);
      }
      params[name] = { type: spec.type, description: spec.description, required: spec.required };
    }
    const contract = Object.entries(capability.params).map(/** 合約轉文字。@param {[string, string]} entry [名稱, 型別]。@returns {string} 文字。 */ ([name, type]) => `${name}:${type}`).sort().join(',');
    const declared = Object.entries(params).map(/** 宣告轉文字。@param {[string, object]} entry [名稱, 規格]。@returns {string} 文字。 */ ([name, spec]) => `${name}:${spec.type}`).sort().join(',');
    if (contract !== declared) throw definitionError(`${where}.params`, `必須符合能力 ${tool.capability} 的參數合約（${contract || '沒有參數'}）`);
    tools.set(tool.id, { id: tool.id, description: tool.description, capability: tool.capability, params, access: tool.access, returns: tool.returns });
  }
  return { version: raw.version, assistant: { instructions: [...assistant.instructions], fallbackGreeting: assistant.fallback_greeting }, types, defaultType: raw.default_type, tools };
}

/**
 * 檢查工具參照：工具存在且能力可提供指定型別的選項。
 * @param {Map<string, object>} tools 目錄工具。
 * @param {unknown} id 工具 id。
 * @param {string} kind 需要的選項型別（account、department）。
 * @param {string} where 錯誤訊息位置。
 * @returns {string} 工具 id。
 * @throws {Error} REQUEST_TYPES_INVALID：工具不存在或不能提供這種選項。
 */
function optionsTool(tools, id, kind, where) {
  const tool = tools.get(id);
  if (!tool) throw definitionError(where, `參照的工具「${String(id)}」不在 _catalog.json tools 中`);
  if (TOOL_CAPABILITIES[tool.capability].options !== kind) throw definitionError(where, `工具「${id}」不能提供 ${kind} 選項`);
  return id;
}

/**
 * 驗證一份需求類型定義並整理成引擎使用的形狀。檢查內容：
 * - id 與目錄相同、version 為正整數、name 與目錄相同；只允許已知頂層鍵（以及計算參數引用的物件）；
 * - department_id 為存在的部門，或 null 並提供 department { options_tool, min_confidence（0～100）}；handler 選填 { options_tool, not_self }；
 * - ai：description 非空白、examples 字串陣列、greeting 選填（最多 600 字）、ask_order 為欄位 key、tools 為目錄中的工具 id；
 * - fields：非空、key 不重複、最多一個 self 欄位；rules.after、filters.not_busy_between 參照存在的日期類欄位；options_tool 參照可提供選項的工具；
 * - computations：key 唯一且不與欄位相同、capability 為已知計算能力（參數由能力驗證）、display 為無參數的篩選器；
 * - ledger：category_field 為必填 enum 欄位、amount 為計算 key、period_from 為日期類欄位、entitlement_table 在允許清單內，類別必須是該表允許的類別；
 * - checks：capability 為已知檢查能力且需要 ledger、on 為 draft／submit／approve 子集、error { code（大寫英數）, message }、summary_label 與 args 參照有效；
 * - render.lines：每行的佔位文字只能參照欄位、計算結果或保留名稱 department／handler，篩選器必須已知；
 * - workflow：route 為 FORM（需要固定部門）或 DEPARTMENT（需要 department_id 為 null）；approver、transfer、transfer_error、judgement 格式；
 *   approver.not_requester 省略時為 true（提單人不能簽核自己的單），transfer 省略時 FORM 為 false、DEPARTMENT 為 true。
 * @param {unknown} raw 解析後的定義。
 * @param {object} context 驗證資料。
 * @param {object} context.entry 目錄中的這筆類型（id、file、name、summary、keywords）。
 * @param {Map<string, object>} context.tools 目錄工具。
 * @param {object} context.departments 部門查詢服務。
 * @param {object} context.ledgerTables 允許的額度資料表。
 * @returns {object} 引擎使用的需求類型。
 * @throws {Error} REQUEST_TYPES_INVALID：訊息含「檔名 鍵路徑 原因」。
 */
export function normalizeDefinition(raw, { entry, tools, departments, ledgerTables }) {
  const file = entry.file;
  if (!isPlainObject(raw)) throw definitionError(file, '必須是物件');
  if (raw.id !== entry.id) throw definitionError(`${file} id`, `必須與 _catalog.json 的 id「${entry.id}」相同`);
  if (!Number.isSafeInteger(raw.version) || raw.version < 1) throw definitionError(`${file} version`, '必須是正整數');
  if (raw.name !== entry.name) throw definitionError(`${file} name`, `必須與 _catalog.json 的 name「${entry.name}」相同`);
  // 欄位
  if (!Array.isArray(raw.fields) || !raw.fields.length) throw definitionError(`${file} fields`, '必須是非空陣列');
  const fields = raw.fields.map(/** 驗證單一欄位。@param {unknown} field 欄位。@param {number} index 索引。@returns {object} 欄位。 */ (field, index) => normalizeFieldDefinition(field, `${file} fields[${index}]`));
  const fieldsByKey = new Map();
  for (const [index, field] of fields.entries()) {
    if (fieldsByKey.has(field.key)) throw definitionError(`${file} fields[${index}].key`, `重複（${field.key}）`);
    fieldsByKey.set(field.key, field);
  }
  if (fields.filter(/** 是否為 self。@param {object} field 欄位。@returns {boolean} self 時 true。 */ (field) => field.type === 'self').length > 1) throw definitionError(`${file} fields`, '最多只能有一個 self 欄位');
  /** 是否為日期類欄位。@param {unknown} key 欄位 key。@returns {boolean} date 或 datetime 時 true。 */
  const dateLike = (key) => ['date', 'datetime'].includes(fieldsByKey.get(key)?.type);
  for (const [index, field] of fields.entries()) {
    const where = `${file} fields[${index}]`;
    if (field.rules?.after && (!dateLike(field.rules.after) || fieldsByKey.get(field.rules.after).type !== field.type || field.rules.after === field.key)) {
      throw definitionError(`${where}.rules.after`, '必須參照另一個相同型別的日期欄位');
    }
    for (const key of field.filters?.not_busy_between ?? []) if (!dateLike(key)) throw definitionError(`${where}.filters.not_busy_between`, `參照的「${key}」不是日期類欄位`);
    if (field.options_tool) optionsTool(tools, field.options_tool, field.type, `${where}.options_tool`);
  }
  // 部門與處理人
  let departmentChoice = null;
  if (raw.department_id === null) {
    const choice = raw.department;
    if (!isPlainObject(choice)) throw definitionError(`${file} department`, 'department_id 為 null 時必須提供 { options_tool, min_confidence }');
    if (!Number.isInteger(choice.min_confidence) || choice.min_confidence < 0 || choice.min_confidence > 100) throw definitionError(`${file} department.min_confidence`, '必須是 0～100 的整數');
    departmentChoice = { optionsTool: optionsTool(tools, choice.options_tool, 'department', `${file} department.options_tool`), minConfidence: choice.min_confidence };
  } else {
    if (!departments.findDepartment(raw.department_id)) throw definitionError(`${file} department_id`, `「${String(raw.department_id)}」不是部門設定檔中存在的部門 id`);
    if (raw.department !== undefined) throw definitionError(`${file} department`, '只在 department_id 為 null 時使用');
  }
  let handler = null;
  if (raw.handler !== undefined) {
    if (!isPlainObject(raw.handler) || typeof raw.handler.not_self !== 'boolean') throw definitionError(`${file} handler`, '必須是 { options_tool, not_self（布林值）}');
    handler = { optionsTool: optionsTool(tools, raw.handler.options_tool, 'account', `${file} handler.options_tool`), notSelf: raw.handler.not_self };
  }
  // AI
  const ai = raw.ai;
  if (!isPlainObject(ai)) throw definitionError(`${file} ai`, '必須是物件');
  if (!nonempty(ai.description)) throw definitionError(`${file} ai.description`, '必須是非空白字串');
  if (!Array.isArray(ai.examples) || !ai.examples.every(nonempty)) throw definitionError(`${file} ai.examples`, '必須是字串陣列');
  if (ai.greeting !== undefined && (!nonempty(ai.greeting) || Array.from(ai.greeting).length > GREETING_MAX)) throw definitionError(`${file} ai.greeting`, `必須是 1～${GREETING_MAX} 字的字串`);
  const askOrder = ai.ask_order ?? [];
  if (!Array.isArray(askOrder) || !askOrder.every(/** 是否為欄位。@param {unknown} key 項目。@returns {boolean} 是欄位 key 時 true。 */ (key) => fieldsByKey.has(key))) throw definitionError(`${file} ai.ask_order`, '只能包含這份定義的欄位 key');
  const aiTools = ai.tools ?? [];
  if (!Array.isArray(aiTools)) throw definitionError(`${file} ai.tools`, '必須是工具 id 陣列');
  for (const id of aiTools) if (!tools.has(id)) throw definitionError(`${file} ai.tools`, `參照的工具「${String(id)}」不在 _catalog.json tools 中`);
  // 計算
  const referenced = new Set();
  const computationsRaw = raw.computations ?? [];
  if (!Array.isArray(computationsRaw)) throw definitionError(`${file} computations`, '必須是陣列');
  const computations = computationsRaw.map(/** 驗證單一計算。@param {unknown} item 計算。@param {number} index 索引。@returns {object} 計算。 */ (item, index) => {
    const where = `${file} computations[${index}]`;
    if (!isPlainObject(item)) throw definitionError(where, '必須是物件');
    if (typeof item.key !== 'string' || !FIELD_KEY_PATTERN.test(item.key) || fieldsByKey.has(item.key) || RESERVED_KEYS.includes(item.key)) throw definitionError(`${where}.key`, '必須是小寫英數與底線，且不可與欄位或保留名稱相同');
    if (!nonempty(item.label)) throw definitionError(`${where}.label`, '必須是非空白字串');
    const capability = COMPUTATION_CAPABILITIES[item.capability];
    if (!capability) throw definitionError(`${where}.capability`, `未知的計算能力「${String(item.capability)}」，只接受 ${Object.keys(COMPUTATION_CAPABILITIES).join('、')}`);
    if (!isPlainObject(item.args)) throw definitionError(`${where}.args`, '必須是物件');
    if (item.display !== undefined && (FILTERS[item.display]?.arg !== 'none')) throw definitionError(`${where}.display`, '必須是不需參數的篩選器名稱');
    if (item.messages !== undefined && (!isPlainObject(item.messages) || !Object.values(item.messages).every(nonempty))) throw definitionError(`${where}.messages`, '必須是字串物件');
    const resolved = capability.validate(item.args, { definition: raw, fieldsByKey, where });
    for (const name of resolved.referenced) referenced.add(name);
    return { key: item.key, label: item.label, capability: item.capability, args: { ...item.args }, display: item.display ?? null, messages: { ...(item.messages ?? {}) }, resolved };
  });
  const computationKeys = new Set(computations.map(/** 取 key。@param {{key: string}} item 計算。@returns {string} key。 */ (item) => item.key));
  if (computationKeys.size !== computations.length) throw definitionError(`${file} computations`, 'key 不可重複');
  for (const key of Object.keys(raw)) {
    if (!DEFINITION_KEYS.includes(key) && !referenced.has(key)) throw definitionError(`${file} ${key}`, '是未知的鍵（只接受已知鍵與計算參數引用的物件）');
  }
  // ledger
  let ledger = null;
  let ledgerSpec = null;
  if (raw.ledger !== undefined) {
    const where = `${file} ledger`;
    const item = raw.ledger;
    if (!isPlainObject(item) || item.kind !== 'balance') throw definitionError(`${where}.kind`, '目前只支援 balance');
    const category = fieldsByKey.get(item.category_field);
    if (category?.type !== 'enum' || !category.required) throw definitionError(`${where}.category_field`, '必須是必填的 enum 欄位');
    if (!computationKeys.has(item.amount)) throw definitionError(`${where}.amount`, '必須是 computations 的 key');
    if (!dateLike(item.period_from)) throw definitionError(`${where}.period_from`, '必須是日期類欄位');
    const table = Object.hasOwn(ledgerTables, item.entitlement_table) ? ledgerTables[item.entitlement_table] : null;
    if (!table) throw definitionError(`${where}.entitlement_table`, `「${String(item.entitlement_table)}」不在允許的額度資料表（${Object.keys(ledgerTables).join('、')}）`);
    const unknown = category.options.filter(/** 是否為資料表不允許的類別。@param {string} option 選項。@returns {boolean} 不允許時 true。 */ (option) => !table.categories.includes(option));
    if (unknown.length) throw definitionError(`${where}.category_field`, `的選項 ${unknown.join('、')} 不是 ${item.entitlement_table} 允許的類別（${table.categories.join('、')}）`);
    ledger = { kind: item.kind, category_field: item.category_field, amount: item.amount, period_from: item.period_from, entitlement_table: item.entitlement_table };
    ledgerSpec = Object.freeze({ typeId: raw.id, table: item.entitlement_table, categoryField: item.category_field, amountKey: item.amount, periodField: item.period_from, categories: [...category.options] });
  }
  // 渲染名稱：欄位、計算結果與保留名稱
  const fieldKeys = new Set(fieldsByKey.keys());
  const names = new Set([...fieldKeys, ...computationKeys, 'department', 'handler']);
  // 檢查
  const checksRaw = raw.checks ?? [];
  if (!Array.isArray(checksRaw)) throw definitionError(`${file} checks`, '必須是陣列');
  const checks = checksRaw.map(/** 驗證單一檢查。@param {unknown} item 檢查。@param {number} index 索引。@returns {object} 檢查。 */ (item, index) => {
    const where = `${file} checks[${index}]`;
    if (!isPlainObject(item)) throw definitionError(where, '必須是物件');
    const capability = CHECK_CAPABILITIES[item.capability];
    if (!capability) throw definitionError(`${where}.capability`, `未知的檢查能力「${String(item.capability)}」，只接受 ${Object.keys(CHECK_CAPABILITIES).join('、')}`);
    if (!ledger) throw definitionError(`${where}.capability`, `${item.capability} 需要這份定義有 ledger`);
    if (!Array.isArray(item.on) || !item.on.length || !item.on.every(/** 是否為已知階段。@param {unknown} phase 階段。@returns {boolean} 已知時 true。 */ (phase) => CHECK_PHASES.includes(phase))) {
      throw definitionError(`${where}.on`, `必須是 ${CHECK_PHASES.join('、')} 的非空子集`);
    }
    if (!isPlainObject(item.error) || typeof item.error.code !== 'string' || !CODE_PATTERN.test(item.error.code) || !nonempty(item.error.message)) {
      throw definitionError(`${where}.error`, '必須是 { code（大寫英數與底線）, message }');
    }
    const args = item.args ?? {};
    if (!isPlainObject(args)) throw definitionError(`${where}.args`, '必須是物件');
    for (const name of capability.needsArgs) if (!dateLike(args[name])) throw definitionError(`${where}.args.${name}`, '必須是日期類欄位 key');
    const summary = item.summary_label === undefined ? null : compileTemplate(item.summary_label, { names: fieldKeys, fieldKeys, where: `${where}.summary_label` });
    return { capability: item.capability, on: [...new Set(item.on)], args: { ...args }, error: { code: item.error.code, message: item.error.message }, summary };
  });
  // 渲染
  if (!isPlainObject(raw.render) || !Array.isArray(raw.render.lines) || !raw.render.lines.length) throw definitionError(`${file} render.lines`, '必須是非空陣列');
  const lines = raw.render.lines.map(/** 編譯一行範本。@param {unknown} line 範本。@param {number} index 索引。@returns {Array<object>} 片段。 */ (line, index) => compileTemplate(line, { names, fieldKeys, where: `${file} render.lines[${index}]` }));
  // 流程
  const workflow = raw.workflow;
  if (!isPlainObject(workflow) || !ROUTES.includes(workflow.route)) throw definitionError(`${file} workflow.route`, `必須是 ${ROUTES.join('、')}`);
  if (workflow.route === 'FORM' && raw.department_id === null) throw definitionError(`${file} workflow.route`, 'FORM 需要固定的 department_id');
  if (workflow.route === 'DEPARTMENT' && raw.department_id !== null) throw definitionError(`${file} workflow.route`, 'DEPARTMENT 需要 department_id 為 null（由對話決定部門）');
  const approver = workflow.approver ?? {};
  if (!isPlainObject(approver) || (approver.department !== undefined && approver.department !== 'definition')
    || (approver.not_requester !== undefined && typeof approver.not_requester !== 'boolean') || (approver.message !== undefined && !nonempty(approver.message))) {
    throw definitionError(`${file} workflow.approver`, '必須是 { department: "definition", not_requester（布林值）, message? }');
  }
  if (workflow.transfer !== undefined && typeof workflow.transfer !== 'boolean') throw definitionError(`${file} workflow.transfer`, '必須是布林值');
  const transferError = workflow.transfer_error;
  if (transferError !== undefined && (!isPlainObject(transferError) || typeof transferError.code !== 'string' || !CODE_PATTERN.test(transferError.code) || !nonempty(transferError.message))) {
    throw definitionError(`${file} workflow.transfer_error`, '必須是 { code（大寫英數與底線）, message }');
  }
  if (workflow.judgement !== undefined && (!isPlainObject(workflow.judgement) || workflow.judgement.source !== 'draft')) throw definitionError(`${file} workflow.judgement`, '目前只支援 { source: "draft" }');
  const calendars = computations.map(/** 取計算的日曆。@param {object} item 計算。@returns {object|undefined} 日曆。 */ (item) => item.resolved.calendar).filter(Boolean);
  return Object.freeze({
    id: raw.id, version: raw.version, name: raw.name, file, summary: entry.summary, keywords: entry.keywords,
    departmentId: raw.department_id, departmentChoice, handler,
    ai: { description: ai.description, examples: [...ai.examples], greeting: ai.greeting ?? null, askOrder: [...askOrder], tools: [...new Set(aiTools)] },
    fields, fieldsByKey, computations, ledger, ledgerSpec, checks, lines,
    workflow: {
      route: workflow.route,
      approver: { notRequester: approver.not_requester ?? true, message: approver.message ?? null },
      transfer: workflow.transfer ?? workflow.route !== 'FORM',
      transferError: transferError ? { code: transferError.code, message: transferError.message } : null,
      judgement: workflow.judgement ? { source: workflow.judgement.source } : null,
    },
    timezoneOffset: calendars[0]?.timezoneOffset ?? null,
    references: Object.fromEntries(computations.filter(/** 有日曆的計算。@param {object} item 計算。@returns {boolean} 有日曆時 true。 */ (item) => item.resolved.calendar)
      .map(/** 轉成 AI 摘要。@param {object} item 計算。@returns {[string, object]} [鍵, 摘要]。 */ (item) => [item.args.calendar, describeCalendar(item.resolved.calendar)])),
  });
}

/**
 * 以已驗證的目錄與定義建立查詢服務；所有輸出都是新物件，呼叫端不可修改回傳的類型定義。
 * @param {object} catalog normalizeCatalog 的結果。
 * @param {Map<string, object>} types 依目錄順序的需求類型。
 * @param {object} departments 部門查詢服務。
 * @returns {object} catalog、list、ids、find、defaultType、tool、toolsFor、summaries、match、forClient、draftView、aiView、busySpecs、ledgerOwner。
 */
function createRegistry(catalog, types, departments) {
  /** 取部門 { id, name }。@param {string|null} id 部門 id。@returns {{id: string, name: string}|null} 部門。 */
  const departmentRef = (id) => {
    const department = id ? departments.findDepartment(id) : null;
    return department ? { id: department.id, name: department.name } : null;
  };
  const busy = [...types.values()].flatMap(/** 取有期間重疊檢查的 ledger。@param {object} type 類型。@returns {object[]} 期間規格。 */ (type) => type.checks
    .filter(/** 是否為期間重疊檢查。@param {object} check 檢查。@returns {boolean} 是時 true。 */ (check) => check.capability === 'ledger_overlap')
    .map(/** 轉成期間規格。@param {object} check 檢查。@returns {object} 規格。 */ (check) => Object.freeze({ typeId: type.id, startField: check.args.start, endField: check.args.end })));
  return {
    catalog: { version: catalog.version, assistant: catalog.assistant, defaultType: catalog.defaultType },
    /** 依目錄順序取得全部需求類型。@returns {object[]} 類型。 */
    list() { return [...types.values()]; },
    /** 取得全部需求類型 id。@returns {string[]} id。 */
    ids() { return [...types.keys()]; },
    /** 依 id 查詢。@param {unknown} id 類型 id。@returns {object|null} 類型。 */
    find(id) { return typeof id === 'string' ? types.get(id) ?? null : null; },
    /** 預設類型（沒有專用定義的需求）。@returns {object} 類型。 */
    defaultType() { return types.get(catalog.defaultType); },
    /** 依 id 取得目錄工具。@param {string} id 工具 id。@returns {object|null} 工具。 */
    tool(id) { return catalog.tools.get(id) ?? null; },
    /** 取得類型可讓 AI 呼叫的工具。@param {object} type 類型。@returns {object[]} 工具。 */
    toolsFor(type) { return type.ai.tools.map(/** 取工具。@param {string} id 工具 id。@returns {object} 工具。 */ (id) => catalog.tools.get(id)); },
    /** 交給 AI 分類用的類型摘要。@returns {object[]} id、name、summary、department。 */
    summaries() { return [...types.values()].map(/** 轉成摘要。@param {object} type 類型。@returns {object} 摘要。 */ (type) => ({ id: type.id, name: type.name, summary: type.summary, department: departmentRef(type.departmentId) })); },
    /**
     * 沒有 AI 時的備援：依主題比對關鍵字，回傳第一個關鍵字出現在主題中的類型（不分大小寫），沒有相符時為預設類型。
     * @param {string} subject 主題。
     * @returns {object} 類型。
     */
    match(subject) {
      const text = String(subject).toLowerCase();
      return [...types.values()].find(/** 主題是否含任一關鍵字。@param {object} type 類型。@returns {boolean} 相符時 true。 */ (type) => type.keywords.some(/** 比對關鍵字。@param {string} keyword 關鍵字。@returns {boolean} 出現時 true。 */ (keyword) => text.includes(keyword.toLowerCase()))) ?? types.get(catalog.defaultType);
    },
    /**
     * GET /api/forms 的形狀（不含 AI 專用文字）。除了欄位外另帶：
     * - computed：計算項目的 key、label 與 display（顯示方式，沒有時為 null），讓狀態追蹤頁能為需求單保存的計算值（含舊版本的單）加上名稱與格式；
     * - workflow：transfer（能否轉出送達部門）與 not_requester（提單人本人不能簽核），讓卡片不顯示必定被拒絕的按鈕；實際授權仍由後端判斷。
     * @param {object} type 類型。
     * @returns {object} id、version、name、summary、department、fields、computed、workflow。
     */
    forClient(type) {
      return { id: type.id, version: type.version, name: type.name, summary: type.summary, department: departmentRef(type.departmentId), fields: type.fields.map(clientField),
        computed: type.computations.map(/** 計算項目的名稱與顯示方式。@param {object} item 計算。@returns {{key: string, label: string, display: string|null}} 計算。 */ (item) => ({ key: item.key, label: item.label, display: item.display })),
        workflow: { transfer: type.workflow.transfer, not_requester: type.workflow.approver.notRequester } };
    },
    /**
     * 自動生成回應的 type 形狀：id、version、name、fields，另帶 department（類型固定的送達部門 { id, name }；由對話決定時為 null），讓前端把部門顯示為唯讀。
     * @param {object} type 類型。
     * @returns {object} id、version、name、department、fields。
     */
    draftView(type) { return { id: type.id, version: type.version, name: type.name, department: departmentRef(type.departmentId), fields: type.fields.map(clientField) }; },
    /**
     * 交給 AI 閱讀的完整定義：說明、範例、詢問順序、欄位（不含申請人）與規則、計算名稱、送達部門與計算用的規則摘要；不含渲染與流程設定。
     * @param {object} type 類型。
     * @returns {object} AI 定義。
     */
    aiView(type) {
      return {
        id: type.id, name: type.name, description: type.ai.description, examples: type.ai.examples, ask_order: type.ai.askOrder, department: departmentRef(type.departmentId),
        fields: type.fields.filter(/** 排除申請人。@param {object} field 欄位。@returns {boolean} 保留時 true。 */ (field) => field.type !== 'self').map(/** 轉成 AI 欄位。@param {object} field 欄位。@returns {object} 欄位。 */ (field) => ({
          ...clientField(field), ...(field.rules ? { rules: { ...field.rules } } : {}), ...(field.filters ? { filters: structuredClone(field.filters) } : {}),
          ...(field.options_tool ? { options_tool: field.options_tool } : {}) })),
        computations: type.computations.map(/** 計算名稱。@param {object} item 計算。@returns {object} key、label。 */ (item) => ({ key: item.key, label: item.label })),
        rules_data: structuredClone(type.references),
      };
    },
    /** 有期間重疊檢查的 ledger（判斷帳號在期間內是否已有申請）。@returns {object[]} typeId、startField、endField。 */
    busySpecs() { return [...busy]; },
    /** 找出使用指定額度資料表的類型。@param {string} table 資料表名稱。@returns {object|null} 類型。 */
    ledgerOwner(table) { return [...types.values()].find(/** 比對資料表。@param {object} type 類型。@returns {boolean} 相符時 true。 */ (type) => type.ledger?.entitlement_table === table) ?? null; },
  };
}

/**
 * 讀取並驗證需求類型目錄與全部定義檔，建立查詢服務。任何錯誤都讓啟動失敗，訊息含檔名、鍵路徑與原因。
 * @param {object} [options={}] 設定。
 * @param {string} [options.dir=DEFAULT_TYPES_DIR] 定義檔目錄。
 * @param {object} [options.departments=departmentService] 部門查詢服務。
 * @param {object} [options.ledgerTables=LEDGER_TABLES] 允許的額度資料表。
 * @param {Function} [options.read=readFileSync] 讀檔函式（測試可注入）。
 * @returns {object} createRegistry 的查詢服務。
 * @throws {Error} REQUEST_TYPES_INVALID。
 */
export function loadRequestTypes({ dir = DEFAULT_TYPES_DIR, departments = departmentService, ledgerTables = LEDGER_TABLES, read = readFileSync } = {}) {
  const catalog = normalizeCatalog(readJson(dir, CATALOG_FILE, read));
  const types = new Map();
  for (const entry of catalog.types) types.set(entry.id, normalizeDefinition(readJson(dir, entry.file, read), { entry, tools: catalog.tools, departments, ledgerTables }));
  return createRegistry(catalog, types, departments);
}

let defaultRegistry;
/**
 * 取得預設目錄的需求類型服務（第一次呼叫時載入並驗證，之後重用）；啟動時 index.js 會先呼叫一次，讓設定錯誤在監聽前就失敗。
 * @returns {object} 需求類型查詢服務。
 * @throws {Error} REQUEST_TYPES_INVALID：定義檔錯誤（不快取，修正後重啟即可）。
 */
export function getRequestTypes() {
  defaultRegistry ??= loadRequestTypes();
  return defaultRegistry;
}
