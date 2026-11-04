import { HttpError } from '../../middleware/errorHandler.js';
import { DEFAULT_TIMEZONE_OFFSET, localToday } from '../../utils/dates.js';
import { logger } from '../../utils/logger.js';
import { removeFullStops } from '../../utils/punctuation.js';
import { DRAFT_REPLY_MAX, INTENT_MAX } from './aiAssistant.js';
import { executeTool } from './capabilities.js';
import { buildPrompt, editableFields, evaluateForm, renderContent } from './evaluator.js';
import { FIELD_KEY_PATTERN, FIELD_VALUE_MAX, isPlainObject, normalizeFieldValue, rawValueMax, TEXT_MAX } from './fieldTypes.js';

const SUBJECT_MAX = 100;
const MESSAGE_MAX = 300;
const HISTORY_MAX = 6;
const HISTORY_TEXT_MAX = Object.freeze({ user: MESSAGE_MAX, assistant: DRAFT_REPLY_MAX });
const STATE_FIELDS_MAX = 20;
const LOCKED_MAX = 30;
const HANDLER_ID_MAX = 100;
const TYPE_ID_MAX = 64;

// AI 無法使用時的固定說明（ai_error.message 與後端產生的回覆共用），依原因代碼對應；依共用標點規範不加句號
export const AI_NOTICES = Object.freeze({
  AI_UNAVAILABLE: '目前 AI 助手尚未啟用，請直接在右側欄位填寫或選擇',
  DAILY_QUOTA_EXCEEDED: '今日 AI 自動生成額度已用完（台北時間午夜重置），請直接在右側欄位填寫',
  GLOBAL_QUOTA_EXCEEDED: '全站今日 AI 自動生成額度已用完（台北時間午夜重置），請直接在右側欄位填寫',
  REQUEST_IN_PROGRESS: '上一則訊息仍在整理中，請稍候再送出',
  SERVICE_BUSY: 'AI 助手目前忙碌中，請稍後再試，或直接在右側欄位填寫',
  RATE_LIMIT_EXCEEDED: 'AI 助手目前忙碌中，請稍後再試，或直接在右側欄位填寫',
  AI_TIMEOUT: 'AI 助手處理逾時，請稍後再試，或直接在右側欄位填寫',
  AI_INVALID_RESPONSE: 'AI 助手這次的回應格式異常，請再試一次，或直接在右側欄位填寫',
  AI_UPSTREAM_ERROR: 'AI 助手暫時無法回應，請稍後再試，或直接在右側欄位填寫',
});

// 引擎層的通用工作說明（不含任何需求類型的內容）；目錄的 assistant.instructions 放在前面。
const CLASSIFY_TASK = [
  '輸入是 JSON：today 是台北今天的日期與星期；user 是使用者帳號與部門；subject 是需求主題；types 是可用的需求類型（id、name、summary、department）；departments 是公司部門（id、name、duty、business）。',
  '工作：1. 依 types 的 summary 判斷 type_id，沒有適合的專用類型時使用 default_type；2. 依 departments 的 duty 與 business 判斷 department_id，並給 confidence_score（0～100 的整數，明確屬於該部門業務才給高分）；所選類型有 department 時 department_id 必須是它；',
  '3. intent 用一句話簡述需求；4. reply 用親切的一到三句話打招呼，說明處理部門與接下來需要哪些資料。輸出符合 schema 的 JSON，不加 Markdown。',
].join('\n');
const FILL_TASK = [
  '輸入是 JSON：today、user、subject、message（使用者這次的訊息）、history（之前的對話）；request_type 是目前需求類型的完整定義（欄位、必填、選項、規則、rules_data）；',
  'other_types 是其他可用的需求類型；departments 是部門 id 與名稱；state 是畫面右側目前的內容（type_id、department_id、handler_id、fields、locked）；handler_options 是目前處理部門可指定的處理人；tool_results 是本回合工具回傳的資料。',
  '工作：1. intent 用一句話簡述需求；2. type_id 維持 state.type_id，只有使用者明確要改成 other_types 中的其他需求時才更換；',
  '3. request_type.department 有值時 department_id 必須是它，否則依部門職責判斷並給 confidence_score（0～100 的整數）；',
  '4. updates 只填使用者明確提供、或可由工具結果確定的欄位：key 必須是 request_type.fields 的 key，value 一律是字串，locked 中的欄位不得輸出；',
  '   datetime 為 YYYY-MM-DDTHH:mm、date 為 YYYY-MM-DD，相對日期依 today 換算；enum 只能從 options 擇一；account 欄位只能從工具回傳且 available 為 true 的 id 擇一；number 只填阿拉伯數字；',
  '5. handler_id 只在使用者明確要求指定處理人時，從 handler_options 擇一，否則為 null；',
  '6. reply 用親切的一到三句話回應，依 ask_order 詢問還缺的資料；回答格式或可選人員等問題時只能引用定義與工具結果；額度或計算結果等數字只能引用工具結果，不可自行計算。',
  '輸出符合 schema 的 JSON，不加 Markdown。',
].join('\n');

