import { departmentService } from '../departmentService.js';
import { normalizeAccounts, USERNAME_PATTERN, ACCOUNT_ROLES } from './personnel.js';

// 帳號只存在 SQLite（accounts 資料表），沒有帳號設定檔；驗證規則集中在 personnel.js，這裡保留匯出，維持既有引用方式。
export { normalizeAccounts, USERNAME_PATTERN, ACCOUNT_ROLES };

/**
 * 組出對外的帳號身分，附上所屬部門的 id 與名稱；呼叫端必須先確認部門存在。
 * @param {{username: string, departmentId: string, role: string}} account 內部帳號資料。
 * @param {object} departments 部門查詢服務。
 * @returns {{username: string, userID: string, role: string, department: {id: string, name: string}}} 帳號身分；權限僅取自後端資料。
 */
export function accountIdentity(account, departments) {
  const department = departments.findDepartment(account.departmentId);
  return { username: account.username, userID: `user-${account.username}`, role: account.role, department: { id: department.id, name: department.name } };
}

/**
 * 把帳號轉成處理人形狀（id 與 name 都是帳號名稱）。
 * @param {{username: string}} account 內部帳號資料。
 * @returns {{id: string, name: string}} 處理人。
 */
export function accountHandler(account) {
  return { id: account.username, name: account.username };
}

/**
 * 建立記憶體中的帳號查詢服務：只供單元測試注入假帳號，資料在建立時驗證一次（部門必須存在），之後不再變動，全部帳號視為啟用。
 * 正式執行時的帳號查詢由 accountService 的 SQLite 版本提供，沒有讀取任何帳號檔案的路徑。
 * 一般帳號同時就是「可指定的處理人」，管理員不參與工作單流程：處理人 id 即帳號名稱，顯示名稱也是帳號名稱。
 * @param {object} options 設定。
 * @param {Array<object>} options.accounts 假帳號資料（username、department_id、選填 role），必填。
 * @param {object} [options.departments=departmentService] 部門查詢服務。
 * @returns {object} usernames、find、list、handlersOf、findHandler、missingDepartments、seed 操作。
 * @throws {Error} 帳號資料缺漏或無效。
 */
export function createMemoryAccountService({ accounts, departments = departmentService }) {
  const data = normalizeAccounts(accounts, departments);
  const byName = new Map(data.map(/** 建立帳號索引。@param {object} account 帳號。@returns {[string, object]} [帳號, 資料]。 */ (account) => [account.username, account]));
  return {
    /** 全部帳號名稱，順序與輸入相同。 */
    usernames: Object.freeze(data.map(/** 取帳號名稱。@param {object} account 帳號。@returns {string} 帳號。 */ (account) => account.username)),
    /**
     * 依帳號查詢身分；區分大小寫，不做正規化。
     * @param {unknown} username 帳號。
     * @returns {object|null} username、userID、role、department，查無時回傳 null。
     */
    find(username) {
      const account = typeof username === 'string' ? byName.get(username) : undefined;
      return account ? accountIdentity(account, departments) : null;
    },
    /** 取得所有帳號身分，順序與輸入相同。@returns {Array<object>} 帳號陣列。 */
    list() { return data.map(/** 轉成身分。@param {object} account 帳號。@returns {object} 身分。 */ (account) => accountIdentity(account, departments)); },
    /**
     * 取得某個部門可指定的處理人（該部門的一般帳號，不含管理員），順序與輸入相同。
     * @param {string} departmentId 部門 id。
     * @returns {Array<{id: string, name: string}>} 處理人陣列。
     */
    handlersOf(departmentId) {
      /** 篩選部門相符的一般帳號，排除管理員。@param {object} account 後端設定帳號。@returns {boolean} 是否可指定。 */
      function belongsToDepartment(account) { return account.departmentId === departmentId && account.role === 'USER'; }
      return data.filter(belongsToDepartment).map(accountHandler);
    },
    /**
     * 依處理人 id（即一般帳號）找出處理人與所屬部門；管理員一律視為不可指定。
     * @param {unknown} handlerId 處理人 id。
     * @returns {{handler: object, department: object}|null} 找不到時回傳 null。
     */
    findHandler(handlerId) {
      const account = typeof handlerId === 'string' ? byName.get(handlerId) : undefined;
      return account?.role === 'USER' ? { handler: accountHandler(account), department: departments.findDepartment(account.departmentId) } : null;
    },
    /** 記憶體資料在建立時已驗證部門存在，因此一律回傳空陣列；與 SQLite 版本的介面一致。@returns {Array<object>} 空陣列。 */
    missingDepartments() { return []; },
    /**
     * 取得建立時驗證過的帳號資料複本（測試用）。
     * @returns {Array<{username: string, departmentId: string, role: string}>} 帳號複本，順序與輸入相同。
     */
    seed() { return structuredClone(data); },
  };
}
