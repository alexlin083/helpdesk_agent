import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { fallbackParams, incompleteReason, textOf } from '../ai/claudeShared.js';
import { buildClassification, buildFill, createTurnGuard, DRAFT_TIMEOUT_MS, invalidOutput, MAX_TOOL_CALLS, parseJson } from './aiAssistant.js';

const CLASSIFY_MAX_TOKENS = 4096;
const TOOLS_MAX_TOKENS = 2048;
const FILL_MAX_TOKENS = 4096;

/**
 * 可為 null 的字串 schema；有允許值時限定為其中之一（Claude 結構化輸出以 anyOf 表示可為 null）。
 * @param {string[]} values 允許值，空陣列表示不限定。
 * @returns {object} JSON Schema。
 */
function nullableString(values) {
  return { anyOf: [{ type: 'string', ...(values.length ? { enum: values } : {}) }, { type: 'null' }] };
}

/**
 * 第一次開啟視窗（分類）的 Claude 結構化輸出 schema：與 Gemini 版相同的欄位（需求類型、處理部門、信心分數、判斷結果與回覆）。
 * Claude 結構化輸出不支援數值範圍，因此 confidence_score 只限定為整數，0～100 由 buildClassification 驗證；所有物件都設 additionalProperties: false。
 * @param {{typeIds: string[], departmentIds: string[]}} lists 允許的 id。
 * @returns {object} JSON Schema。
 */
export function claudeClassifySchema({ typeIds, departmentIds }) {
  return {
    type: 'object',
    properties: {
      intent: { type: 'string' },
      type_id: nullableString(typeIds),
      department_id: nullableString(departmentIds),
      confidence_score: { type: 'integer' },
      reply: { type: 'string' },
    },
    required: ['intent', 'type_id', 'department_id', 'confidence_score', 'reply'],
    additionalProperties: false,
  };
}

/**
 * 之後各回合（填寫）的 Claude 結構化輸出 schema：另含欄位更新與指定處理人；updates.key 限定為需求類型定義的欄位 key。
 * @param {{typeIds: string[], departmentIds: string[], keys: string[]}} lists 允許的 id 與欄位 key。
 * @returns {object} JSON Schema。
 */
export function claudeFillSchema({ typeIds, departmentIds, keys }) {
  return {
    type: 'object',
    properties: {
      intent: { type: 'string' },
      type_id: nullableString(typeIds),
      department_id: nullableString(departmentIds),
      confidence_score: { type: 'integer' },
      updates: {
        type: 'array',
        items: {
          type: 'object',
          properties: { key: { type: 'string', ...(keys.length ? { enum: keys } : {}) }, value: { type: 'string' } },
          required: ['key', 'value'],
          additionalProperties: false,
        },
      },
      handler_id: nullableString([]),
      reply: { type: 'string' },
    },
    required: ['intent', 'type_id', 'department_id', 'confidence_score', 'updates', 'handler_id', 'reply'],
    additionalProperties: false,
  };
}

/**
 * 把目錄工具轉成 Claude 的工具定義（名稱為工具 id，參數依目錄宣告；型別名稱與 JSON Schema 相同，可直接使用）。
 * @param {object} tool 目錄工具（id、description、returns、params）。
 * @returns {{name: string, description: string, input_schema: object}} Claude 工具定義。
 */
export function claudeTool(tool) {
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(tool.params)) {
    properties[name] = { type: spec.type, description: spec.description };
    if (spec.required) required.push(name);
  }
  return { name: tool.id, description: `${tool.description} 回傳：${tool.returns}`, input_schema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false } };
}

/**
 * 依「自動生成」的錯誤合約檢查停止原因（判斷依據見 ai/claudeShared.js 的 incompleteReason）：refusal（安全分類器拒絕，連 fallback 也拒絕）轉成 AI_UPSTREAM_ERROR；
 * max_tokens（輸出被截斷）轉成格式異常
 * @param {{stop_reason: string}} response Claude 回應。
 * @returns {void}
 * @throws {HttpError} 500，draftReason AI_UPSTREAM_ERROR 或 AI_INVALID_RESPONSE。
 */
