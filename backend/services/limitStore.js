/**
 * 建立 local 與 production 共用的單程序記憶體保護儲存。
 * 同步提交快照確保配額與租約一起生效；重啟或管理重置會歸零，不提供跨程序持久化。
 * @returns {object} read、transact 與 reset 操作；mutator 必須同步且沒有外部副作用。
 */
export function createMemoryLimitStore() {
  let state = {};
  return {
    /** 管理維護期間清除配額、冷卻、租約與登入失敗記錄；呼叫前須排空既有工作。@returns {Promise<void>} */
    async reset() { state = {}; },
    /** 讀取獨立快照。@returns {Promise<object>} 目前限制資料。 */
    async read() { return structuredClone(state); },
    /**
     * 在同一個事件迴圈中同步執行限制檢查與寫入，失敗不提交。
     * @param {Function} mutate 同步修改快照並回傳結果的函式。
     * @returns {Promise<unknown>} 修改函式的結果。
     */
    async transact(mutate) {
      const next = structuredClone(state);
      const result = mutate(next);
      state = next;
      return result;
    },
  };
}

export const limitStore = createMemoryLimitStore();
