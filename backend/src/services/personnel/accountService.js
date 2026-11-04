import { departmentService } from '../departmentService.js';
import { dataStore } from '../storage/dataStore.js';
import { normalizeAccounts, createMemoryAccountService, accountIdentity, accountHandler } from './accountDirectory.js';

// 驗證規則集中在 personnel.js（經 accountDirectory.js 轉出）；這裡保留匯出，維持既有呼叫端與測試的引用方式。
export { normalizeAccounts };

/**
 * 建立以 SQLite（accounts 資料表）為準的帳號查詢服務：每次呼叫都同步查詢資料庫目前內容，不快取，
 * 因此維運腳本 scripts/personnel.js 調整部門或停用帳號後，執行中的服務下一個請求就會看到，不需要重啟。
 * 透過需求單儲存的唯一連線查詢（不另開第二條連線）；第一次查詢時才開啟資料庫（全新資料庫會先寫入示範名冊）。
 * 「可使用的帳號」必須同時符合：active = 1，且 department_id 仍存在於部門設定檔。不符合的帳號視同不存在：
 * 不能登入（既有憑證也會失效）、不列入 list／usernames、不能被指定為處理人或需求單帳號欄位的人選。管理員（ADMIN）不是處理人。
 * @param {object} [options={}] 設定。
 * @param {object} [options.store=dataStore] 提供 listAccounts、findAccount、departmentAccounts 同步查詢的儲存。
 * @param {object} [options.departments=departmentService] 部門查詢服務。
 * @returns {object} usernames（getter）、find、list、handlersOf、findHandler、missingDepartments 操作。
 */
export function createSqliteAccountService({ store = dataStore, departments = departmentService } = {}) {
  /**
   * 判斷帳號列是否可使用：存在、啟用中且所屬部門仍在部門設定檔。
   * @param {{department_id: string, active: number}|null} row 帳號列。
   * @returns {boolean} 可使用時 true。
   */
  function usable(row) {
    return Boolean(row) && row.active === 1 && Boolean(departments.findDepartment(row.department_id));
  }
  /**
   * 把資料表的帳號列轉成內部帳號形狀。
   * @param {{username: string, department_id: string, role: string}} row 帳號列。
   * @returns {{username: string, departmentId: string, role: string}} 內部帳號資料。
   */
  function toAccount(row) {
    return { username: row.username, departmentId: row.department_id, role: row.role };
  }
  /**
   * 取得全部可使用的帳號（依寫入順序）。
   * @returns {Array<{username: string, departmentId: string, role: string}>} 內部帳號資料。
   * @throws {HttpError} 503 資料庫無法讀取。
   */
  function usableAccounts() {
    return store.listAccounts().filter(usable).map(toAccount);
  }
  return {
    /**
     * 目前可使用的帳號名稱（每次讀取都重新查詢，回傳凍結的新陣列）。
     * @returns {ReadonlyArray<string>} 帳號名稱，依寫入順序。
     * @throws {HttpError} 503 資料庫無法讀取。
     */
    get usernames() {
      return Object.freeze(usableAccounts().map(/** 取帳號名稱。@param {object} account 帳號。@returns {string} 帳號。 */ (account) => account.username));
    },
    /**
     * 依帳號查詢身分；區分大小寫，不做正規化。停用或部門已不存在的帳號回傳 null（登入時與未知帳號相同，回 401）。
     * @param {unknown} username 帳號。
     * @returns {object|null} username、userID、role、department，查無或不可使用時 null。
     * @throws {HttpError} 503 資料庫無法讀取。
     */
    find(username) {
      if (typeof username !== 'string') return null;
      const row = store.findAccount(username);
      return usable(row) ? accountIdentity(toAccount(row), departments) : null;
    },
    /**
     * 取得所有可使用帳號的身分（含管理員），依寫入順序。
     * @returns {Array<object>} 帳號身分陣列。
     * @throws {HttpError} 503 資料庫無法讀取。
     */
    list() {
      return usableAccounts().map(/** 轉成身分。@param {object} account 帳號。@returns {object} 身分。 */ (account) => accountIdentity(account, departments));
    },
    /**
     * 取得某個部門可指定的處理人：該部門啟用中的一般帳號，不含管理員；部門不存在時回傳空陣列。依寫入順序。
     * @param {string} departmentId 部門 id。
     * @returns {Array<{id: string, name: string}>} 處理人陣列。
     * @throws {HttpError} 503 資料庫無法讀取。
     */
    handlersOf(departmentId) {
      if (typeof departmentId !== 'string' || !departments.findDepartment(departmentId)) return [];
      return store.departmentAccounts(departmentId).map(/** 轉成處理人。@param {object} row 帳號列。@returns {object} 處理人。 */ (row) => accountHandler(toAccount(row)));
    },
    /**
     * 依處理人 id（即一般帳號）找出處理人與所屬部門；管理員、停用或部門已不存在的帳號一律視為不可指定。
     * @param {unknown} handlerId 處理人 id。
     * @returns {{handler: object, department: object}|null} 找不到或不可指定時回傳 null。
     * @throws {HttpError} 503 資料庫無法讀取。
     */
    findHandler(handlerId) {
      if (typeof handlerId !== 'string') return null;
      const row = store.findAccount(handlerId);
      if (!usable(row) || row.role !== 'USER') return null;
      return { handler: accountHandler(toAccount(row)), department: departments.findDepartment(row.department_id) };
    },
    /**
     * 列出 department_id 已不在部門設定檔的帳號（含已停用者），供啟動時記錄警告；這些帳號不能登入，也不能當處理人。
     * @returns {Array<{username: string, departmentId: string, active: boolean}>} 部門不存在的帳號，依寫入順序。
     * @throws {HttpError} 503 資料庫無法讀取。
     */
    missingDepartments() {
      return store.listAccounts()
        .filter(/** 部門不存在。@param {object} row 帳號列。@returns {boolean} 不存在時 true。 */ (row) => !departments.findDepartment(row.department_id))
        .map(/** 轉成報告形狀。@param {object} row 帳號列。@returns {object} username、departmentId、active。 */ (row) => ({ username: row.username, departmentId: row.department_id, active: row.active === 1 }));
    },
  };
}

/**
 * 建立帳號查詢服務。提供 accounts 時建立記憶體版本（測試注入假帳號，建立時驗證一次，全部視為啟用）；
 * 未提供時建立 SQLite 版本：帳號只存在資料庫，每次呼叫同步查詢，沒有帳號設定檔。
 * 兩種版本的介面相同：usernames、find、list、handlersOf、findHandler、missingDepartments。
 * @param {object} [options={}] 設定。
 * @param {Array<object>} [options.accounts] 已解析的帳號資料（username、department_id、選填 role）；提供時使用記憶體版本。
 * @param {object} [options.departments=departmentService] 部門查詢服務。
 * @param {object} [options.store=dataStore] SQLite 版本使用的儲存（需有 listAccounts、findAccount、departmentAccounts）。
 * @returns {object} 帳號查詢服務。
 * @throws {Error} 記憶體版本的帳號資料無效。
 */
export function createAccountService({ accounts, departments = departmentService, store = dataStore } = {}) {
  return accounts ? createMemoryAccountService({ accounts, departments }) : createSqliteAccountService({ store, departments });
}

export const accountService = createAccountService();
