import { GoogleGenAI, Type } from '@google/genai';
import { env } from '../../config/env.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { withAgentDeadline } from '../../utils/agentDeadline.js';
import { logger, diagnoseError } from '../../utils/logger.js';
import { removeFullStops } from '../../utils/punctuation.js';

// 一回合（含工具呼叫與整理輸出）的總期限；關機最少等待時間（env.SHUTDOWN_TIMEOUT_MS）以這個值加 10 秒為下限。
export const DRAFT_TIMEOUT_MS = 60000;
export const MAX_TOOL_CALLS = 3;
export const DRAFT_REPLY_MAX = 400;
export const INTENT_MAX = 80;
export const UPDATE_VALUE_MAX = 2000;
const UPDATES_MAX = 20;
// Gemini 每次呼叫的輸出上限（與 Claude 助手相同）。Gemini 3.x 預設會先思考，思考用掉的 token 也算在上限內，上限太小時 JSON 會在中途被截斷。
export const GEMINI_OUTPUT_LIMITS = Object.freeze({ classify: 4096, tools: 2048, fill: 4096 });
const HANDLER_ID_MAX = 100;
const PARAM_TYPES = Object.freeze({ string: Type.STRING, integer: Type.INTEGER, number: Type.NUMBER, boolean: Type.BOOLEAN });

/** 建立固定的模型格式錯誤，避免洩漏模型原文（Gemini 與 Claude 助手共用）。@returns {HttpError} HTTP 500 錯誤。 */
export const invalidOutput = () => Object.assign(new HttpError(500, 'SERVER_ERROR', 'AI 回應格式異常，請稍後再試；仍可手動填寫欄位'), { draftReason: 'AI_INVALID_RESPONSE' });

/**
 * 截斷字串到指定 code points。
 * @param {string} value 字串。
 * @param {number} max 上限。
 * @returns {string} 截斷後的字串。
 */
function clip(value, max) {
  return Array.from(value).slice(0, max).join('');
}

/**
 * 整理模型輸出的文字：去除首尾空白，依共用標點規範處理「。」（見 utils/punctuation.js 的 removeFullStops），再截斷到上限。
 * Gemini 與 Claude 的分類、填寫結果都經過這裡，因此兩家的輸出規則相同。
 * @param {string} value 模型輸出的字串。
 * @param {number} max code points 上限。
 * @returns {string} 整理後的字串。
 */
function tidy(value, max) {
  return clip(removeFullStops(value.trim()).trim(), max);
}

/**
 * 建立可為 null 的字串列舉；清單為空時不加 enum（Gemini 不接受空列舉）。
 * @param {string[]} values 允許值。
 * @returns {object} schema。
 */
function nullableEnum(values) {
  return { type: Type.STRING, nullable: true, ...(values.length ? { enum: values } : {}) };
}

/**
 * 第一次開啟視窗（分類）的結構化輸出 schema：需求類型、處理部門、信心分數、判斷結果與回覆。
 * @param {{typeIds: string[], departmentIds: string[]}} lists 允許的 id。
 * @returns {object} Gemini responseSchema。
 */
export function classifySchema({ typeIds, departmentIds }) {
  return {
    type: Type.OBJECT,
    properties: {
      intent: { type: Type.STRING },
      type_id: nullableEnum(typeIds),
      department_id: nullableEnum(departmentIds),
      confidence_score: { type: Type.INTEGER, minimum: 0, maximum: 100 },
      reply: { type: Type.STRING },
    },
    required: ['intent', 'type_id', 'department_id', 'confidence_score', 'reply'],
  };
}

/**
 * 之後各回合（填寫）的結構化輸出 schema：另含欄位更新與指定處理人；updates.key 限定為需求類型定義的欄位 key。
 * @param {{typeIds: string[], departmentIds: string[], keys: string[]}} lists 允許的 id 與欄位 key。
 * @returns {object} Gemini responseSchema。
 */
export function fillSchema({ typeIds, departmentIds, keys }) {
  return {
    type: Type.OBJECT,
    properties: {
      intent: { type: Type.STRING },
      type_id: nullableEnum(typeIds),
      department_id: nullableEnum(departmentIds),
      confidence_score: { type: Type.INTEGER, minimum: 0, maximum: 100 },
      updates: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { key: { type: Type.STRING, ...(keys.length ? { enum: keys } : {}) }, value: { type: Type.STRING } }, required: ['key', 'value'] } },
      handler_id: { type: Type.STRING, nullable: true },
      reply: { type: Type.STRING },
    },
    required: ['intent', 'type_id', 'department_id', 'confidence_score', 'updates', 'handler_id', 'reply'],
  };
}

