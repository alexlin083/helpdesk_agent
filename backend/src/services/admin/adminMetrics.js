import { env } from '../../config/env.js';
import { limitStore } from '../storage/limitStore.js';
import { accountService } from '../personnel/accountService.js';
import { taskTracker } from '../taskTracker.js';
import { dataStore } from '../storage/dataStore.js';
import { taipeiDay } from '../usageService.js';
import { snapshotHttpLimits } from '../../middleware/rateLimiter.js';

// 監測採獨立固定視窗，避免輪詢消耗一般業務或管理重置的額度。
export const MONITOR_POLICY = Object.freeze({ pollSeconds: 5, windowSeconds: 60, ipLimit: 120, userLimit: 60 });

/**
 * 取得需求單資料庫的監測摘要；資料庫無法讀取時不讓整份監測失敗，改回報 available=false 且數值為 null。
 * @param {object} tickets 支援 stats 的需求單儲存。
 * @returns {Promise<object>} engine、available、schemaVersion、total、pending、approved、rejected、cancelled、fileBytes、walBytes。
 */
async function ticketStoreSummary(tickets) {
  try {
    const stats = await tickets.stats();
    return { engine: 'sqlite', available: true, schemaVersion: stats.schemaVersion, total: stats.total,
      pending: stats.byStatus.PENDING, approved: stats.byStatus.APPROVED, rejected: stats.byStatus.REJECTED, cancelled: stats.byStatus.CANCELLED,
      fileBytes: stats.fileBytes, walBytes: stats.walBytes };
  } catch {
    return { engine: 'sqlite', available: false, schemaVersion: null, total: null, pending: null, approved: null, rejected: null, cancelled: null, fileBytes: null, walBytes: null };
  }
}

/**
 * 建立管理員唯讀監測服務；讀取實際設定、記憶體快照與需求單資料庫的彙總計數，不查工作單原文、不呼叫 Gemini。
 * 日期與到期狀態在輸出時投影，不寫回儲存；各儲存依序取樣，非跨儲存交易快照。
 * @param {object} [options={}] 可替換依賴。
 * @param {object} [options.store=limitStore] 支援 read 的配額儲存。
 * @param {object} [options.accounts=accountService] 支援 list 的後端帳號設定。
 * @param {object} [options.tasks=taskTracker] 支援 status 的工作追蹤器。
 * @param {object} [options.tickets=dataStore] 支援 stats 的需求單儲存，只取各狀態筆數與檔案大小。
 * @param {Function} [options.rates=snapshotHttpLimits] 取得一般 HTTP 視窗彙整。
 * @param {object} [options.config=env] 啟動時驗證的限制設定，不將整份設定輸出。
 * @param {Function} [options.clock=Date.now] epoch 毫秒時間來源。
 * @returns {Function} 取得限制設定、AI 用量、帳號狀態、需求單資料庫與匿名登入／HTTP 摘要的非同步函式。
 */
export function createAdminMetrics({ store = limitStore, accounts = accountService, tasks = taskTracker, tickets = dataStore, rates = snapshotHttpLimits, config = env, clock = Date.now } = {}) {
  const startedAt = clock();
  /**
   * 取得目前程序的監測快照，只回傳明確白名單欄位；不輸出秘密、IP、雜湊、token、租約 ID 或需求單內容。
   * 跨台北午夜忽略舊日配額，跨午夜的有效冷卻與租約仍保留。runtime.storage 描述限流計數的儲存（記憶體），
   * 需求單資料庫另以回應欄位 ticketStore 回報。
   * @returns {Promise<object>} observedAt、pollSeconds、runtime、ticketStore、ai、users、login 與 http。
   */
  return async function metrics() {
    const ticketSummary = await ticketStoreSummary(tickets);
    const state = await store.read();
    const now = clock();
    const { day, resetAt } = taipeiDay(now);
    const current = state.day === day;
    let active = 0;
    for (const lease of Object.values(state.leases ?? {})) if (lease.until > now) active += 1;
    const users = [];
    for (const account of accounts.list()) {
      if (account.role !== 'USER') continue;
      const used = current ? state.users?.[account.userID] ?? 0 : 0;
      const lease = state.leases?.[account.userID];
      users.push({ username: account.username, userID: account.userID, department: account.department,
        used, remaining: Math.max(0, config.userDailyLimit - used), dailyLimit: config.userDailyLimit,
        cooldownSeconds: Math.max(0, Math.ceil(((state.cooldowns?.[account.userID] ?? 0) - now) / 1000)),
        inProgress: Boolean(lease && lease.until > now) });
    }
    const login = {
      ip: { limit: config.loginFailureLimit, windowSeconds: config.loginWindowSeconds, activeKeys: 0, atLimitKeys: 0, failures: 0 },
      account: { limit: config.loginAccountFailureLimit, windowSeconds: config.loginAccountWindowSeconds, activeKeys: 0, atLimitKeys: 0, failures: 0 },
      capacity: 512,
    };
    for (const [key, entry] of Object.entries(state.login ?? {})) {
      if (entry.resetAt <= now) continue;
      const bucket = key.startsWith('ip:') ? login.ip : key.startsWith('account:') ? login.account : null;
      if (!bucket) continue;
      bucket.activeKeys += 1;
      bucket.failures += entry.count;
      bucket.atLimitKeys += Number(entry.count >= bucket.limit);
    }
    const used = current ? state.total ?? 0 : 0;
    const status = tasks.status();
    return {
      observedAt: new Date(now).toISOString(), pollSeconds: MONITOR_POLICY.pollSeconds,
      runtime: { startedAt: new Date(startedAt).toISOString(), uptimeSeconds: Math.max(0, Math.floor((now - startedAt) / 1000)),
        environment: config.nodeEnv, storage: 'memory', maintaining: status.maintaining, stopping: status.stopping, pending: status.pending },
      ticketStore: ticketSummary,
      ai: { day, resetAt: new Date(resetAt).toISOString(), used, remaining: Math.max(0, config.globalDailyLimit - used),
        dailyLimit: config.globalDailyLimit, userDailyLimit: config.userDailyLimit, active, concurrencyLimit: config.globalConcurrency,
        userConcurrencyLimit: 1, cooldownSeconds: config.chatCooldownSeconds },
      users, login, http: rates(now), monitoring: MONITOR_POLICY,
    };
  };
}
export const adminMetrics = createAdminMetrics();
