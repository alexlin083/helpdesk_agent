// 依 AI_PROVIDER 選擇 AI 供應商的實作；服務的其他程式只透過這裡取得「自動生成」助手與需求單部門判斷器。
// 主要供應商預設 Gemini；另一家（預設 Claude）有設定金鑰時作為備援：主要供應商這一回合不論因為什麼失敗（限流、過載、上游錯誤、
// 回應格式異常、逾時），同一個請求都改由備援處理，使用者不會看到主要供應商的錯誤；只有備援也失敗時才回錯誤。
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { createGeminiAssistant, DRAFT_TIMEOUT_MS } from '../requestTypes/aiAssistant.js';
import { createClaudeAssistant } from '../requestTypes/claudeAssistant.js';
import { createTicketJudge, JUDGE_TIMEOUT_MS } from './ticketJudge.js';
import { createClaudeTicketJudge } from './ticketJudgeClaude.js';

// 有備援時兩段的期限：兩段加起來仍在前端的等待上限內（自動生成 10 + 15 = 25 秒 < 30 秒；送單 6 + 12 = 18 秒 < 20 秒）。
// 主要供應商較慢時（超過期限）也會交給備援，使用者不必空等。
export const PRIMARY_DRAFT_TIMEOUT_MS = 10000;
export const FALLBACK_DRAFT_TIMEOUT_MS = 15000;
export const PRIMARY_JUDGE_TIMEOUT_MS = 6000;
export const FALLBACK_JUDGE_TIMEOUT_MS = 12000;
// 改用備援後，這段時間內的請求直接交給備援，不再先試主要供應商。
export const FALLBACK_COOLDOWN_MS = 60000;
// 自動生成視為「AI 這回合失敗」、要改用備援的原因；AI_UNAVAILABLE（沒有金鑰）由 providerOrder 事先排除，非 AI 的錯誤（例如資料庫無法讀取）不切換。
export const DRAFT_FALLBACK_REASONS = Object.freeze(['RATE_LIMIT_EXCEEDED', 'AI_UPSTREAM_ERROR', 'AI_INVALID_RESPONSE', 'AI_TIMEOUT']);

/**
 * 依設定決定要使用的供應商順序：先主要供應商（AI_PROVIDER），再加上有金鑰的備援供應商。
 * 主要供應商沒有金鑰而備援有金鑰時，只使用備援（否則 AI 完全無法使用）；兩家都沒有金鑰時只列主要供應商，讓錯誤訊息指出它的金鑰。
 * @param {{aiProvider: string, aiApiKey: string, aiFallbackProvider: string|null}} config 設定。
 * @returns {string[]} 供應商名稱，一到兩個。
 */
export function providerOrder(config) {
  if (!config.aiFallbackProvider) return [config.aiProvider];
  return config.aiApiKey ? [config.aiProvider, config.aiFallbackProvider] : [config.aiFallbackProvider];
}

/**
 * 建立「主要 → 備援」的切換器：主要供應商失敗且 shouldFallback 判定為 AI 失敗時，記錄 ai.fallback.used（含原因與上游狀態，不含內容）
 * 並改呼叫備援，之後 FALLBACK_COOLDOWN_MS 內的呼叫直接交給備援。不是 AI 的錯誤原樣拋出；備援的錯誤也原樣拋出。
 * 狀態只存在目前程序的記憶體，重啟後從主要供應商開始。
 * @param {object} options 設定。
 * @param {string[]} options.names 主要與備援供應商名稱（寫入日誌）。
 * @param {(error: unknown) => boolean} options.shouldFallback 判斷錯誤是否要改用備援。
 * @param {() => number} [options.clock=Date.now] 時間來源。
 * @returns {(purpose: string, primary: () => Promise<object>, secondary: () => Promise<object>) => Promise<object>} 依規則執行其中一個呼叫的函式。
 */
export function createFallbackSwitch({ names, shouldFallback, clock = Date.now }) {
  let coolUntil = 0;
  return async function run(purpose, primary, secondary) {
    if (clock() < coolUntil) return secondary();
    try {
      return await primary();
    } catch (error) {
      if (!shouldFallback(error)) throw error;
      coolUntil = clock() + FALLBACK_COOLDOWN_MS;
      logger('warn', 'ai.fallback.used', { from: names[0], to: names[1], purpose, reason: error?.draftReason ?? error?.code ?? null,
        upstreamStatus: error?.upstreamStatus ?? error?.status ?? null, cooldownMs: FALLBACK_COOLDOWN_MS });
      return secondary();
    }
  };
}

