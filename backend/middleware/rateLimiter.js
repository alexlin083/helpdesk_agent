import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';
import { HttpError } from './errorHandler.js';
import { logger } from '../utils/logger.js';

/**
 * 建立有容量上限的單程序計數儲存；每次計數會清除到期項目，不淘汰仍有效的限制。
 * 容量滿載時拒絕新識別碼，避免藉由大量隨機來源擠掉既有限制；重啟後計數歸零。
 * @param {number} maxKeys 最多保留的識別碼數量。
 * @returns {object} 符合 express-rate-limit Store 介面的獨立儲存。
 */
export function createBoundedRateStore(maxKeys) {
  const entries = new Map();
  let windowMs;
  return {
    localKeys: true,
    /** 接收套件的視窗設定。@param {object} options 限流設定。@returns {void} */
    init(options) { windowMs = options.windowMs; },
    /**
     * 清除到期資料後原子增加請求數；操作期間沒有 await，不會在本程序交錯修改。
     * @param {string} key 經 middleware 判定的 IP 或可信任 userID。
     * @returns {Promise<object>} 請求數與視窗結束時間。
     * @throws {HttpError} 容量不足時回傳 503，不繞過保護。
     */
    async increment(key) {
      const now = Date.now();
      for (const [id, entry] of entries) if (entry.resetTime.getTime() <= now) entries.delete(id);
      if (!entries.has(key)) {
        if (entries.size >= maxKeys) throw Object.assign(new HttpError(503, 'SERVICE_BUSY', '請求保護服務忙碌，請稍後再試'), { retryAfter: 10 });
        entries.set(key, { totalHits: 0, resetTime: new Date(now + windowMs) });
      }
      const entry = entries.get(key);
      entry.totalHits += 1;
      return { ...entry };
    },
    /** 查詢尚未到期的計數。@param {string} key 識別碼。@returns {Promise<object|undefined>} 計數快照。 */
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.resetTime.getTime() <= Date.now()) { entries.delete(key); return undefined; }
      return { ...entry };
    },
    /**
     * 取得仍有效的視窗快照；只供程序內監測彙整，不清除到期項目、不增加計數。
     * 原始 key 可能為 IP，呼叫端不可直接將此快照送到前端。
     * @param {number} [now=Date.now()] 取樣時間（epoch 毫秒）。
     * @returns {Array<object>} key、totalHits 與 resetAt（epoch 毫秒）的獨立快照。
     */
    snapshot(now = Date.now()) {
      const result = [];
      for (const [key, entry] of entries) {
        if (entry.resetTime.getTime() > now) result.push({ key, totalHits: entry.totalHits, resetAt: entry.resetTime.getTime() });
      }
      return result;
    },
    /** 減少既有計數，不新增識別碼。@param {string} key 識別碼。@returns {Promise<void>} */
    async decrement(key) {
      const entry = entries.get(key);
      if (entry) entry.totalHits = Math.max(0, entry.totalHits - 1);
    },
    /** 清除指定識別碼，供維護及測試使用。@param {string} key 識別碼。@returns {Promise<void>} */
    async resetKey(key) { entries.delete(key); },
    /** 清除本儲存全部計數。@returns {Promise<void>} */
    async resetAll() { entries.clear(); },
    /** 清理程序內資源；本儲存沒有背景計時器。@returns {void} */
    shutdown() { entries.clear(); },
  };
}

/**
 * 建立彼此獨立的 HTTP 頻率限制；IP 為寬鬆入口保護，帳號限制只採驗證後的身分。
 * 所有請求（含失敗）皆計數，超限以既有 errorHandler 輸出統一 JSON 與 Retry-After。
 * 需求單送出與簽核以 HTTP_TICKET_LIMIT、部門名單以 HTTP_DEPARTMENTS_LIMIT、需求單查詢以 HTTP_QUERY_LIMIT 分別計數。
 * @param {object} [config=env] 已驗證的限制設定，可注入小額度作隔離測試。
 * @returns {object} apiRateLimiter、loginRateLimiter、ticketRateLimiter、departmentRateLimiter、queryRateLimiter、resetAll 與 snapshot；管理路徑需建立獨立的一組且不參與一般重置。
 */