/**
 * 把目錄工具轉成 Gemini function declaration（名稱為工具 id，參數依目錄宣告）。
 * @param {object} tool 目錄工具（id、description、returns、params）。
 * @returns {object} function declaration。
 */
export function toolDeclaration(tool) {
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(tool.params)) {
    properties[name] = { type: PARAM_TYPES[spec.type], description: spec.description };
    if (spec.required) required.push(name);
  }
  return { name: tool.id, description: `${tool.description} 回傳：${tool.returns}`, parameters: { type: Type.OBJECT, properties, ...(required.length ? { required } : {}) } };
}

/**
 * 驗證並整理分類輸出；只採信清單內的 id。reply 與 intent 依共用標點規範整理（不使用「。」）後截斷。
 * @param {unknown} result 模型解析後的 JSON。
 * @param {{typeIds: string[], departmentIds: string[]}} lists 允許的 id。
 * @returns {{intent: string, typeId: string|null, departmentId: string|null, confidence: number, reply: string|null}} 整理後的結果。
 * @throws {HttpError} 500 AI_INVALID_RESPONSE：結構不符。
 */
export function buildClassification(result, { typeIds, departmentIds }) {
  if (!result || typeof result !== 'object' || typeof result.reply !== 'string') throw invalidOutput();
  const reply = tidy(result.reply, DRAFT_REPLY_MAX);
  return {
    intent: typeof result.intent === 'string' ? tidy(result.intent, INTENT_MAX) : '',
    typeId: typeIds.includes(result.type_id) ? result.type_id : null,
    departmentId: departmentIds.includes(result.department_id) ? result.department_id : null,
    confidence: Number.isInteger(result.confidence_score) && result.confidence_score >= 0 && result.confidence_score <= 100 ? result.confidence_score : 0,
    reply: reply || null,
  };
}

/**
 * 驗證並整理填寫輸出；只採信清單內的 id 與欄位 key，欄位值之後仍由後端依定義驗證：
 * - 結構必須是物件、updates 是陣列、reply 是字串，否則視為格式異常；
 * - updates 只保留 key 在清單且 value 為字串的項目（去除首尾空白、依共用標點規範處理「。」、最多 2000 字），同一 key 以最後一筆為準，最多 20 筆；
 * - handler_id 為去除首尾空白的字串（最多 100 字）或 null，是否可指定由後端判斷；
 * - 其他規則同 buildClassification。
 * @param {unknown} result 模型解析後的 JSON。
 * @param {{typeIds: string[], departmentIds: string[], keys: string[]}} lists 允許的 id 與欄位 key。
 * @returns {{intent: string, typeId: string|null, departmentId: string|null, confidence: number, updates: Array<{key: string, value: string}>, handlerId: string|null, reply: string|null}} 整理後的結果。
 * @throws {HttpError} 500 AI_INVALID_RESPONSE：結構不符。
 */
export function buildFill(result, lists) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.updates)) throw invalidOutput();
  const base = buildClassification(result, lists);
  const byKey = new Map();
  for (const update of result.updates.slice(0, UPDATES_MAX)) {
    if (!update || typeof update !== 'object' || !lists.keys.includes(update.key) || typeof update.value !== 'string') continue;
    byKey.set(update.key, tidy(update.value, UPDATE_VALUE_MAX));
  }
  return {
    ...base,
    updates: [...byKey].map(/** 轉回陣列形狀。@param {[string, string]} entry [key, value]。@returns {{key: string, value: string}} 更新。 */ ([key, value]) => ({ key, value })),
    handlerId: typeof result.handler_id === 'string' && result.handler_id.trim() ? clip(result.handler_id.trim(), HANDLER_ID_MAX) : null,
  };
}