/**
 * 組出系統指示：目錄的 assistant.instructions 在前，引擎的通用工作說明在後，以換行串接。
 * @param {object} types 需求類型目錄（讀取 catalog.assistant.instructions）。
 * @param {string} task CLASSIFY_TASK 或 FILL_TASK。
 * @returns {string} 系統指示。
 */
function instructionsOf(types, task) {
  return [...types.catalog.assistant.instructions, task].join('\n');
}

/**
 * 組出第一回合分類（assistant.classify）的請求：系統指示、允許的類型與部門 id，以及交給模型的資料
 * （今天的日期與星期、使用者帳號與部門、主題、預設類型、全部類型摘要、部門名錄）。
 * 自動生成與分類評測腳本（scripts/eval-classification.js）共用這個函式，評測結果才會反映正式畫面實際送出的提示詞。
 * 不呼叫 AI、不讀寫資料庫。
 * @param {object} options 參數。
 * @param {object} options.types 需求類型目錄。
 * @param {object} options.departments 部門查詢服務（list、forJudge）。
 * @param {{username: string, department: {id: string, name: string}}} options.user 使用者（只用帳號與部門）。
 * @param {string} options.subject 需求主題。
 * @param {{date: string, weekday: string}} options.today 台北今天的日期與星期。
 * @returns {{instructions: string, lists: {typeIds: string[], departmentIds: string[]}, context: object}} 分類請求。
 */
export function classificationRequest({ types, departments, user, subject, today }) {
  return {
    instructions: instructionsOf(types, CLASSIFY_TASK),
    lists: { typeIds: types.ids(), departmentIds: departments.list().map(/** 取部門 id。@param {{id: string}} item 部門。@returns {string} id。 */ (item) => item.id) },
    context: { today: { date: today.date, weekday: today.weekday }, user: { username: user.username, department: { id: user.department.id, name: user.department.name } },
      subject, default_type: types.catalog.defaultType, types: types.summaries(), departments: departments.forJudge() },
  };
}

/**
 * 驗證可為 null 的字串參數。
 * @param {unknown} value 請求值。
 * @param {string} name 參數名稱，用於錯誤訊息。
 * @param {number} max 去除首尾空白後的 code points 上限。
 * @returns {string|null} 去除首尾空白後的字串；未提供、null 或空白時 null。
 * @throws {HttpError} 400 INVALID_PAYLOAD：不是字串或 null，或超過上限。
 */
function optionalText(value, name, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_PAYLOAD', `${name} 必須是字串或 null`);
  const text = value.trim();
  if (Array.from(text).length > max) throw new HttpError(400, 'INVALID_PAYLOAD', `${name} 最多 ${max} 字元`);
  return text || null;
}