function assertCompleted(response) {
  const reason = incompleteReason(response);
  if (reason === 'refusal') throw Object.assign(new HttpError(500, 'SERVER_ERROR', 'AI 助手這次無法處理這個需求；仍可手動填寫欄位'), { draftReason: 'AI_UPSTREAM_ERROR' });
  if (reason === 'max_tokens') throw invalidOutput();
}

let client;
/**
 * 延遲建立並重用 Anthropic SDK client，不在啟動時呼叫外部服務；SDK 對 429、5xx 與連線錯誤最多自動重試 1 次。
 * @returns {Anthropic} 已設定後端金鑰的 client。
 * @throws {HttpError} 未設定 ANTHROPIC_API_KEY（draftReason AI_UNAVAILABLE）。
 */
function getClient() {
  if (!env.anthropicApiKey) throw Object.assign(new HttpError(500, 'SERVER_ERROR', '尚未設定 Anthropic API 金鑰'), { draftReason: 'AI_UNAVAILABLE' });
  client ??= new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 1 });
  return client;
}

/**
 * 建立「需求單自動生成」AI 助手（Claude），與 Gemini 版有相同的介面與流程：
 * - classify：第一次開啟視窗，一次結構化輸出（output_config.format）判斷需求類型與部門；
 * - fill：之後各回合，先讓模型在允許的工具中呼叫需要的工具（伺服器端執行、整回合最多 3 次），再以一次結構化輸出整理欄位更新與回覆。
 * 使用適應式思考與 effort（預設 low，分類與擷取類工作的建議起點）；不送 temperature（新版 API 會拒絕）與強制 tool_choice（Sonnet 5.5 會拒絕）。
 * 支援的模型另加伺服器端 fallback。整回合預設在 60 秒期限內完成；有備援時由供應商切換器傳入較短期限；欄位是否有效、部門規則與數字一律由後端另行驗證與計算。
 * @param {object} [options={}] 設定。
 * @param {Function} [options.getAI=getClient] SDK client 取得函式（需提供 beta.messages.create）。
 * @param {string} [options.model=env.anthropicModel] 模型名稱。
 * @param {string} [options.effort='low'] output_config.effort。
 * @param {number} [options.timeoutMs=DRAFT_TIMEOUT_MS] 整回合期限毫秒數。
 * @param {number} [options.maxToolCalls=MAX_TOOL_CALLS] 每回合最多執行的工具次數。
 * @returns {{classify: Function, fill: Function}} 助手。
 */
