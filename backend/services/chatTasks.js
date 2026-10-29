import { HttpError } from '../middleware/errorHandler.js';

/**
 * 建立需求單工作追蹤器，涵蓋配額預扣、部門判斷、記錄寫入與租約釋放；關機時禁止新工作並等待既有工作結束。
 * 僅支援單程序；維護時也等待登入、查詢與工作單變更，避免重置後寫回舊資料。
 * @returns {object} run、exclusive、stop、idle 與 status 操作。
 */
export function createChatTasks() {
  let stopping = false;
  let maintaining = false;
  const pending = new Set();
  return {
    /**
     * 執行並追蹤完整的非同步需求單流程；失敗也會移除追蹤項目。
     * @param {Function} task 不需參數的非同步工作。
     * @returns {Promise<*>} 工作的結果。
     * @throws {HttpError} 已開始關機或維護時回傳 503，不執行工作或扣額。
     */
    async run(task) {
      if (stopping || maintaining) throw Object.assign(new HttpError(503, 'SERVICE_BUSY', '服務正在維護或重新啟動，請稍後再試'), { retryAfter: 10 });
      const work = Promise.resolve().then(task);
      pending.add(work);
      try { return await work; } finally { pending.delete(work); }
    },
    /**
     * 取得程序內維護鎖，拒絕新工作，等所有登入與工作單操作完成後才執行重置。
     * 重複維護立即拒絕；即使維護失敗也解除維護旗標，不會解除已收到的關機訊號。
     * @param {Function} task 無參數的非同步維護操作，不得再次呼叫 run 或 exclusive。
     * @returns {Promise<*>} 維護結果。
     * @throws {HttpError} 維護中或關機中；其他錯誤原樣傳遞。
     */
    async exclusive(task) {
      if (stopping || maintaining) throw Object.assign(new HttpError(503, 'SERVICE_BUSY', '服務正在維護，請稍後再試'), { retryAfter: 10 });
      maintaining = true;
      // 將維護本身也列入關機等待；只等鎖定前的快照，避免等待自己。
      const existing = [...pending];
      /** 排空鎖定前的工作後執行維護。@returns {Promise<*>} 維護結果。 */
      async function maintain() { await Promise.allSettled(existing); return task(); }
      const work = maintain();
      pending.add(work);
      try { return await work; } finally { pending.delete(work); maintaining = false; }
    },
    /**
     * 只讀目前程序的工作與維護狀態，不新增工作或修改鎖。
     * pending 包含登入、查詢、工作單及維護，不等同 Gemini 並行租約數。
     * @returns {{maintaining: boolean, stopping: boolean, pending: number}} 當前狀態。
     */
    status() { return { maintaining, stopping, pending: pending.size }; },
    /** 停止接受新需求單，既有工作繼續執行。@returns {void} */
    stop() { stopping = true; },
    /** 等待所有已追蹤工作，包括失敗流程的租約釋放。@returns {Promise<void>} */
    async idle() { await Promise.allSettled([...pending]); },
  };
}

export const chatTasks = createChatTasks();

/**
 * 將 Express 處理器納入單程序工作追蹤，讓維護與關機等到實際非同步邏輯完成。
 * @param {Function} handler 接收 req、res、next 的處理器。
 * @param {object} [tasks=chatTasks] 工作追蹤器。
 * @returns {Function} 可掛載的 Express 非同步處理器。
 */
export function trackRequest(handler, tasks = chatTasks) {
  /** 執行並追蹤本次請求；回應斷線不會提前解除工作追蹤。@param {object} req 請求。@param {object} res 回應。@param {Function} next 後續處理。@returns {Promise<*>} 原處理結果。 */
  return async function tracked(req, res, next) {
    /** 呼叫原處理器，維護期間不執行。@returns {Promise<*>|*} 原處理結果。 */
    function execute() { return handler(req, res, next); }
    return tasks.run(execute);
  };
}
