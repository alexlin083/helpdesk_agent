import { logger } from '../utils/logger.js';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function notFound(req, res, next) {
  next(new HttpError(404, 'NOT_FOUND', '找不到此 API'));
}

/**
 * 將例外轉成統一 JSON，限流提供實際重試時間；不輸出憑證與供應商錯誤。
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
  } else {
    console.error('未預期的伺服器錯誤');
  }

  const retryAfter = error.retryAfter || (status === 429 ? 10 : undefined);
  logger(status >= 500 ? 'error' : 'warn', 'http.request.rejected', { status, code, retryAfter });
  if (retryAfter) res.set('Retry-After', String(retryAfter));
  res.status(status).json({ error: { code, message, ...(retryAfter ? { retry_after: retryAfter } : {}) } });
}
