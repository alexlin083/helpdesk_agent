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

  if (status === 429) res.set('Retry-After', '10');
  res.status(status).json({ error: { code, message } });
}