export function createClaudeAssistant({ getAI = getClient, model = env.anthropicModel, effort = 'low', timeoutMs = DRAFT_TIMEOUT_MS, maxToolCalls = MAX_TOOL_CALLS } = {}) {
  const guarded = createTurnGuard({ model, timeoutMs });

  /**
   * 呼叫一次 Claude Messages API 並記錄耗時與 token 用量（不記錄內容），再檢查停止原因。
   * @param {object} ai SDK client。
   * @param {object} params 請求參數（不含 model 與 fallback 參數）。
   * @param {AbortSignal} signal 逾時取消訊號。
   * @param {string} purpose 日誌用途。
   * @returns {Promise<object>} Claude 回應。
   * @throws {HttpError} refusal 或 max_tokens；SDK 錯誤原樣拋出（由回合守衛分類）。
   */
  async function create(ai, params, signal, purpose) {
    const started = Date.now();
    logger('info', 'claude.generate.started', { model, purpose });
    const response = await ai.beta.messages.create({ model, ...params, ...fallbackParams(model) }, { signal, timeout: timeoutMs });
    signal.throwIfAborted();
    logger('info', 'claude.generate.completed', { model, purpose, durationMs: Date.now() - started, stopReason: response.stop_reason,
      inputUsage: response.usage?.input_tokens, outputUsage: response.usage?.output_tokens });
    assertCompleted(response);
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
        track('claude.generate');
        const response = await create(ai, { max_tokens: CLASSIFY_MAX_TOKENS, system: instructions,
          output_config: { effort, format: { type: 'json_schema', schema: claudeClassifySchema(lists) } },
          messages: [{ role: 'user', content: JSON.stringify(context) }] }, signal, 'ticket.draft.classify');
        track('response.validate');
        return { ...buildClassification(parseJson(textOf(response)), lists), toolsUsed: [] };
      });
    },
    /**
     * 之後各回合：工具階段（模型以 tool_use 呼叫 tools，伺服器以 runTool 處理並以 tool_result 回給模型，整回合最多處理 maxToolCalls 次呼叫；
     * runTool 回 { error } 的呼叫同樣計入次數並列入 toolsUsed、以 is_error 回給模型，超過上限的呼叫只回錯誤、不列入；助手回應原樣接回對話，
     * 讓思考區塊保持完整）→ 整理階段（附上工具結果，一次結構化輸出）。沒有可用工具時略過工具階段。
     * @param {object} request 參數。
     * @param {string} request.instructions 系統指示。
     * @param {object} request.context 交給模型的資料。
     * @param {{typeIds: string[], departmentIds: string[], keys: string[]}} request.lists 允許的 id 與欄位 key。
     * @param {object[]} request.tools 允許的目錄工具。
     * @param {(id: string, args: unknown) => Promise<object>} request.runTool 伺服器端工具執行函式，回傳 { result } 或 { error }。
     * @returns {Promise<object>} buildFill 的結果，另含 toolsUsed（依呼叫順序列出交給 runTool 處理的工具 id）與 model。
     * @throws {HttpError} 帶 draftReason 的錯誤；runTool 拋出的非 AI 錯誤（例如 503）原樣拋出。
     */
    fill({ instructions, context, lists, tools, runTool }) {
      return guarded('ticket.draft.fill', /** 執行填寫。@param {AbortSignal} signal 取消訊號。@param {Function} track 階段記錄。@returns {Promise<object>} 結果。 */ async (signal, track) => {
        const ai = getAI();
        const toolsUsed = [];
        const results = [];
        if (tools.length) {
          const messages = [{ role: 'user', content: JSON.stringify(context) }];
          const definitions = tools.map(claudeTool);
          while (toolsUsed.length < maxToolCalls) {
            track('claude.tools');
            const response = await create(ai, { max_tokens: TOOLS_MAX_TOKENS, system: `${instructions}\n現在是工具階段：只在需要資料時呼叫工具；不需要時直接回覆 OK。`,
              tools: definitions, output_config: { effort }, messages }, signal, 'ticket.draft.tools');
            const calls = response.content.filter(/** 是否為工具呼叫。@param {{type: string}} block 區塊。@returns {boolean} 工具呼叫時 true。 */ (block) => block.type === 'tool_use');
            if (!calls.length) break;
            messages.push({ role: 'assistant', content: response.content });
            const answers = [];
            for (const call of calls) {
              let output;
              if (toolsUsed.length >= maxToolCalls) {
                output = { error: `本回合最多呼叫 ${maxToolCalls} 次工具` };
              } else {
                track('tool.execute');
                output = await runTool(call.name, call.input);
                signal.throwIfAborted();
                toolsUsed.push(call.name);
                results.push({ tool: call.name, args: call.input ?? {}, ...output });
              }
              answers.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(output.error ? { error: output.error } : { output: output.result }),
                ...(output.error ? { is_error: true } : {}) });
            }
            messages.push({ role: 'user', content: answers });
          }
        }
        track('claude.generate');
        const response = await create(ai, { max_tokens: FILL_MAX_TOKENS, system: instructions,
          output_config: { effort, format: { type: 'json_schema', schema: claudeFillSchema(lists) } },
          messages: [{ role: 'user', content: JSON.stringify({ ...context, tool_results: results }) }] }, signal, 'ticket.draft.fill');
        track('response.validate');
        return { ...buildFill(parseJson(textOf(response)), lists), toolsUsed };
      });
    },
  };
}
