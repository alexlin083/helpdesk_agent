import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { departmentService } from './departmentService.js';

const defaultConfigFile = fileURLToPath(new URL('../data/accounts.json', import.meta.url));
// 帳號全小寫、格式為「名.姓」（可多段），例如 racky.huang。
const USERNAME_PATTERN = /^[a-z]+(?:\.[a-z]+)+$/;

/**
 * 驗證帳號設定檔並整理成固定形狀；錯誤訊息只指出位置與原因，不輸出檔案內容。
 * 規則：username 必填且符合「名.姓」格式、全檔唯一；department_id 必填且必須存在於部門設定檔；role 預設 USER，只接受 USER 或 ADMIN。
 * @param {unknown} raw 解析後的 JSON 內容。
 * @param {object} departments 部門查詢服務，用來確認 department_id 存在。
 * @returns {Array<{username: string, departmentId: string, role: string}>} 已正規化的帳號陣列。
 * @throws {Error} 內容不是陣列、欄位缺漏或格式不符、帳號重複、部門不存在。
 */
export function normalizeAccounts(raw, departments) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('帳號設定檔必須是非空的帳號陣列');
  const seen = new Set();
  const accounts = [];
  for (const [index, item] of raw.entries()) {
    const where = `accounts[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where} 必須是物件`);
    if (typeof item.username !== 'string' || !USERNAME_PATTERN.test(item.username)) throw new Error(`${where}.username 必須是全小寫的「名.姓」格式`);
    if (seen.has(item.username)) throw new Error(`${where}.username 重複`);
    seen.add(item.username);
    if (typeof item.department_id !== 'string' || !departments.findDepartment(item.department_id)) {
      throw new Error(`${where}.department_id 必須是部門設定檔中存在的部門 id`);
    }
    const role = item.role ?? 'USER';
    if (!['USER', 'ADMIN'].includes(role)) throw new Error(`${where}.role 只接受 USER 或 ADMIN`);
    accounts.push({ username: item.username, departmentId: item.department_id, role });
  }
  return accounts;
}

/**
 * 讀取並解析帳號設定檔；JSON 語法錯誤時只回報檔案無法解析，不輸出內容。
 * @param {string} file 設定檔絕對路徑。
 * @param {object} departments 部門查詢服務。
 * @returns {Array<object>} 已驗證的帳號陣列。
 * @throws {Error} 檔案不存在、JSON 無法解析或內容驗證失敗。
 */
function loadAccountsFile(file, departments) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
    throw new Error(`無法讀取或解析帳號設定檔（${error.code || error.name}）`);
  }
  return normalizeAccounts(parsed, departments);
}

/**
 * 建立帳號查詢服務：課堂帳號、管理員角色與所屬部門，資料在建立時驗證一次。
 * 一般帳號同時就是「可指定的處理人」，管理員不參與工作單流程：處理人 id 即帳號名稱，顯示名稱也是帳號名稱。
 * @param {object} [options={}] 設定。
 * @param {Array<object>} [options.accounts] 已解析的帳號資料（username、department_id、選填 role）；未提供時讀取預設設定檔。
 * @param {object} [options.departments=departmentService] 部門查詢服務。
 * @returns {object} usernames、find、list、handlersOf、findHandler 操作。
 * @throws {Error} 設定內容無效時啟動失敗。
 */
export function createAccountService({ accounts, departments = departmentService } = {}) {
  const data = accounts ? normalizeAccounts(accounts, departments) : loadAccountsFile(defaultConfigFile, departments);
  const byName = new Map(data.map((account) => [account.username, account]));
  /**
   * 組出對外的帳號身分，附上所屬部門的 id 與名稱。
   * @param {object} account 內部帳號資料。
   * @returns {object} username、userID、role 與 department；權限僅取自後端設定。
   */
  function identity(account) {
    const department = departments.findDepartment(account.departmentId);
    return { username: account.username, userID: `user-${account.username}`, role: account.role, department: { id: department.id, name: department.name } };
  }
  /**
   * 把帳號轉成處理人形狀（id 與 name 都是帳號名稱）。
   * @param {object} account 內部帳號資料。
   * @returns {{id: string, name: string}} 處理人。
   */
  function handler(account) { return { id: account.username, name: account.username }; }
  return {
    /** 全部帳號名稱，順序與設定檔相同。 */
    usernames: Object.freeze(data.map((account) => account.username)),
    /**
     * 依帳號查詢身分；區分大小寫，不做正規化。
     * @param {unknown} username 帳號。
     * @returns {object|null} username、userID、role、department，查無時回傳 null。
     */
    find(username) {
      const account = typeof username === 'string' ? byName.get(username) : undefined;
      return account ? identity(account) : null;
    },
    /** 取得所有帳號身分。@returns {Array<object>} 帳號陣列。 */
    list() { return data.map(identity); },
    /**
     * 取得某個部門可指定的處理人（該部門的一般帳號，不含管理員），順序與設定檔相同。
     * @param {string} departmentId 部門 id。
     * @returns {Array<{id: string, name: string}>} 處理人陣列。
     */
    handlersOf(departmentId) {
      /** 篩選部門相符的一般帳號，排除管理員。@param {object} account 後端設定帳號。@returns {boolean} 是否可指定。 */
      function belongsToDepartment(account) { return account.departmentId === departmentId && account.role === 'USER'; }
      return data.filter(belongsToDepartment).map(handler);
    },
    /**
     * 依處理人 id（即一般帳號）找出處理人與所屬部門；管理員一律視為不可指定。
     * @param {unknown} handlerId 處理人 id。
     * @returns {{handler: object, department: object}|null} 找不到時回傳 null。
     */
    findHandler(handlerId) {
      const account = typeof handlerId === 'string' ? byName.get(handlerId) : undefined;
      return account?.role === 'USER' ? { handler: handler(account), department: departments.findDepartment(account.departmentId) } : null;
    },
  };
}

export const accountService = createAccountService();
