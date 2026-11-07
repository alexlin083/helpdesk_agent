// Claude 呼叫的共用工具：「自動生成」助手（requestTypes/claudeAssistant.js）與 AI 判斷部門（ticketJudgeClaude.js）都使用，
// 只處理 Claude API 本身的細節，不含任何一方的錯誤代碼

// 有伺服器端 fallback（fallbacks: "default"）的模型；其他模型不送這個參數
const SERVER_FALLBACK_MODELS = Object.freeze(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// 代表輸出沒有正常完成的停止原因：refusal 為安全分類器拒絕（連伺服器端 fallback 也拒絕），max_tokens 為輸出被截斷
const INCOMPLETE_STOP_REASONS = Object.freeze(['refusal', 'max_tokens']);

/**
 * 依模型決定是否加上伺服器端 fallback：支援的模型在安全分類器拒絕時，由 API 依拒絕類別改用其他模型重跑同一個請求
 * @param {string} model 模型名稱
 * @returns {object} 要合併進請求的參數（betas 與 fallbacks），不支援時為空物件
 */
export function fallbackParams(model) {
  return SERVER_FALLBACK_MODELS.includes(model) ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' } : {};
}

/**
 * 取出回應中的文字（結構化輸出的 JSON 在 text 區塊；thinking、fallback 等其他區塊略過）
 * @param {{content: Array<{type: string, text?: string}>}} response Claude 回應
 * @returns {string} 串接後的文字
 */
export function textOf(response) {
  return response.content.filter(/** 是否為文字區塊 @param {{type: string}} block 區塊 @returns {boolean} 文字時 true */ (block) => block.type === 'text')
    .map(/** 取文字 @param {{text: string}} block 區塊 @returns {string} 文字 */ (block) => block.text).join('');
}

/**
 * 判斷回應是否沒有正常完成；呼叫端依自己的錯誤合約決定怎麼回報
 * @param {{stop_reason: string}} response Claude 回應
 * @returns {'refusal'|'max_tokens'|null} 沒有正常完成的原因；正常完成時為 null
 */
export function incompleteReason(response) {
  return INCOMPLETE_STOP_REASONS.includes(response.stop_reason) ? response.stop_reason : null;
}