/**
 * 驗證先前對話：可省略；提供時必須是最多 6 筆的陣列，每筆為 { role: 'user'|'assistant', text }，
 * text 為字串（使用者最多 300 字、助手最多 400 字）。內容只當作資料交給 AI，不影響後端規則。
 * @param {unknown} raw 請求本文的 history。
 * @returns {Array<{role: string, text: string}>} 整理後的對話（去除首尾空白）。
 * @throws {HttpError} 400 INVALID_PAYLOAD。
 */
function parseHistory(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'INVALID_PAYLOAD', 'history 必須是陣列');
  if (raw.length > HISTORY_MAX) throw new HttpError(400, 'INVALID_PAYLOAD', `history 最多 ${HISTORY_MAX} 筆`);
  return raw.map(/** 驗證單筆對話。@param {unknown} turn 對話。@returns {{role: string, text: string}} 整理後的對話。 */ (turn) => {
    if (!isPlainObject(turn) || !Object.hasOwn(HISTORY_TEXT_MAX, turn.role) || typeof turn.text !== 'string') {
      throw new HttpError(400, 'INVALID_PAYLOAD', 'history 的每一筆必須是 { role: user 或 assistant, text }');
    }
    const text = turn.text.trim();
    if (Array.from(text).length > HISTORY_TEXT_MAX[turn.role]) throw new HttpError(400, 'INVALID_PAYLOAD', `history 的 ${turn.role} 訊息最多 ${HISTORY_TEXT_MAX[turn.role]} 字元`);
    return { role: turn.role, text };
  });
}

/**
 * 驗證畫面右側已登記的內容（state）：可省略（第一次開啟視窗）；提供時必須是物件。
 * type_id（舊名 form_id 亦可）為 null 或存在的需求類型 id；department_id 為 null 或存在的部門 id；handler_id 為 null 或字串（是否可指定稍後判斷）；
 * intent 為選填字串（最多 80 字）；fields 為最多 20 個鍵的物件，鍵為小寫英數與底線、值為字串（已知類型的欄位依欄位上限，其他最多 500 字，
 * 不屬於最後採用的類型的鍵會被略過）；locked 為最多 30 個欄位 key（可含 type_id、department_id、handler_id）的陣列。
 * @param {unknown} raw 請求本文的 state。
 * @param {object} services 查詢服務。
 * @param {object} services.types 需求類型目錄。
 * @param {object} services.departments 部門查詢服務。
 * @returns {{typeId: string|null, departmentId: string|null, handlerId: string|null, intent: string|null, fields: Record<string, string>, locked: Set<string>}|null} 整理後的狀態；未提供時 null。
 * @throws {HttpError} 400 INVALID_PAYLOAD。
 */