/**
 * 建立供應商共用的回合守衛（Gemini 與 Claude 助手共用）：在 timeoutMs 期限內執行一回合，記錄開始、完成與失敗，
 * 並把各種失敗轉成帶 draftReason 的 HttpError：
 * - 工作本身拋出的 HttpError（例如未設定金鑰、輸出格式異常）保留原本的 draftReason，沒有時依階段補上 AI_UNAVAILABLE 或 AI_INVALID_RESPONSE；
 * - 上游 HTTP 429 → 429 RATE_LIMIT_EXCEEDED（retryAfter 10 秒）；超過期限 → AI_TIMEOUT；其他上游或網路錯誤 → AI_UPSTREAM_ERROR，
 *   並在錯誤上附 upstreamStatus（上游 HTTP 狀態，例如過載的 503、529；沒有時為 null），供備援切換判斷。
 * 日誌只含階段、模型、耗時、計數與 diagnoseError 的固定分類，不含使用者文字、欄位值或供應商錯誤原文。
 * @param {object} options 設定。
 * @param {string} options.model 模型名稱（寫入日誌與結果）。
 * @param {number} options.timeoutMs 整回合期限毫秒數。
 * @returns {(purpose: string, work: (signal: AbortSignal, track: (stage: string) => void) => Promise<object>) => Promise<object>} 守衛函式，結果另含 model。
 */
export function createTurnGuard({ model, timeoutMs }) {
  /**
   * 在期限內執行一回合，並把錯誤轉成帶 draftReason 的 HttpError；日誌只記錄階段、耗時與計數，不記錄使用者文字或欄位值。
   * @param {string} purpose 日誌用途（ticket.draft.classify、ticket.draft.fill）。
   * @param {(signal: AbortSignal, track: (stage: string) => void) => Promise<object>} work 實際工作。
   * @returns {Promise<object>} 工作結果另含 model。
   * @throws {HttpError} 帶 draftReason：AI_UNAVAILABLE、AI_INVALID_RESPONSE、RATE_LIMIT_EXCEEDED、AI_TIMEOUT、AI_UPSTREAM_ERROR。
   */
  return async function guarded(purpose, work) {
    const started = Date.now();
    let stage = 'client.initialize';
    /** 記錄目前階段。@param {string} next 階段名稱。@returns {void} */
    const track = (next) => { stage = next; };
    logger('info', 'ticket.draft.ai.started', { model, purpose });
    try {
      const result = await withAgentDeadline(/** 執行工作。@param {AbortSignal} signal 逾時取消訊號。@returns {Promise<object>} 結果。 */ (signal) => work(signal, track), timeoutMs);
      logger('info', 'ticket.draft.ai.completed', { purpose, durationMs: Date.now() - started, typeId: result.typeId, departmentId: result.departmentId,
        confidence: result.confidence, updateCount: result.updates?.length ?? 0, toolCount: result.toolsUsed.length, answered: result.reply !== null });
      return { ...result, model };
    } catch (error) {
      const diagnostic = diagnoseError(error);
      if (error instanceof HttpError && !error.agentTimeout) {
        delete diagnostic.upstreamStatus;
        diagnostic.reason = stage === 'client.initialize' ? 'MISSING_API_KEY' : 'INVALID_AI_RESPONSE';
      }
      if (error?.agentTimeout) diagnostic.reason = 'TIMEOUT';
      logger('error', 'ticket.draft.ai.failed', { purpose, stage, model, durationMs: Date.now() - started, ...diagnostic });
      if (error instanceof HttpError && !error.agentTimeout) {
        throw error.draftReason ? error : Object.assign(error, { draftReason: stage === 'client.initialize' ? 'AI_UNAVAILABLE' : 'AI_INVALID_RESPONSE' });
      }
      if (error?.status === 429) throw Object.assign(new HttpError(429, 'RATE_LIMIT_EXCEEDED', 'AI 服務繁忙中，請稍後 10 秒再試；仍可手動填寫欄位'), { draftReason: 'RATE_LIMIT_EXCEEDED', retryAfter: 10 });
      if (error?.agentTimeout) throw Object.assign(new HttpError(500, 'SERVER_ERROR', 'AI 處理逾時，請稍後再試；仍可手動填寫欄位'), { draftReason: 'AI_TIMEOUT' });
      throw Object.assign(new HttpError(500, 'SERVER_ERROR', 'AI 服務暫時無法回應；仍可手動填寫欄位'), { draftReason: 'AI_UPSTREAM_ERROR', upstreamStatus: error?.status ?? null });
    }
  };
}

