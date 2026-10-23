import { HttpError } from '../middleware/errorHandler.js';

/**
 * 建立需求單工作追蹤器，涵蓋配額預扣、部門判斷、記錄寫入與租約釋放；關機時禁止新工作並等待既有工作結束。
 * 僅追蹤本程序，不取代跨程序的並行配額儲存。
 * @returns {object} run、stop 與 idle 操作。
 */
export function createChatTasks() {
  let stopping = false;
  const pending = new Set();
  return {
    /**
     * 執行並追蹤完整的非同步需求單流程；失敗也會移除追蹤項目。
     * @param {Function} task 不需參數的非同步工作。
     * @returns {Promise<*>} 工作的結果。
     * @throws {HttpError} 已開始關機時回傳 503，不執行工作或扣額。
     */
    async run(task) {
      if (stopping) throw Object.assign(new HttpError(503, 'SERVICE_BUSY', '服務正在重新啟動，請稍後再試'), { retryAfter: 10 });
      const work = Promise.resolve().then(task);
      pending.add(work);
      try { return await work; } finally { pending.delete(work); }
    },
    /** 停止接受新需求單，既有工作繼續執行。@returns {void} */
    stop() { stopping = true; },
    /** 等待所有已追蹤工作，包括失敗流程的租約釋放。@returns {Promise<void>} */
    async idle() { await Promise.allSettled([...pending]); },
  };
}

export const chatTasks = createChatTasks();