function parseState(raw, { types, departments }) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) throw new HttpError(400, 'INVALID_PAYLOAD', 'state 必須是物件');
  const typeId = optionalText(raw.type_id ?? raw.form_id, 'state.type_id', TYPE_ID_MAX);
  const type = typeId ? types.find(typeId) : null;
  if (typeId && !type) throw new HttpError(400, 'INVALID_PAYLOAD', '找不到指定的需求類型');
  const departmentId = optionalText(raw.department_id, 'state.department_id', TYPE_ID_MAX);
  if (departmentId && !departments.findDepartment(departmentId)) throw new HttpError(400, 'INVALID_PAYLOAD', '找不到指定的部門');
  const handlerId = optionalText(raw.handler_id, 'state.handler_id', HANDLER_ID_MAX);
  const intent = optionalText(raw.intent, 'state.intent', INTENT_MAX);
  const fields = {};
  if (raw.fields !== undefined && raw.fields !== null) {
    if (!isPlainObject(raw.fields)) throw new HttpError(400, 'INVALID_PAYLOAD', 'state.fields 必須是物件');
    const entries = Object.entries(raw.fields);
    if (entries.length > STATE_FIELDS_MAX) throw new HttpError(400, 'INVALID_PAYLOAD', `state.fields 最多 ${STATE_FIELDS_MAX} 個欄位`);
    for (const [key, value] of entries) {
      if (!FIELD_KEY_PATTERN.test(key)) throw new HttpError(400, 'INVALID_PAYLOAD', 'state.fields 的欄位名稱格式不符');
      if (typeof value !== 'string') throw new HttpError(400, 'INVALID_PAYLOAD', 'state.fields 的值必須是字串');
      const field = type?.fieldsByKey.get(key);
      const max = field ? rawValueMax(field) : type ? FIELD_VALUE_MAX : TEXT_MAX;
      if (Array.from(value).length > max) throw new HttpError(400, 'INVALID_PAYLOAD', `state.fields.${key} 最多 ${max} 字元`);
      fields[key] = value;
    }
  }
  const locked = new Set();
  if (raw.locked !== undefined && raw.locked !== null) {
    if (!Array.isArray(raw.locked) || raw.locked.length > LOCKED_MAX) throw new HttpError(400, 'INVALID_PAYLOAD', `state.locked 必須是最多 ${LOCKED_MAX} 個欄位名稱的陣列`);
    for (const key of raw.locked) {
      if (typeof key !== 'string' || !FIELD_KEY_PATTERN.test(key)) throw new HttpError(400, 'INVALID_PAYLOAD', 'state.locked 只能包含欄位名稱');
      locked.add(key);
    }
  }
  return { typeId, departmentId, handlerId, intent, fields, locked };
}

/**
 * 驗證「自動生成」請求本文（POST /api/tickets/draft）。
 * 規則：subject 去除首尾空白後 1～100 字；message 可省略（第一次開啟與手動編輯驗證時不帶），有值時為最多 300 字的字串，空白視為未提供；
 * history 與 state 規則見 parseHistory、parseState。
 * @param {unknown} body 請求本文。
 * @param {object} services 查詢服務。
 * @param {object} services.types 需求類型目錄。
 * @param {object} services.departments 部門查詢服務。
 * @returns {{subject: string, message: string|null, history: Array<object>, state: object|null}} 整理後的請求。
 * @throws {HttpError} 400 INVALID_PAYLOAD。
 */
export function parseDraftRequest(body, { types, departments }) {
  const raw = isPlainObject(body) ? body : {};
  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';
  if (!subject || Array.from(subject).length > SUBJECT_MAX) throw new HttpError(400, 'INVALID_PAYLOAD', `subject 必須是 1 到 ${SUBJECT_MAX} 字元的非空白字串`);
  if (!(raw.message === undefined || raw.message === null || typeof raw.message === 'string')) throw new HttpError(400, 'INVALID_PAYLOAD', 'message 必須是字串');
  const message = optionalText(raw.message, 'message', MESSAGE_MAX);
  return { subject, message, history: parseHistory(raw.history), state: parseState(raw.state, { types, departments }) };
}

/**
 * 產生招呼語：需求類型定義有 ai.greeting 時使用定義的文字，否則使用目錄的 fallback_greeting；
 * 可用的佔位文字為 {username}（帳號）、{type_name}（類型名稱）、{department}（處理部門名稱，尚未決定時為空字串）。
 * @param {object} options 參數。
 * @param {object} options.types 需求類型目錄。
 * @param {object} options.type 需求類型。
 * @param {{name: string}|null} options.department 處理部門。
 * @param {string} options.username 使用者帳號。
 * @returns {string} 招呼語。
 */
export function greetingFor({ types, type, department, username }) {
  const template = type.ai.greeting ?? types.catalog.assistant.fallbackGreeting;
  return template.replaceAll('{username}', username).replaceAll('{type_name}', type.name).replaceAll('{department}', department?.name ?? '');
}

/**
 * 把 AI 無法使用的錯誤轉成回應中的 ai_error；不是 HttpError 的錯誤（程式錯誤）原樣拋出；
 * 說明文字的標點在回應出口統一整理（見 createDraftEngine 的 run）
 * @param {unknown} error 預扣額度或 AI 呼叫拋出的錯誤。
 * @returns {{code: string, message: string, retry_after?: number}} 固定代碼、說明與建議等待秒數。
 * @throws {unknown} 非 HttpError。
 */
