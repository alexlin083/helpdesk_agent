import { randomUUID, createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { limitStore } from './storage/limitStore.js';
import { HttpError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { ipKeyGenerator } from 'express-rate-limit';
import { accountFor } from './authService.js';

/**
 * 計算台北日期與下一個午夜，不依主機時區決定重置。
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
 * @returns {object} reserve、release、reserveDraft、releaseDraft、usage、draftUsage、loginAttempt 操作。
 */
export function createUsageService({ store = limitStore, config = env, clock = Date.now } = {}) {
  /**
   * 整理到期租約及登入計數，並在台北日期切換時清空每日計數（需求單判斷與自動生成兩種額度一起清空）。
   * @param {object} state 可修改的狀態快照。
   * @param {number} now 目前時間。
   * @returns {void}
   */
  function prepare(state, now) {
    const { day } = taipeiDay(now);
    if (state.day !== day) { state.day = day; state.total = 0; state.users = {}; state.draft = { total: 0, users: {} }; }
    state.draft ??= { total: 0, users: {} };
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
  /**
   * 將快照轉成自動生成的剩餘額度；跨台北午夜時視為尚未使用。
   * @param {object} state 配額狀態。
   * @param {string} userID 已驗證身分。
   * @param {number} now 目前時間。
   * @returns {object} userDailyLimit、userRemaining、globalDailyLimit、globalRemaining、resetAt。
   */
  function summarizeDraft(state, userID, now) {
    const date = taipeiDay(now);
    const current = state.day === date.day;
    return { userDailyLimit: config.draftUserDailyLimit, userRemaining: Math.max(0, config.draftUserDailyLimit - (current ? state.draft?.users?.[userID] ?? 0 : 0)),
      globalDailyLimit: config.draftGlobalDailyLimit, globalRemaining: Math.max(0, config.draftGlobalDailyLimit - (current ? state.draft?.total ?? 0 : 0)),
      resetAt: new Date(date.resetAt).toISOString() };
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
        // Agent 總期限最多 120 秒；180 秒租約另留配額儲存與故障復原緩衝。
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
     * 預扣一次「自動生成」AI 額度並取得並行租約。自動生成的每日額度（DRAFT_USER_DAILY_LIMIT／DRAFT_GLOBAL_DAILY_LIMIT）
     * 與需求單判斷分開計算、沒有冷卻；並行租約與需求單判斷共用 GLOBAL_CONCURRENCY 上限，租約鍵為 draft: 加 userID，
     * 因此同一帳號同時只能有一個自動生成請求，但不會擋住自己的需求單判斷。驗證失敗或限制拒絕不扣額。
     * 租約有效 90 秒，涵蓋無備援的 60 秒 AI 回合與 30 秒故障清理緩衝；正常回應前由 releaseDraft 提早釋放。
     * @param {string} userID 從憑證取得的可信任身分。
     * @returns {Promise<object>} id（租約識別碼）與 usage（userDailyLimit、userRemaining、globalDailyLimit、globalRemaining、resetAt）。
     * @throws {HttpError} 429 REQUEST_IN_PROGRESS／DAILY_QUOTA_EXCEEDED／GLOBAL_QUOTA_EXCEEDED、503 SERVICE_BUSY 或儲存故障。
     */
    async reserveDraft(userID) {
      const now = clock();
      const id = randomUUID();
      const leaseKey = `draft:${userID}`;
      /** 原子檢查並預扣自動生成額度，提交 90 秒租約以涵蓋 AI 回合及清理緩衝；拒絕時不扣額。@param {object} state 可變的記憶體限量狀態。@returns {object} 租約 id 與剩餘額度。@throws {HttpError} 帳號已有租約、每日額度不足或全站並行已滿。 */
      function reserveState(state) {
        prepare(state, now);
        if (state.leases[leaseKey]) throw blocked(429, 'REQUEST_IN_PROGRESS', '上一則訊息仍在整理中，請稍候', 2);
        const wait = (taipeiDay(now).resetAt - now) / 1000;
        if ((state.draft.users[userID] ?? 0) >= config.draftUserDailyLimit) throw blocked(429, 'DAILY_QUOTA_EXCEEDED', '此帳號今日自動生成額度已用完，台北時間午夜重置；仍可手動填寫欄位', wait);
        if (state.draft.total >= config.draftGlobalDailyLimit) throw blocked(429, 'GLOBAL_QUOTA_EXCEEDED', '全站今日自動生成額度已用完，台北時間午夜重置；仍可手動填寫欄位', wait);
        if (Object.keys(state.leases).length >= config.globalConcurrency) throw blocked(503, 'SERVICE_BUSY', '目前服務忙碌，請稍後再試', 2);
        state.draft.total += 1;
        state.draft.users[userID] = (state.draft.users[userID] ?? 0) + 1;
        // 無備援時整回合最多 60 秒；90 秒租約另留 30 秒清理緩衝，避免到期時提前放行並行請求。
        state.leases[leaseKey] = { id, until: now + 90000 };
        return { id, usage: summarizeDraft(state, userID, now) };
      }
      return store.transact(reserveState);
    },
    /**
     * 成功或失敗都釋放相符的自動生成租約，不退還已預扣的額度；舊請求不能釋放新租約。
     * @param {string} userID 已驗證身分。
     * @param {string} id 本次租約識別碼。
     * @returns {Promise<void>} 儲存失敗時保守保留租約，等待期限到期。
     */
    async releaseDraft(userID, id) {
      const leaseKey = `draft:${userID}`;
      /** 清除仍屬於本請求的租約。@param {object} state 狀態。@returns {void} */
      function releaseState(state) { if (state.leases?.[leaseKey]?.id === id) delete state.leases[leaseKey]; }
      try { await store.transact(releaseState); } catch { logger('error', 'limits.draft_release.failed', { userID }); }
    },
    /** 查詢目前自動生成用量。@param {string} userID 已驗證身分。@returns {Promise<object>} 自動生成額度。 */
    async draftUsage(userID) { return summarizeDraft(await store.read(), userID, clock()); },
    /**
     * 原子檢查 IP 整體與已知帳號＋IP 的失敗視窗；被封鎖時正確帳密也需等待。
     * 成功只清除該帳號組合，IP 失敗總數保留至到期；未知帳號不建立任意帳號桶。
     * @param {string} ip Express 依 trust proxy 取得的來源 IP，不信任任意標頭。
     * @param {boolean} valid 帳密是否有效。
     * @param {string} [username] 已知帳號；服務再次核對後端設定帳號，未知值只計入 IP。
     * @returns {Promise<void>}
     * @throws {HttpError} 超過失敗上限或儲存故障。
     */
    async loginAttempt(ip, valid, username) {
      const now = clock();
      // 與 HTTP IP 限制一致，IPv6 以 /64 分組，避免切換同網段地址繞過限制。
      const source = createHash('sha256').update(ipKeyGenerator(ip, 64)).digest('hex');
      const ipKey = `ip:${source}`;
      const account = accountFor(username);
      const accountKey = account ? `account:${source}:${account.username}` : null;
      /**
       * 檢查兩種限制後一起更新；最多 512 筆，容量不足時不淘汰仍生效的保護。
       * @param {object} state 可修改的限制狀態。
       * @returns {void}
       * @throws {HttpError} 超限或計數容量滿載。
       */
      function record(state) {
        prepare(state, now);
        const ipEntry = state.login[ipKey];
        const accountEntry = accountKey ? state.login[accountKey] : undefined;
        let waitUntil = 0;
        if (ipEntry?.count >= config.loginFailureLimit) waitUntil = ipEntry.resetAt;
        if (accountEntry?.count >= config.loginAccountFailureLimit) waitUntil = Math.max(waitUntil, accountEntry.resetAt);
        if (waitUntil) throw blocked(429, 'LOGIN_RATE_LIMITED', '登入失敗次數過多，請稍後再試', (waitUntil - now) / 1000);
        if (valid) { if (accountKey) delete state.login[accountKey]; return; }
        const additions = Number(!ipEntry) + Number(Boolean(accountKey) && !accountEntry);
        if (Object.keys(state.login).length + additions > 512) throw blocked(503, 'SERVICE_BUSY', '登入服務忙碌，請稍後再試', 30);
        state.login[ipKey] = { count: (ipEntry?.count ?? 0) + 1, resetAt: ipEntry?.resetAt ?? now + config.loginWindowSeconds * 1000 };
        if (accountKey) state.login[accountKey] = { count: (accountEntry?.count ?? 0) + 1,
          resetAt: accountEntry?.resetAt ?? now + config.loginAccountWindowSeconds * 1000 };
      }
      await store.transact(record);
    },
  };
}
export const usageService = createUsageService();
