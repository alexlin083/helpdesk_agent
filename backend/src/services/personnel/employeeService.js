import { dataStore } from '../storage/dataStore.js';
import { normalizeEmployees } from './personnel.js';

// 員工基本資料與假別額度只存在 SQLite（employees、leave_entitlements），沒有員工設定檔；驗證規則集中在 personnel.js，這裡保留匯出。
export { normalizeEmployees };

/**
 * 建立員工查詢服務。
 * - 提供 employees 時建立記憶體版本（只供單元測試注入假資料）：建立時以 normalizeEmployees 對照 accounts 驗證一次，之後不再變動。
 * - 未提供時建立 SQLite 版本：透過需求單儲存的唯一連線，每次呼叫同步查詢資料庫目前內容，不快取；
 *   維運腳本 scripts/personnel.js 或人資 API 的變更，下一次呼叫就會看到。
 * 兩種版本的介面相同：list 取得全部員工、find 依帳號查詢；回傳的都是複本。管理員沒有員工資料。
 * @param {object} [options={}] 設定。
 * @param {Array<object>} [options.employees] 假員工資料（username、display_name、employee_no、hire_date、entitlements）；提供時使用記憶體版本。
 * @param {object|Array<object>} [options.accounts] 記憶體版本對照的帳號查詢服務（需有 list）或已正規化的帳號陣列；提供 employees 時必填。
 * @param {object} [options.store=dataStore] SQLite 版本使用的儲存（需有 listEmployees、findEmployee）。
 * @returns {{list: Function, find: Function}} 員工查詢服務。
 * @throws {Error} 記憶體版本的員工資料無效，或提供 employees 卻未提供 accounts。
 */
export function createEmployeeService({ employees, accounts, store = dataStore } = {}) {
  if (!employees) {
    return {
      /**
       * 依寫入順序取得全部員工資料（含所屬帳號已停用者）。
       * @returns {Array<{username: string, displayName: string, employeeNo: string, hireDate: string, entitlements: Array<object>}>} 員工資料。
       * @throws {HttpError} 503 資料庫無法讀取。
       */
      list() { return store.listEmployees(); },
      /**
       * 依帳號查詢員工資料；區分大小寫。
       * @param {unknown} username 帳號。
       * @returns {object|null} 員工資料，查無或參數不是字串時 null。
       * @throws {HttpError} 503 資料庫無法讀取。
       */
      find(username) { return typeof username === 'string' ? store.findEmployee(username) : null; },
    };
  }
  if (!accounts) throw new Error('記憶體版本的員工查詢服務需要對照的帳號（accounts）');
  const data = normalizeEmployees(employees, accounts);
  return {
    /** 取得全部員工資料的複本，順序與輸入相同。@returns {Array<object>} 員工陣列。 */
    list() { return structuredClone(data); },
    /**
     * 依帳號查詢員工資料。
     * @param {unknown} username 帳號。
     * @returns {object|null} 員工複本，查無時 null。
     */
    find(username) {
      const found = data.find(/** 比對帳號。@param {object} employee 員工。@returns {boolean} 相符時 true。 */ (employee) => employee.username === username);
      return found ? structuredClone(found) : null;
    },
  };
}

export const employeeService = createEmployeeService();