function aiErrorOf(error) {
  if (!(error instanceof HttpError)) throw error;
  const code = error.draftReason ?? error.code;
  return { code, message: AI_NOTICES[code] ?? error.message, ...(error.retryAfter ? { retry_after: error.retryAfter } : {}) };
}

/**
 * 建立「自動生成」對話引擎：無狀態，每次依主題、訊息、對話與畫面右側的 state 重新判斷與驗證。引擎不含任何需求類型專屬的程式，
 * 一律依需求類型定義（欄位、計算、檢查、渲染、流程）與目錄（類型摘要、工具、存取規則）處理。處理流程：
 * ① 第一次開啟（沒有 state）或有 message 時，若主要或備援 AI 供應商有金鑰（config.aiApiKey、config.aiFallbackProvider）就預扣自動生成額度並呼叫 AI，在 finally 釋放租約：
 *    第一次開啟為「分類」（類型摘要＋部門名錄 → 需求類型、部門、信心分數、intent、回覆）；之後為「填寫」（目前類型的完整定義、state、今天，
 *    可呼叫類型允許的工具，伺服器端依目錄存取規則執行，整回合最多 3 次工具）。沒有金鑰、額度、逾時與上游錯誤都不讓請求失敗，改回 ai_error；
 * ② 需求類型：AI 選的有效類型（未鎖定 type_id 時）→ state.type_id → 第一次開啟且沒有 AI 結果時以主題關鍵字備援 → 預設類型；
 * ③ 處理部門：類型有固定部門時一律為該部門；否則依序為使用者鎖定的 state 部門 → AI 信心分數達門檻的部門 → state 部門 → null；
 * ④ 欄位：先帶入 state 的值，再把 AI 更新套用到未鎖定的欄位；self 欄位一律為目前帳號；
 * ⑤ 在讀取交易內驗證欄位、執行計算與 draft 階段的檢查（AI 的數字一律不採信）；
 * ⑥ 處理人：AI 建議或 state 的處理人必須是處理部門可指定的處理人（定義 handler.not_self 時排除本人），不符時改為未指定並提醒；
 * ⑦ 產生檢核清單、完成時的需求內容與即時預覽。
 * 回應中顯示給使用者的 reply、prompt 與 ai_error.message 一律經過 removeFullStops（共用標點規範），不論文字來自 AI、定義檔或程式；
 * 日誌只記錄 id 與計數，不記錄主題、訊息、對話或欄位值。
 * @param {object} options 依賴。
 * @param {object} options.types 需求類型目錄。
 * @param {object} options.departments 部門查詢服務。
 * @param {object} options.accounts 帳號查詢服務。
 * @param {object} options.store 需求單儲存（withLedger、ledgerBalances）。
 * @param {object} options.usage 配額服務（reserveDraft、releaseDraft）。
 * @param {{classify: Function, fill: Function}} options.assistant AI 助手。
 * @param {object} options.config 設定（aiApiKey：主要 AI 供應商的金鑰；aiFallbackProvider：有金鑰的備援供應商；兩者都沒有時不呼叫 AI）。
 * @param {Function} options.clock 時間來源。
 * @returns {{run: Function}} 引擎。
 */
