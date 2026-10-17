import { HttpError } from '../middleware/errorHandler.js';

/**
 * 為整次 Agent 工作設定總期限，逾時取消 SDK 等待並回傳既有 SERVER_ERROR 合約。
 * Promise 競速確保不遵守 AbortSignal 的替身也能結束等待；不保證供應商停止計費。
 * @param {Function} task 接收 AbortSignal 的非同步工作。
 * @param {number} timeoutMs 從開始執行起算的期限，單位毫秒。
 * @returns {Promise<*>} 期限內的工作結果。
 * @throws {HttpError} 超過總期限；其他工作錯誤保持原樣。
 */
export async function withAgentDeadline(task, timeoutMs) {
  const controller = new AbortController();
  let timer;
  /**
   * 建立期限計時器，先取消 SDK 再拒絕外層等待。
   * @param {Function} resolve Promise 成功函式，此處不使用。
   * @param {Function} reject Promise 失敗函式。
   * @returns {void}
   */
  function deadline(resolve, reject) {
    /** 到期時送出可辨識且不含原文的錯誤。@returns {void} */
    function expire() {
      const error = Object.assign(new HttpError(500, 'SERVER_ERROR', 'AI 處理逾時，請稍後再試'), { agentTimeout: true });
      controller.abort(error);
      reject(error);
    }
    timer = setTimeout(expire, timeoutMs);
  }
  try { return await Promise.race([task(controller.signal), new Promise(deadline)]); }
  finally { clearTimeout(timer); }
}
