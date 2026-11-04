import { logger } from '../utils/logger.js';

/**
 * 可直接回給前端的應用程式錯誤；status、code 與 message 會原樣輸出成統一錯誤 JSON，message 必須是固定的繁體中文說明，不可夾帶使用者輸入或供應商錯誤。
 */
export class HttpError extends Error {
  /**
   * 建立帶 HTTP 狀態與錯誤代碼的例外。
   * @param {number} status HTTP 狀態碼，例如 400、401、503。
   * @param {string} code 規格書定義的錯誤代碼，例如 INVALID_PAYLOAD。
   * @param {string} message 顯示給使用者的固定說明文字。
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * 所有路由都沒有符合時，交給 errorHandler 回 404 NOT_FOUND。
 * @param {import('express').Request} req 請求，不讀取內容。
 * @param {import('express').Response} res 回應，不在此寫入。
 * @param {import('express').NextFunction} next 傳遞 404 HttpError。
 * @returns {void}
 */
export function notFound(req, res, next) {
  next(new HttpError(404, 'NOT_FOUND', '找不到此 API'));
}

// 非 HttpError 的 4xx 用戶端錯誤（body-parser、Express 路由解析等）對應的固定代碼與訊息；不輸出原始錯誤文字，避免回顯請求內容。
const CLIENT_ERRORS = Object.freeze({
  413: { code: 'PAYLOAD_TOO_LARGE', message: '請求內容超過大小限制' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '不支援的請求內容格式或編碼，請使用 UTF-8 JSON' },
});
const CLIENT_ERROR_DEFAULT = Object.freeze({ code: 'INVALID_PAYLOAD', message: '請求內容或網址格式無效' });

/**
 * 讀取非 HttpError 例外上的 HTTP 狀態（status 優先，其次 statusCode），只接受 400～499 的整數。
 * @param {unknown} error 捕捉的例外。
 * @returns {number|undefined} 用戶端錯誤狀態碼；不是 4xx 或不存在時為 undefined。
 */
function clientStatus(error) {
  const status = error?.status ?? error?.statusCode;
  return Number.isInteger(status) && status >= 400 && status <= 499 ? status : undefined;
}

/**
 * 將例外轉成統一 JSON，限流提供實際重試時間；不輸出憑證與供應商錯誤。
 * 對應順序：HttpError 原樣輸出 → JSON 解析失敗 400 INVALID_PAYLOAD → 超過大小 413 PAYLOAD_TOO_LARGE →
 * 其他帶 4xx status／statusCode 的用戶端錯誤（如不支援的 charset 415 UNSUPPORTED_MEDIA_TYPE、無法解碼的網址 400 INVALID_PAYLOAD）保留狀態碼並使用固定訊息、以 warn 記錄 →
 * 其餘才視為伺服器錯誤回 500 SERVER_ERROR 並以 error 記錄。
 * @param {Error} error 捕捉的例外。
 * @param {import('express').Request} req 請求。
 * @param {import('express').Response} res 回應。
 * @param {import('express').NextFunction} next 標頭已傳送時交給 Express。
 * @returns {void}
 */
export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  let status = 500;
  let code = 'SERVER_ERROR';
  let message = '伺服器發生錯誤';

  if (error instanceof HttpError) {
    ({ status, code, message } = error);
  } else if (error.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_PAYLOAD';
    message = '請提供有效的 JSON';
  } else if (error.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = '請求內容超過大小限制';
  } else if (clientStatus(error)) {
    status = clientStatus(error);
    ({ code, message } = CLIENT_ERRORS[status] ?? CLIENT_ERROR_DEFAULT);
  } else {
    console.error('未預期的伺服器錯誤');
  }

  const retryAfter = error.retryAfter || (status === 429 ? 10 : undefined);
  logger(status >= 500 ? 'error' : 'warn', 'http.request.rejected', { status, code, retryAfter });
  if (retryAfter) res.set('Retry-After', String(retryAfter));
  res.status(status).json({ error: { code, message, ...(retryAfter ? { retry_after: retryAfter } : {}) } });
}
