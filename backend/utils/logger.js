import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '../config/env.js';

export const requestContext = new AsyncLocalStorage();
const priorities = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity };

/**
 * 遮蔽欄位中的機密與內容，並遞迴處理陣列及物件；不接受原始 Error 供直接輸出。
 * @param {unknown} value 待輸出的日誌值。
 * @param {string} secret 目前設定的金鑰，用於精確遮蔽。
 * @param {string} [key=''] 欄位名稱，用於識別敏感內容。
 * @returns {unknown} 可安全序列化的日誌值。
 */
function redact(value, secret, key = '') {
  if (/key|token|secret|authorization|password|message|contents|prompt|reply|stack|body|content|text/i.test(key)) return '[REDACTED]';
  if (value instanceof Error) return '[ERROR: use diagnoseError]';
  if (typeof value === 'string') {
    const masked = secret ? value.split(secret).join('[REDACTED]') : value;
    return masked.replace(/AIza[\w-]+/g, '[REDACTED]').slice(0, 500);
  }
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) result.push(redact(item, secret));
    return result;
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [name, item] of Object.entries(value)) result[name] = redact(item, secret, name);
    return result;
  }
  return value;
}

/**
 * 建立 JSON 日誌寫入器，集中處理等級、UTC 時間、請求識別碼與機密遮蔽。
 * @param {object} [options={}] 可注入的測試與執行設定。
 * @param {string} [options.level=env.logLevel] 最低輸出等級。
 * @param {object} [options.sink=console] 提供 log、warn、error 方法的輸出端。
 * @param {string} [options.secret=env.geminiApiKey] 不得出現在日誌中的金鑰。
 * @returns {Function} 接受等級、事件名稱與安全中繼資料的函式。
 */
export function createLogger({ level = env.logLevel, sink = console, secret = env.geminiApiKey } = {}) {
  /**
   * 輸出一筆結構化事件；錯誤寫入 stderr，一般與 debug 日誌寫入 stdout。
   * @param {'debug'|'info'|'warn'|'error'} severity 事件等級。
   * @param {string} event 固定的事件名稱，不應傳入使用者輸入。
   * @param {object} [fields={}] 安全診斷欄位；不可傳入完整請求、模型回覆或供應商錯誤。
   * @returns {void}
   */
  return function log(severity, event, fields = {}) {
    if (!(severity in priorities) || severity === 'silent' || priorities[severity] < priorities[level]) return;
    const record = redact({ ...requestContext.getStore(), ...fields, timestamp: new Date().toISOString(), level: severity, event }, secret);
    const method = severity === 'error' ? 'error' : severity === 'warn' ? 'warn' : 'log';
    sink[method](JSON.stringify(record));
  };
}

/**
 * 將供應商或網路錯誤歸類為可操作的診斷資訊，不輸出可能夾帶金鑰或問題原文的 message。
 * @param {unknown} error 原始 SDK、網路或應用程式錯誤。
 * @returns {object} HTTP 狀態、固定原因、網路代碼及中文排查建議。
 */
export function diagnoseError(error) {
  let details;
  try { details = JSON.parse(error?.message)?.error; } catch { /* 非 JSON 錯誤仍以固定規則分類。 */ }
  const status = Number(error?.status ?? details?.code);
  const text = String(error?.message || '').toLowerCase();
  const cause = error?.cause?.code ?? error?.code;
  const networkCode = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(cause) ? cause : undefined;
  let reason = 'UNKNOWN';
  let hint = '確認失敗階段、模型設定及服務狀態；必要時以供應商控制台進一步確認。';
  if (/api.?key.*(invalid|expired|not valid)|api_key_invalid/.test(text)) {
    reason = 'API_KEY_INVALID'; hint = '檢查後端 GEMINI_API_KEY 是否有效，以及修改後是否已重新啟動。';
  } else if (status === 429 || /resource_exhausted|quota/.test(text)) {
    reason = 'RATE_LIMIT_OR_QUOTA'; hint = '確認 Gemini 專案的配額、速率限制與計費狀態。';
  } else if (status === 404 || /model.*not found/.test(text)) {
    reason = 'MODEL_NOT_FOUND'; hint = '確認此階段使用的模型名稱、API 支援及專案存取權限。';
  } else if (status === 401 || status === 403) {
    reason = 'ACCESS_DENIED'; hint = '確認金鑰權限、API 限制、服務啟用狀態與可用區域。';
  } else if (/timeout|timed out|aborted/.test(text) || ['AbortError', 'TimeoutError'].includes(error?.name)) {
    reason = 'TIMEOUT'; hint = '檢查連線與代理設定；請求已達等待上限。';
  } else if (networkCode || /fetch failed|network/.test(text)) {
    reason = 'NETWORK_ERROR'; hint = '檢查 DNS、網路、防火牆、代理與 TLS 憑證。';
  } else if (status === 400) {
    reason = 'INVALID_ARGUMENT'; hint = '確認模型是否支援此 API、embedding 參數或結構化輸出 schema。';
  } else if (status >= 500) {
    reason = 'UPSTREAM_UNAVAILABLE'; hint = '上游服務暫時異常，稍後重試並確認服務狀態。';
  }
  return { upstreamStatus: status >= 100 && status <= 599 ? status : undefined, networkCode, reason, hint };
}

export const logger = createLogger();
