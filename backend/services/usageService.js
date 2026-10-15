import { randomUUID, createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { limitStore } from './limitStore.js';
import { HttpError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

/**
 * 計算台北日期與下一個午夜，不依主機時區或資料庫 TTL 決定重置。
 * @param {number} now 目前 epoch 毫秒。
 * @returns {{day: string, resetAt: number}} 日期鍵及下一個午夜 epoch 毫秒。
 */
export function taipeiDay(now) {
  const offset = 8 * 3600000;
  return { day: new Date(now + offset).toISOString().slice(0, 10),
    resetAt: (Math.floor((now + offset) / 86400000) + 1) * 86400000 - offset };
}

/**
 * 建立有重試秒數的限流錯誤，供 HTTP middleware 產生 Retry-After。
 * @param {number} status HTTP 狀態。
 * @param {string} code 錯誤代碼。
 * @param {string} message 中文提示。
 * @param {number} seconds 等待秒數。
 * @returns {HttpError} 帶有 retryAfter 的錯誤。
 */
function blocked(status, code, message, seconds) {
  return Object.assign(new HttpError(status, code, message), { retryAfter: Math.max(1, Math.ceil(seconds)) });
}

/**
 * 建立配額與登入防猜服務；所有需一起生效的檢查與扣額在同一次 store 提交。
 * @param {object} [options={}] 依賴注入設定。
 * @param {object} [options.store=limitStore] 原子狀態儲存。
 * @param {object} [options.config=env] 正整數限制設定。
 * @param {Function} [options.clock=Date.now] 時間來源。
 * @returns {object} reserve、release、usage、loginAttempt 操作。
 */
export function createUsageService({ store = limitStore, config = env, clock = Date.now } = {}) {
  /**
   * 整理到期租約及登入計數，並在台北日期切換時清空每日計數。
   * @param {object} state 可修改的狀態快照。
   * @param {number} now 目前時間。
   * @returns {void}
   */
  function prepare(state, now) {
    const { day } = taipeiDay(now);
    if (state.day !== day) { state.day = day; state.total = 0; state.users = {}; }
    state.leases ??= {};
    state.cooldowns ??= {};
    state.login ??= {};
    for (const [id, lease] of Object.entries(state.leases)) if (lease.until <= now) delete state.leases[id];
    for (const [id, entry] of Object.entries(state.login)) if (entry.resetAt <= now) delete state.login[id];
  }
  /**
   * 將快照轉成前端可顯示的剩餘額度；不回傳其他帳號資料。
   * @param {object} state 配額狀態。
   * @param {string} userID 已驗證身分。
   * @param {number} now 目前時間。
   * @returns {object} 用量、限制、台北重置時間及剩餘冷卻秒數。
   */
  function summarize(state, userID, now) {
    const date = taipeiDay(now);
    const current = state.day === date.day;
    return { userDailyLimit: config.userDailyLimit, userRemaining: Math.max(0, config.userDailyLimit - (current ? state.users?.[userID] ?? 0 : 0)),
      globalDailyLimit: config.globalDailyLimit, globalRemaining: Math.max(0, config.globalDailyLimit - (current ? state.total ?? 0 : 0)),
      resetAt: new Date(date.resetAt).toISOString(), cooldownSeconds: Math.max(0, Math.ceil(((state.cooldowns?.[userID] ?? 0) - now) / 1000)) };
  }
  return {
    /**
     * 預扣一次 Agent 配額並取得並行租約；驗證失敗或限制拒絕不扣額。
     * @param {string} userID 從憑證取得的可信任身分。
     * @returns {Promise<object>} 租約識別及扣額後用量。
     * @throws {HttpError} 冷卻、配額、並行上限或儲存故障。
     */
    async reserve(userID) {
      const now = clock();
      const id = randomUUID();
      /** 原子檢查並提交租約與配額。@param {object} state 狀態。@returns {object} 預扣結果。 */
      function reserveState(state) {
        prepare(state, now);
        if (state.leases[userID]) throw blocked(429, 'REQUEST_IN_PROGRESS', '此帳號仍有問題處理中', 2);
        if ((state.cooldowns[userID] ?? 0) > now) throw blocked(429, 'RATE_LIMIT_EXCEEDED', '請等待冷卻結束後再送出', (state.cooldowns[userID] - now) / 1000);
        const wait = (taipeiDay(now).resetAt - now) / 1000;
        if ((state.users[userID] ?? 0) >= config.userDailyLimit) throw blocked(429, 'DAILY_QUOTA_EXCEEDED', '此帳號今日額度已用完，台北時間午夜重置', wait);
        if (state.total >= config.globalDailyLimit) throw blocked(429, 'GLOBAL_QUOTA_EXCEEDED', '全站今日額度已用完，台北時間午夜重置', wait);
        if (Object.keys(state.leases).length >= config.globalConcurrency) throw blocked(503, 'SERVICE_BUSY', '目前服務忙碌，請稍後再試', 2);
        state.total += 1;
        state.users[userID] = (state.users[userID] ?? 0) + 1;
        state.cooldowns[userID] = now + config.chatCooldownSeconds * 1000;
        // 三個上游階段各 30 秒；180 秒租約提供故障復原與額外緩衝。
        state.leases[userID] = { id, until: now + 180000 };
        return { id, usage: summarize(state, userID, now) };
      }
      return store.transact(reserveState);
    },
    /**
     * 成功或失敗都釋放相符租約，但不退還已預扣的額度；舊請求不能釋放新租約。
     * @param {string} userID 已驗證身分。
     * @param {string} id 本次租約識別碼。
     * @returns {Promise<void>} 儲存失敗時保守保留租約，等待期限到期。
     */
    async release(userID, id) {
      /** 清除仍屬於本請求的租約。@param {object} state 狀態。@returns {void} */
      function releaseState(state) { if (state.leases?.[userID]?.id === id) delete state.leases[userID]; }
      try { await store.transact(releaseState); } catch { logger('error', 'limits.release.failed', { userID }); }
    },
    /** 查詢目前用量。@param {string} userID 已驗證身分。@returns {Promise<object>} 額度。 */
    async usage(userID) { return summarize(await store.read(), userID, clock()); },
    /**
     * 在單一原子操作中檢查 IP 失敗次數並更新；被封鎖時即使密碼正確也需等待。
     * @param {string} ip Express 依 trust proxy 取得的來源 IP，不信任任意標頭。
     * @param {boolean} valid 帳密是否有效。
     * @returns {Promise<void>}
     * @throws {HttpError} 超過失敗上限或儲存故障。
     */
    async loginAttempt(ip, valid) {
      const now = clock();
      const key = createHash('sha256').update(ip).digest('hex');
      /** 更新 IP 視窗，限制同時追蹤的來源以控制狀態大小。@param {object} state 狀態。@returns {void} */
      function record(state) {
        prepare(state, now);
        const entry = state.login[key];
        if (entry?.count >= config.loginFailureLimit) throw blocked(429, 'LOGIN_RATE_LIMITED', '登入失敗次數過多，請稍後再試', (entry.resetAt - now) / 1000);
        if (valid) { delete state.login[key]; return; }
        if (!entry && Object.keys(state.login).length >= 512) throw blocked(503, 'SERVICE_BUSY', '登入服務忙碌，請稍後再試', 30);
        state.login[key] = { count: (entry?.count ?? 0) + 1, resetAt: entry?.resetAt ?? now + config.loginWindowSeconds * 1000 };
      }
      await store.transact(record);
    },
  };
}
export const usageService = createUsageService();