let client;
/**
 * 延遲建立並重用 Gemini SDK client，不在啟動時呼叫外部服務。
 * @returns {GoogleGenAI} 已設定後端金鑰的 client。
 * @throws {HttpError} 未設定金鑰（draftReason AI_UNAVAILABLE）。
 */
function getClient() {
  if (!env.geminiApiKey) throw Object.assign(new HttpError(500, 'SERVER_ERROR', '尚未設定 Gemini API 金鑰'), { draftReason: 'AI_UNAVAILABLE' });
  client ??= new GoogleGenAI({ apiKey: env.geminiApiKey });
  return client;
}

/**
 * 解析模型的 JSON 文字（Gemini 與 Claude 助手共用）。
 * @param {unknown} text 回應文字。
 * @returns {unknown} 解析結果。
 * @throws {HttpError} 500 AI_INVALID_RESPONSE：不是 JSON。
 */
export function parseJson(text) {
  try { return JSON.parse(text); } catch { throw invalidOutput(); }
}

/**
 * 建立「需求單自動生成」AI 助手（Gemini）。兩種呼叫：
 * - classify：第一次開啟視窗，一次結構化輸出判斷需求類型與部門；
 * - fill：之後各回合，先在允許的工具中讓模型以原生 function calling 取得資料（伺服器端執行、整回合最多 3 次），
 *   再以一次結構化輸出整理欄位更新與回覆（因為模型不一定能同時使用工具與結構化輸出，所以分成工具階段與整理階段）。
 * 整回合（含所有 Gemini 呼叫與工具執行）預設在 60 秒期限內完成；有備援時由供應商切換器傳入較短期限；欄位是否有效、部門規則與數字一律由後端另行驗證與計算。
 * @param {object} [options={}] 設定。
 * @param {Function} [options.getAI=getClient] SDK client 取得函式。
 * @param {string} [options.model=env.geminiModel] 模型名稱。
 * @param {number} [options.timeoutMs=DRAFT_TIMEOUT_MS] 整回合期限毫秒數。
 * @param {number} [options.maxToolCalls=MAX_TOOL_CALLS] 每回合最多執行的工具次數。
 * @returns {{classify: Function, fill: Function}} 助手。
 */
