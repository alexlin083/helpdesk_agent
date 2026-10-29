import { ticketStore } from './ticketStore.js';
import { limitStore } from './limitStore.js';
import { chatTasks } from './chatTasks.js';
import { resetHttpLimits } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';

/**
 * 建立課堂重置服務：先排空所有業務工作，成功清空工作單後才重置保護計數。
 * 僅供已授權的管理端點呼叫，管理端點自己的防連點計數不在重置範圍內。
 * @param {object} [options={}] 可替換的儲存與工作追蹤依賴。
 * @param {object} [options.tickets=ticketStore] 支援 clear 的檔案儲存。
 * @param {object} [options.limits=limitStore] 支援 reset 的記憶體保護儲存。
 * @param {object} [options.tasks=chatTasks] 單程序維護鎖。
 * @param {Function} [options.resetRates=resetHttpLimits] 清除一般 HTTP 計數。
 * @returns {Function} 接收操作者身分的重置函式。
 */
export function createAdminReset({ tickets = ticketStore, limits = limitStore, tasks = chatTasks, resetRates = resetHttpLimits } = {}) {
  /**
   * 進入維護模式並重置課堂資料；不呼叫 Gemini、不刪除帳號、不更換 JWT 金鑰。
   * @param {object} actor 後端驗證的管理員身分，僅記錄 userID。
   * @returns {Promise<object>} deletedTickets、resetAt。
   * @throws {Error} 工作排空、檔案寫入或重置失敗；維護鎖由追蹤器確保釋放。
   */
  return async function reset(actor) {
    /** 依序清檔、清配額與清 HTTP 計數；檔案失敗時保留全部計數。@returns {Promise<object>} 重置摘要。 */
    async function clearState() {
      const deletedTickets = await tickets.clear();
      await limits.reset();
      await resetRates();
      const result = { deletedTickets, resetAt: new Date().toISOString() };
      logger('warn', 'admin.reset.completed', { actorID: actor.userID, ...result });
      return result;
    }
    return tasks.exclusive(clearState);
  };
}
export const resetClassroom = createAdminReset();
