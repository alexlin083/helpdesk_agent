import { API_BASE_URL } from '../config.js';
import { authService, isKnownUserID } from './authService.js';

const INTENTS = ['IT_SUPPORT', 'HR_POLICY', 'HARDWARE_FACILITY', 'UNKNOWN'];
const LEVELS = ['P1_URGENT', 'P2_HIGH', 'P3_NORMAL'];

/** API 服務錯誤，保留狀態碼與錯誤代碼供呼叫端顯示及判斷。 */
export class AgentServiceError extends Error {
  /**
   * 建立可供介面安全顯示的服務錯誤，不包含請求或金鑰資訊。
   * @param {string} message 繁體中文錯誤提示。
   * @param {number} [status=0] HTTP 狀態碼；0 表示本機驗證或網路層錯誤。
   * @param {string} [code='CLIENT_ERROR'] API 或前端錯誤代碼。
   */
  constructor(message, status = 0, code = 'CLIENT_ERROR') {
    super(message);
    this.name = 'AgentServiceError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 檢查欄位是否為非空白字串，供回應結構驗證重用。
 * @param {unknown} value 待驗證欄位。
 * @returns {boolean} 是否包含可顯示的文字。
 */
function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 依 API 合約驗證回應與分流一致性，避免不完整資料被當作有效決策顯示。
 * @param {object} data 後端解析後的 JSON。
 * @returns {object} 驗證通過的完整原始回應。
 * @throws {AgentServiceError} 欄位、數值範圍或分流與工單關係不符合規格。
 */
export function validateAgentResponse(data) {
  let valid = data && INTENTS.includes(data.intent) && isText(data.reply_text)
    && Number.isInteger(data.confidence_score) && data.confidence_score >= 0 && data.confidence_score <= 100
    && Array.isArray(data.retrieved_sources) && data.retrieved_sources.length <= 3;
  if (valid) {
    for (const source of data.retrieved_sources) {
      valid = valid && source && isText(source.doc_name) && Number.isFinite(source.relevance)
        && source.relevance >= 0 && source.relevance <= 1;
    }
    if (data.action_route === 'AUTO_REPLY') {
      valid = valid && data.confidence_score >= 75 && data.ticket_payload === null;
    } else if (data.action_route === 'ESCALATE_TICKET') {
      const ticket = data.ticket_payload;
      valid = valid && data.confidence_score < 75 && ticket && isText(ticket.ticket_id)
        && LEVELS.includes(ticket.level) && isText(ticket.department) && isText(ticket.action_required);
    } else {
      valid = false;
    }
  }
  if (!valid) throw new AgentServiceError('後端回應格式不符合 API 規格，請稍後再試。', 0, 'INVALID_RESPONSE');
  return data;
}

/**
 * 將單次問題送至後端，後端負責 Gemini 金鑰、檢索與推理；前端不直接呼叫 Gemini。
 * 先去除首尾空白並驗證 1～500 個 Unicode code points，最長等待 100 秒。
 * 首次請求可能依序進行文件向量、問題向量及推理；不自動重試，避免重複使用額度。
 * @param {string} message 使用者輸入的問題，不包含歷史對話。
 * @param {string} userID 登入帳號固定識別碼，須與目前憑證一致，後端會再次驗證。
 * @returns {Promise<object>} 通過合約驗證的 Agent 回應。
 * @throws {AgentServiceError} 輸入無效、HTTP 錯誤、逾時、連線失敗或回應格式異常。
 */
export async function sendChatMessage(message, userID) {
  const token = authService.getAccessToken();
  if (!isKnownUserID(userID) || !token || authService.getCurrentUser()?.userID !== userID) throw new AgentServiceError('請先登入後再送出問題。', 401, 'LOGIN_REQUIRED');
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text || Array.from(text).length > 500) {
    throw new AgentServiceError('請輸入 1～500 字元的問題。', 400, 'INVALID_PAYLOAD');
  }
  try {
    const response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: text, userID }),
      signal: AbortSignal.timeout(100000),
    });
    let data;
    try { data = await response.json(); } catch {
      throw new AgentServiceError('後端未回傳有效 JSON，請確認 API 網址與服務狀態。', response.status, 'INVALID_RESPONSE');
    }
    if (!response.ok) {
      const fallback = response.status === 429 ? '系統繁忙中，請稍後 10 秒再試。' : '後端服務發生錯誤，請稍後再試。';
      const failure = new AgentServiceError(isText(data?.error?.message) ? data.error.message : fallback,
        response.status, data?.error?.code || 'SERVER_ERROR');
      const retry = Number(data?.error?.retry_after ?? response.headers.get('Retry-After'));
      failure.retryAfter = Number.isFinite(retry) && retry > 0 ? retry : 0;
      throw failure;
    }
    return validateAgentResponse(data);
  } catch (error) {
    if (error instanceof AgentServiceError) throw error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new AgentServiceError('等待回覆逾時，請稍後再試。', 0, 'TIMEOUT');
    }
    throw new AgentServiceError('無法連線至後端，請確認服務已啟動、API 網址與 CORS 設定。', 0, 'NETWORK_ERROR');
  }
}

/**
 * 以登入憑證查詢剩餘額度；不呼叫 Gemini，不扣額。後端 401 時由畫面導回登入。
 * @returns {Promise<object>} 剩餘用量、冷卻及重置時間。
 * @throws {AgentServiceError} 未登入、連線或服務異常。
 */
export async function getUsage() {
  const token = authService.getAccessToken();
  if (!token) throw new AgentServiceError('請先登入', 401, 'UNAUTHORIZED');
  let response;
  let data;
  try {
    response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/api/agent/usage`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
    });
    data = await response.json();
  } catch { throw new AgentServiceError('暫時無法讀取用量，請稍後再試。'); }
  if (!response.ok) throw new AgentServiceError(data?.error?.message || '無法讀取用量', response.status, data?.error?.code);
  if (!Number.isInteger(data.userDailyLimit) || !Number.isInteger(data.globalDailyLimit)
    || !Number.isInteger(data.userRemaining) || data.userRemaining < 0 || data.userRemaining > data.userDailyLimit
    || !Number.isInteger(data.globalRemaining) || data.globalRemaining < 0 || data.globalRemaining > data.globalDailyLimit
    || !Number.isInteger(data.cooldownSeconds) || data.cooldownSeconds < 0 || !Number.isFinite(Date.parse(data.resetAt))) {
    throw new AgentServiceError('用量回應格式異常', 0, 'INVALID_RESPONSE');
  }
  return data;
}