export function createGeminiAssistant({ getAI = getClient, model = env.geminiModel, timeoutMs = DRAFT_TIMEOUT_MS, maxToolCalls = MAX_TOOL_CALLS } = {}) {
  const guarded = createTurnGuard({ model, timeoutMs });

  /**
   * 呼叫一次 Gemini 並記錄耗時、停止原因（finishReason，例如 STOP、MAX_TOKENS）與用量（輸入、輸出與思考的 token 數，不含內容），
   * 方便判斷輸出是否因達到上限而被截斷。
   * @param {object} ai SDK client。
   * @param {object} request generateContent 的 contents 與 config。
   * @param {AbortSignal} signal 逾時取消訊號。
   * @param {string} purpose 日誌用途。
   * @returns {Promise<object>} SDK 回應。
   */
  async function generate(ai, request, signal, purpose) {
    const started = Date.now();
    logger('info', 'gemini.generate.started', { model, purpose });
    const response = await ai.models.generateContent({ model, ...request, config: { ...request.config, httpOptions: { timeout: timeoutMs }, abortSignal: signal } });
    signal.throwIfAborted();
    const usage = response.usageMetadata ?? {};
    logger('info', 'gemini.generate.completed', { model, purpose, durationMs: Date.now() - started, finishReason: response.candidates?.[0]?.finishReason ?? null,
      inputUsage: usage.promptTokenCount, outputUsage: usage.candidatesTokenCount, thoughtUsage: usage.thoughtsTokenCount });
    return response;
  }

  return {
    /**
     * 第一次開啟視窗：依目錄的類型摘要與部門名錄判斷需求類型與部門（一次結構化輸出，不使用工具）。
     * @param {object} request 參數。
     * @param {string} request.instructions 系統指示。
     * @param {object} request.context 交給模型的資料。
     * @param {{typeIds: string[], departmentIds: string[]}} request.lists 允許的 id。
     * @returns {Promise<object>} buildClassification 的結果，另含 toolsUsed（空陣列）與 model。
     * @throws {HttpError} 帶 draftReason 的錯誤。
     */
    classify({ instructions, context, lists }) {
      return guarded('ticket.draft.classify', /** 執行分類。@param {AbortSignal} signal 取消訊號。@param {Function} track 階段記錄。@returns {Promise<object>} 結果。 */ async (signal, track) => {
        const ai = getAI();
        track('gemini.generate');
        const response = await generate(ai, { contents: JSON.stringify(context),
          config: { systemInstruction: instructions, responseMimeType: 'application/json', responseSchema: classifySchema(lists), temperature: 0.2, maxOutputTokens: GEMINI_OUTPUT_LIMITS.classify } }, signal, 'ticket.draft.classify');
        track('response.validate');
        return { ...buildClassification(parseJson(response.text), lists), toolsUsed: [] };
      });
    },
    /**
     * 之後各回合：工具階段（模型可呼叫 tools，伺服器以 runTool 處理並把結果當資料回給模型，整回合最多處理 maxToolCalls 次呼叫；
     * runTool 拒絕（不在允許清單）或參數錯誤而回 { error } 的呼叫同樣計入次數並列入 toolsUsed，超過上限的呼叫只回錯誤、不列入）
     * → 整理階段（附上工具結果，一次結構化輸出）。沒有可用工具時略過工具階段。
     * @param {object} request 參數。
     * @param {string} request.instructions 系統指示。
     * @param {object} request.context 交給模型的資料。
     * @param {{typeIds: string[], departmentIds: string[], keys: string[]}} request.lists 允許的 id 與欄位 key。
     * @param {object[]} request.tools 允許的目錄工具。
     * @param {(id: string, args: unknown) => Promise<object>} request.runTool 伺服器端工具執行函式，回傳 { result } 或 { error }。
     * @returns {Promise<object>} buildFill 的結果，另含 toolsUsed（依呼叫順序列出交給 runTool 處理的工具 id，含回 { error } 的呼叫）與 model。
     * @throws {HttpError} 帶 draftReason 的錯誤；runTool 拋出的非 AI 錯誤（例如 503）原樣拋出。
     */
    fill({ instructions, context, lists, tools, runTool }) {
      return guarded('ticket.draft.fill', /** 執行填寫。@param {AbortSignal} signal 取消訊號。@param {Function} track 階段記錄。@returns {Promise<object>} 結果。 */ async (signal, track) => {
        const ai = getAI();
        const toolsUsed = [];
        const results = [];
        if (tools.length) {
          const contents = [{ role: 'user', parts: [{ text: JSON.stringify(context) }] }];
          const declarations = tools.map(toolDeclaration);
          while (toolsUsed.length < maxToolCalls) {
            track('gemini.tools');
            const response = await generate(ai, { contents, config: { systemInstruction: `${instructions}\n現在是工具階段：只在需要資料時呼叫工具；不需要時直接回覆 OK。`,
              tools: [{ functionDeclarations: declarations }], temperature: 0.2, maxOutputTokens: GEMINI_OUTPUT_LIMITS.tools } }, signal, 'ticket.draft.tools');
            const calls = response.functionCalls ?? [];
            if (!calls.length) break;
            const answers = [];
            for (const call of calls) {
              let output;
              if (toolsUsed.length >= maxToolCalls) {
                output = { error: `本回合最多呼叫 ${maxToolCalls} 次工具` };
              } else {
                track('tool.execute');
                output = await runTool(call.name, call.args);
                signal.throwIfAborted();
                toolsUsed.push(call.name);
                results.push({ tool: call.name, args: call.args ?? {}, ...output });
              }
              answers.push({ functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: output.error ? { error: output.error } : { output: output.result } } });
            }
            contents.push(response.candidates?.[0]?.content ?? { role: 'model', parts: calls.map(/** 轉回呼叫片段。@param {object} call 呼叫。@returns {object} 片段。 */ (call) => ({ functionCall: call })) });
            contents.push({ role: 'user', parts: answers });
          }
        }
        track('gemini.generate');
        const response = await generate(ai, { contents: JSON.stringify({ ...context, tool_results: results }),
          config: { systemInstruction: instructions, responseMimeType: 'application/json', responseSchema: fillSchema(lists), temperature: 0.2, maxOutputTokens: GEMINI_OUTPUT_LIMITS.fill } }, signal, 'ticket.draft.fill');
        track('response.validate');
        return { ...buildFill(parseJson(response.text), lists), toolsUsed };
      });
    },
  };
}

