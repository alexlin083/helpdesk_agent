import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { departmentService } from '../departmentService.js';
import { fallbackParams, incompleteReason, textOf } from './claudeShared.js';
import { createJudgeRunner, invalidJudgeOutput, JUDGE_INSTRUCTION, JUDGE_TIMEOUT_MS } from './ticketJudge.js';
import { logger } from '../../utils/logger.js';

const JUDGE_MAX_TOKENS = 2048;

// 部門判斷的 Claude 結構化輸出 schema：只限定三個欄位；分數範圍與部門是否存在由 buildTicketDecision 驗證。
export const claudeJudgeSchema = Object.freeze({
  type: 'object',
  properties: {
    department_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    confidence_score: { type: 'integer' },
    basis: { type: 'string' },
  },
  required: ['department_id', 'confidence_score', 'basis'],
  additionalProperties: false,
});

let client;
/**
 * 延遲建立並重用 Anthropic SDK client，不在啟動時呼叫外部服務；SDK 對 429、5xx 與連線錯誤最多自動重試 1 次。
 * @returns {Anthropic} 已設定後端金鑰的 client。
 * @throws {HttpError} 未設定 ANTHROPIC_API_KEY 時拒絕執行判斷。
 */
function getClient() {
  if (!env.anthropicApiKey) throw new HttpError(500, 'SERVER_ERROR', '尚未設定 Anthropic API 金鑰');
  client ??= new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 1 });
  return client;
}

/**
 * 建立需求單部門判斷器（Claude）：一次 Claude 呼叫（逾時 15 秒）、結構化輸出（output_config.format）、後端驗證與 75 分分流；
 * 使用適應式思考與 effort（預設 low），支援的模型另加伺服器端 fallback。流程與錯誤對應見 createJudgeRunner；
 * refusal 或輸出被截斷時視為格式異常（500，不洩漏原因）。
 * @param {object} [options={}] 判斷器設定。
 * @param {Function} [options.getAI=getClient] SDK client 取得函式（需提供 beta.messages.create）。
 * @param {object} [options.departments=departmentService] 部門查詢服務。
 * @param {string} [options.model=env.anthropicModel] 模型名稱。
 * @param {string} [options.effort='low'] output_config.effort。
 * @param {number} [options.timeoutMs=JUDGE_TIMEOUT_MS] 單次呼叫逾時毫秒數。
 * @returns {(ticket: {subject: string, content: string}) => Promise<object>} 接受已驗證需求單、回傳分流結果的函式。
 */
export function createClaudeTicketJudge({ getAI = getClient, departments = departmentService, model = env.anthropicModel, effort = 'low', timeoutMs = JUDGE_TIMEOUT_MS } = {}) {
  return createJudgeRunner({ model, timeoutMs, departments, keyName: 'ANTHROPIC_API_KEY', invoke:
    /**
     * 呼叫一次 Claude 並解析 JSON；記錄耗時、停止原因與 token 用量（不含內容）。
     * @param {{signal: AbortSignal, ticket: object, candidates: object[], setStage: Function}} call 呼叫參數。
     * @returns {Promise<unknown>} 解析後的模型輸出。
     * @throws {HttpError} 未設定金鑰、refusal、輸出被截斷或不是 JSON。
     */
    async ({ signal, ticket, candidates, setStage }) => {
      const ai = getAI();
      setStage('claude.generate');
      const started = Date.now();
      logger('info', 'claude.generate.started', { model, departmentCount: candidates.length, purpose: 'ticket.judge' });
      const response = await ai.beta.messages.create({
        model, max_tokens: JUDGE_MAX_TOKENS, system: JUDGE_INSTRUCTION,
        output_config: { effort, format: { type: 'json_schema', schema: claudeJudgeSchema } },
        messages: [{ role: 'user', content: JSON.stringify({ ticket: { subject: ticket.subject, content: ticket.content }, departments: candidates }) }],
        ...fallbackParams(model),
      }, { signal, timeout: timeoutMs });
      signal.throwIfAborted();
      logger('info', 'claude.generate.completed', { model, purpose: 'ticket.judge', durationMs: Date.now() - started, stopReason: response.stop_reason,
        inputUsage: response.usage?.input_tokens, outputUsage: response.usage?.output_tokens });
      setStage('response.parse');
      if (incompleteReason(response)) throw invalidJudgeOutput();
      try { return JSON.parse(textOf(response)); } catch { throw invalidJudgeOutput(); }
    } });
}