export function createDraftEngine({ types, departments, accounts, store, usage, assistant, config, clock }) {
  /**
   * 預扣自動生成額度後呼叫 AI，無論成功失敗都釋放租約；AI 相關失敗轉成 aiError，不讓請求失敗。
   * @param {object} user 憑證身分。
   * @param {() => Promise<object>} call 實際呼叫 AI 的函式。
   * @returns {Promise<{ai: object|null, aiError: object|null}>} AI 結果或失敗原因。
   * @throws {unknown} 非 HttpError 的程式錯誤。
   */
  async function consultAI(user, call) {
    if (!config.aiApiKey && !config.aiFallbackProvider) return { ai: null, aiError: { code: 'AI_UNAVAILABLE', message: AI_NOTICES.AI_UNAVAILABLE } };
    let reservation;
    try { reservation = await usage.reserveDraft(user.userID); } catch (error) { return { ai: null, aiError: aiErrorOf(error) }; }
    try {
      return { ai: await call(), aiError: null };
    } catch (error) {
      return { ai: null, aiError: aiErrorOf(error) };
    } finally {
      await usage.releaseDraft(user.userID, reservation.id);
    }
  }

  /**
   * 組出系統指示：目錄的 assistant.instructions 加上引擎的通用工作說明。
   * @param {string} task CLASSIFY_TASK 或 FILL_TASK。
   * @returns {string} 系統指示。
   */
  function instructionsFor(task) {
    return instructionsOf(types, task);
  }

  /**
   * 執行一次自動生成。
   * @param {object} user 憑證身分。
   * @param {{subject: string, message: string|null, history: Array<object>, state: object|null}} request parseDraftRequest 的結果。
   * @returns {Promise<object>} 回應本文。
   * @throws {HttpError} 503 儲存無法讀取；非 AI 的程式錯誤原樣拋出。
   */
  async function run(user, { subject, message, history, state }) {
    const firstCall = state === null;
    const wantsAI = firstCall || message !== null;
    const locked = state?.locked ?? new Set();
    const stateType = state?.typeId ? types.find(state.typeId) : null;
    const activeType = stateType ?? types.defaultType();
    const departmentIds = departments.list().map(/** 取部門 id。@param {{id: string}} item 部門。@returns {string} id。 */ (item) => item.id);
    const todayOf = /** 取類型時區的今天。@param {object} type 類型。@returns {object} 今天。 */ (type) => localToday(clock(), type.timezoneOffset ?? DEFAULT_TIMEZONE_OFFSET);

    /**
     * 第一次開啟視窗：交給 AI 類型摘要與部門名錄判斷類型與部門（請求內容由 classificationRequest 組出）。
     * @returns {Promise<object>} 分類結果。
     */
    function classify() {
      return assistant.classify(classificationRequest({ types, departments, user, subject, today: todayOf(activeType) }));
    }

    /**
     * 之後各回合：交給 AI 目前類型的完整定義與 state，讓它依需要呼叫允許的工具（伺服器端執行並套用存取規則）。
     * @returns {Promise<object>} 填寫結果。
     */
    function fill() {
      const today = todayOf(activeType);
      const allowed = types.toolsFor(activeType);
      const stateDepartment = activeType.departmentId ?? state?.departmentId ?? null;
      const keys = [...new Set(types.list().flatMap(/** 取各類型可填欄位。@param {object} type 類型。@returns {string[]} key。 */ (type) => editableFields(type).map(/** 取 key。@param {{key: string}} field 欄位。@returns {string} key。 */ (field) => field.key)))];
      /**
       * 執行一次工具：只允許目前類型 ai.tools 內的工具；資料庫暫時無法讀取時回傳錯誤資料給模型，不讓請求失敗。
       * @param {string} id 工具 id。
       * @param {unknown} args 模型提供的參數。
       * @returns {Promise<object>} { result } 或 { error }。
       */
      async function runTool(id, args) {
        const tool = allowed.find(/** 比對工具 id。@param {{id: string}} item 工具。@returns {boolean} 相符時 true。 */ (item) => item.id === id);
        if (!tool) return { error: '這個工具不能在目前的需求類型使用' };
        try {
          return await executeTool(tool, args, { user, type: activeType, registry: types, accounts, departments, store, clock });
        } catch (error) {
          if (error instanceof HttpError) return { error: '資料暫時無法讀取，請稍後再試' };
          throw error;
        }
      }
      return assistant.fill({
        instructions: instructionsFor(FILL_TASK),
        lists: { typeIds: types.ids(), departmentIds, keys },
        tools: allowed,
        runTool,
        context: {
          today: { date: today.date, weekday: today.weekday }, user: { username: user.username, department: { id: user.department.id, name: user.department.name } },
          subject, message, history,
          request_type: types.aiView(activeType),
          other_types: types.summaries().filter(/** 排除目前類型。@param {{id: string}} item 摘要。@returns {boolean} 保留時 true。 */ (item) => item.id !== activeType.id),
          departments: departments.list().map(/** 部門 id 與名稱。@param {{id: string, name: string}} item 部門。@returns {object} 部門。 */ (item) => ({ id: item.id, name: item.name })),
          state: state ? { type_id: state.typeId, department_id: state.departmentId, handler_id: state.handlerId, fields: state.fields, locked: [...locked] } : null,
          handler_options: stateDepartment && activeType.handler ? accounts.handlersOf(stateDepartment).map(/** 取帳號。@param {{id: string}} entry 處理人。@returns {string} 帳號。 */ (entry) => entry.id)
            .filter(/** 依定義排除本人。@param {string} id 帳號。@returns {boolean} 保留時 true。 */ (id) => !activeType.handler.notSelf || id !== user.username) : [],
        },
      });
    }

    const { ai, aiError } = wantsAI ? await consultAI(user, firstCall ? classify : fill) : { ai: null, aiError: null };
    // ② 需求類型
    let type;
    if (ai?.typeId && !locked.has('type_id')) type = types.find(ai.typeId);
    else if (stateType) type = stateType;
    else if (firstCall && !ai) type = types.match(subject);
    else type = types.defaultType();
    // ③ 處理部門
    let department = null;
    let departmentSource = null;
    const stateDepartment = state?.departmentId ? departments.findDepartment(state.departmentId) : null;
    if (type.departmentId) {
      department = departments.findDepartment(type.departmentId);
      departmentSource = 'system';
    } else if (stateDepartment && locked.has('department_id')) {
      department = stateDepartment;
      departmentSource = 'user';
    } else if (ai?.departmentId && ai.confidence >= type.departmentChoice.minConfidence) {
      department = departments.findDepartment(ai.departmentId);
      departmentSource = 'ai';
    } else if (stateDepartment) {
      department = stateDepartment;
      departmentSource = 'ai';
    }
    const departmentRef = department ? { id: department.id, name: department.name } : null;
    // ④ 欄位
    const editable = editableFields(type);
    const input = {};
    const sources = {};
    for (const field of editable) {
      const value = state?.fields[field.key];
      if (typeof value !== 'string') continue;
      input[field.key] = normalizeFieldValue(field, value);
      if (input[field.key]) sources[field.key] = locked.has(field.key) ? 'user' : 'ai';
    }
    let aiUpdates = 0;
    for (const { key, value } of ai?.updates ?? []) {
      const field = type.fieldsByKey.get(key);
      if (!field || field.type === 'self' || locked.has(key)) continue;
      input[key] = normalizeFieldValue(field, value);
      aiUpdates += 1;
      if (input[key]) sources[key] = 'ai';
      else delete sources[key];
    }
    // ⑤ 驗證、計算與檢查
    const today = todayOf(type).date;
    const evaluation = await store.withLedger(/** 在讀取交易內驗證。@param {object} helpers 交易內查詢。@returns {object} 結果。 */ (helpers) => evaluateForm({
      type, input, user, department: departmentRef, registry: types, accounts, departments, helpers, today, phase: 'draft' }));
    const { values, computed, computedMap, summaries, fieldOptions } = evaluation;
    const missing = [...(department ? [] : ['department_id']), ...evaluation.missing];
    const invalid = [...evaluation.invalid, ...evaluation.failures.map(/** 檢查失敗轉成欄位錯誤。@param {{key: string, message: string}} failure 失敗。@returns {{key: string, message: string}} 錯誤。 */ ({ key, message: text }) => ({ key, message: text }))];
    // ⑥ 處理人
    const handlerOptions = department && type.handler ? accounts.handlersOf(department.id)
      .filter(/** 依定義排除本人。@param {{id: string}} entry 處理人。@returns {boolean} 保留時 true。 */ (entry) => !type.handler.notSelf || entry.id !== user.username) : [];
    /** 是否為可指定的處理人。@param {string|null} id 帳號。@returns {boolean} 可指定時 true。 */
    const assignable = (id) => Boolean(id) && handlerOptions.some(/** 比對帳號。@param {{id: string}} entry 處理人。@returns {boolean} 相符時 true。 */ (entry) => entry.id === id);
    const notes = [];
    let handlerId = null;
    let handlerSource = null;
    if (!locked.has('handler_id') && assignable(ai?.handlerId)) {
      handlerId = ai.handlerId;
      handlerSource = 'ai';
    } else if (state?.handlerId) {
      if (assignable(state.handlerId)) {
        handlerId = state.handlerId;
        handlerSource = locked.has('handler_id') ? 'user' : 'ai';
      } else {
        notes.push(department ? `原指定處理人不是「${department.name}」可指定的處理人，已改為未指定` : '尚未決定處理部門，已取消指定處理人');
      }
    }
    const handler = handlerId ? { id: handlerId, name: handlerId } : null;
    // ⑦ 完成判斷、檢核清單與內容
    const complete = Boolean(department) && !missing.length && !invalid.length;
    const preview = renderContent(type, { values, computedMap, department: departmentRef, handler, departments });
    const orderedSources = {};
    for (const field of type.fields) {
      if (field.type === 'self') orderedSources[field.key] = 'system';
      else if (values[field.key] && sources[field.key]) orderedSources[field.key] = sources[field.key];
    }
    if (departmentSource) orderedSources.department_id = departmentSource;
    if (handlerSource) orderedSources.handler_id = handlerSource;
    let reply = '';
    if (ai?.reply && !(firstCall && type.ai.greeting)) reply = ai.reply;
    else if (wantsAI) {
      const opening = firstCall ? greetingFor({ types, type, department: departmentRef, username: user.username }) : ai ? '已依你的訊息更新右側需求內容，請確認是否正確' : '';
      reply = [opening, aiError?.message].filter(Boolean).join('\n');
    }
    const intent = ai?.intent || state?.intent || (type.departmentId || !department ? type.name : `${department.name}相關需求`);
    logger('info', 'ticket.draft.evaluated', { typeId: type.id, departmentId: department?.id ?? null, firstCall, aiAttempted: wantsAI, aiUsed: Boolean(ai),
      aiError: aiError?.code ?? null, aiUpdates, toolsUsed: ai?.toolsUsed ?? [], historyCount: history.length, lockedCount: locked.size,
      missingCount: missing.length, invalidCount: invalid.length, complete });
    return {
      intent,
      type: types.draftView(type),
      department: departmentRef,
      department_options: departments.list().map(/** 部門選項。@param {{id: string, name: string}} item 部門。@returns {{id: string, name: string}} 選項。 */ (item) => ({ id: item.id, name: item.name })),
      handler, handler_options: handlerOptions,
      values, sources: orderedSources, missing, invalid,
      field_options: fieldOptions,
      computed, summaries,
      // 回應出口統一套用共用標點規範：AI 回覆、定義檔的招呼語、後端固定說明與檢核清單都在畫面同一個對話框顯示，一律不留「。」
      reply: removeFullStops(reply), prompt: removeFullStops(buildPrompt({ type, department: departmentRef, missing, invalid, notes, complete })),
      ai_available: Boolean(config.aiApiKey || config.aiFallbackProvider) && !aiError,
      ai_error: aiError && { ...aiError, message: removeFullStops(aiError.message) },
      complete, rendered_content: complete ? preview : null, preview_content: preview,
      tools_used: ai?.toolsUsed ?? [],
    };
  }
  return { run };
}