export function createRateLimiters(config = env) {
  const stores = [];
  /**
   * 建立單一視窗 middleware 與獨立有界儲存，不在每次請求重新建立。
   * @param {string} scope 日誌與標頭的限制名稱。
   * @param {number} limit 視窗內容許請求數。
   * @param {boolean} [byUser=false] 是否以驗證後帳號計數。
   * @returns {Function} Express middleware。
   */
  function createLimiter(scope, limit, byUser = false) {
    /**
     * 排除不需要計數的請求；健康檢查僅排除 GET /health，OPTIONS 不計數。
     * @param {import('express').Request} req 掛載於 /api 的請求。
     * @returns {boolean} 是否略過此限制。
     */
    function skip(req) { return req.method === 'OPTIONS' || (scope === 'api' && req.method === 'GET' && /^\/health\/?$/i.test(req.path)); }
    /**
     * 只使用驗證後的 userID，不採信本文或未驗證 JWT；掛載順序錯誤時拒絕執行。
     * @param {import('express').Request} req 請求。
     * @returns {string} 可信任帳號識別。
     * @throws {HttpError} 缺少驗證後身分。
     */
    function userKey(req) {
      if (!req.user?.userID) throw new HttpError(401, 'UNAUTHORIZED', '請先登入');
      return req.user.userID;
    }
    /**
     * 依實際剩餘視窗回報拒絕，讓錯誤處理器保持 API 錯誤結構一致。
     * @param {import('express').Request} req 帶有本次 rateLimit 計數的請求。
     * @param {import('express').Response} res 回應，由錯誤處理器送出。
     * @param {import('express').NextFunction} next 傳遞限流錯誤。
     * @returns {void}
     */
    function handler(req, res, next) {
      const retryAfter = Math.max(1, Math.ceil((req.rateLimit.resetTime.getTime() - Date.now()) / 1000));
      logger('warn', 'http.rate_limit.blocked', { scope, limit, retryAfter });
      next(Object.assign(new HttpError(429, 'RATE_LIMIT_EXCEEDED', '請求過於頻繁，請稍後再試'), { retryAfter }));
    }
    const store = createBoundedRateStore(config.httpRateMaxKeys);
    stores.push({ scope, limit, byUser, store });
    return rateLimit({
      windowMs: config.httpRateWindowSeconds * 1000, limit,
      store,
      standardHeaders: 'draft-8', legacyHeaders: false, identifier: scope,
      skip, handler,
      ...(byUser ? { keyGenerator: userKey } : { ipv6Subnet: 64 }),
    });
  }
  return {
    /** 清空本組 HTTP 計數，僅供管理維護鎖內呼叫；不影響獨立管理端點的防連點限制。@returns {Promise<void>} */
    async resetAll() { for (const { store } of stores) await store.resetAll(); },
    /**
     * 彙整各限制仍有效的視窗；IP 只回總量，帳號視窗才附 userID，不揭露 IP 或登入來源摘要。
     * 超額請求只計仍有效視窗內超過上限的次數，不是啟動以來的累計或每秒請求量。
     * @param {number} [now=Date.now()] 取樣時間。
     * @returns {Array<object>} 限制設定、有效識別數、視窗請求合計、超額次數及帳號視窗。
     */
    snapshot(now = Date.now()) {
      const result = [];
      for (const { scope, limit, byUser, store } of stores) {
        const buckets = store.snapshot(now);
        let totalHits = 0;
        let atLimitKeys = 0;
        let overLimitRequests = 0;
        const users = [];
        for (const bucket of buckets) {
          totalHits += bucket.totalHits;
          atLimitKeys += Number(bucket.totalHits >= limit);
          overLimitRequests += Math.max(0, bucket.totalHits - limit);
          if (byUser) users.push({ userID: bucket.key, hits: bucket.totalHits, remaining: Math.max(0, limit - bucket.totalHits), resetAt: new Date(bucket.resetAt).toISOString() });
        }
        result.push({ scope, by: byUser ? 'user' : 'ip', limit, windowSeconds: config.httpRateWindowSeconds,
          maxKeys: config.httpRateMaxKeys, activeKeys: buckets.length, totalHits, atLimitKeys, overLimitRequests, users });
      }
      return result;
    },
    apiRateLimiter: createLimiter('api', config.httpApiLimit),
    loginRateLimiter: createLimiter('login', config.httpLoginLimit),
    ticketRateLimiter: createLimiter('ticket', config.httpTicketLimit, true),
    departmentRateLimiter: createLimiter('departments', config.httpDepartmentsLimit, true),
    queryRateLimiter: createLimiter('query', config.httpQueryLimit, true),
  };
}

export const { apiRateLimiter, loginRateLimiter, ticketRateLimiter, departmentRateLimiter, queryRateLimiter, resetAll: resetHttpLimits, snapshot: snapshotHttpLimits } = createRateLimiters();