/**
 * 依供應商名稱建立自動生成助手。
 * @param {string} name anthropic 或 gemini。
 * @param {number} timeoutMs 整回合期限毫秒數。
 * @returns {{classify: Function, fill: Function}} 助手。
 */
function assistantFor(name, timeoutMs) {
  return name === 'anthropic' ? createClaudeAssistant({ timeoutMs }) : createGeminiAssistant({ timeoutMs });
}

/**
 * 依供應商名稱建立需求單部門判斷器。
 * @param {string} name anthropic 或 gemini。
 * @param {number} timeoutMs 單次呼叫逾時毫秒數。
 * @returns {Function} 判斷函式。
 */
function judgeFor(name, timeoutMs) {
  return name === 'anthropic' ? createClaudeTicketJudge({ timeoutMs }) : createTicketJudge({ timeoutMs });
}

/**
 * 依設定建立「自動生成」AI 助手：只有一個可用供應商時直接使用它（期限 20 秒）；有備援時，主要供應商期限 10 秒、備援 15 秒，
 * classify 與 fill 在主要供應商以 DRAFT_FALLBACK_REASONS 任一原因失敗時改用備援。
 * 自動生成的對話不在伺服器保存，每回合都帶完整狀態，因此同一段對話中途換供應商不影響後續回合。不會在建立時呼叫外部服務。
 * @param {object} [config=env] 設定（aiProvider、aiApiKey、aiFallbackProvider）。
 * @param {object} [options={}] 測試用的替換。
 * @param {(name: string, timeoutMs: number) => object} [options.build=assistantFor] 依名稱與期限建立助手。
 * @param {() => number} [options.clock=Date.now] 時間來源。
 * @returns {{classify: Function, fill: Function}} 助手。
 */
export function createDraftAssistant(config = env, { build = assistantFor, clock = Date.now } = {}) {
  const names = providerOrder(config);
  if (names.length === 1) return build(names[0], DRAFT_TIMEOUT_MS);
  const primary = build(names[0], PRIMARY_DRAFT_TIMEOUT_MS);
  const secondary = build(names[1], FALLBACK_DRAFT_TIMEOUT_MS);
  const run = createFallbackSwitch({ names, clock, shouldFallback: /** 是否為 AI 失敗。@param {object} error 錯誤。@returns {boolean} 是時 true。 */ (error) => DRAFT_FALLBACK_REASONS.includes(error?.draftReason) });
  return {
    /** 分類（見 createGeminiAssistant／createClaudeAssistant）。@param {object} request 參數。@returns {Promise<object>} 結果。 */
    classify: (request) => run('ticket.draft.classify', () => primary.classify(request), () => secondary.classify(request)),
    /** 填寫（見 createGeminiAssistant／createClaudeAssistant）。@param {object} request 參數。@returns {Promise<object>} 結果。 */
    fill: (request) => run('ticket.draft.fill', () => primary.fill(request), () => secondary.fill(request)),
  };
}

/**
 * 依設定建立需求單部門判斷器（POST /api/tickets 沒有帶 form、department_id 與 handler_id 時使用）：只有一個可用供應商時直接使用（期限 15 秒）；
 * 有備援時主要供應商期限 6 秒、備援 12 秒，主要供應商以 429 或 500（限流、過載、上游錯誤、格式異常、逾時）失敗時改用備援。
 * @param {object} [config=env] 設定（aiProvider、aiApiKey、aiFallbackProvider）。
 * @param {object} [options={}] 測試用的替換。
 * @param {(name: string, timeoutMs: number) => Function} [options.build=judgeFor] 依名稱與期限建立判斷器。
 * @param {() => number} [options.clock=Date.now] 時間來源。
 * @returns {(ticket: {subject: string, content: string}) => Promise<object>} 判斷函式。
 */
export function createJudge(config = env, { build = judgeFor, clock = Date.now } = {}) {
  const names = providerOrder(config);
  if (names.length === 1) return build(names[0], JUDGE_TIMEOUT_MS);
  const primary = build(names[0], PRIMARY_JUDGE_TIMEOUT_MS);
  const secondary = build(names[1], FALLBACK_JUDGE_TIMEOUT_MS);
  const run = createFallbackSwitch({ names, clock, shouldFallback: /** 是否為 AI 失敗。@param {object} error 錯誤。@returns {boolean} 是時 true。 */ (error) => error?.status === 429 || error?.status === 500 });
  return /** 判斷部門。@param {{subject: string, content: string}} ticket 需求單。@returns {Promise<object>} 分流結果。 */ (ticket) => run('ticket.judge', () => primary(ticket), () => secondary(ticket));
}

export const draftAssistant = createDraftAssistant();
export const judgeTicket = createJudge();
