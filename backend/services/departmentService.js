import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_KEYWORD = 'IT資訊服務台';
const defaultConfigFile = fileURLToPath(new URL('../data/departments.json', import.meta.url));

/** 檢查非空白字串。@param {unknown} value 待驗證值。@returns {boolean} 是否為有效字串。 */
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * 驗證部門設定檔內容並整理成固定形狀；錯誤訊息只指出位置與原因，不輸出檔案內容。
 * 規則：id、name、duty、business 必填；type 缺漏視為空字串；部門 id 全檔唯一；
 * business 含「IT資訊服務台」的預設部門必須恰有一個。處理人改由帳號設定檔（accounts.json）決定，不再寫在這裡。
 * @param {unknown} raw 解析後的 JSON 內容。
 * @returns {Array<object>} 已正規化的部門陣列（id、name、type、duty、business）。
 * @throws {Error} 內容不是陣列、欄位缺漏或型別不符、識別碼重複、仍含 handlers 欄位、預設部門不是恰好一個。
 */
export function normalizeDepartments(raw) {
  if (!Array.isArray(raw)) throw new Error('部門設定檔必須是部門陣列');
  const departmentIds = new Set();
  const departments = [];
  let defaultCount = 0;
  for (const [index, item] of raw.entries()) {
    const where = `departments[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where} 必須是物件`);
    for (const field of ['id', 'name', 'duty']) {
      if (!nonempty(item[field])) throw new Error(`${where}.${field} 必須是非空白字串`);
    }
    if (item.type !== undefined && typeof item.type !== 'string') throw new Error(`${where}.type 必須是字串`);
    if (!Array.isArray(item.business) || !item.business.length) throw new Error(`${where}.business 必須是非空陣列`);
    for (const [position, keyword] of item.business.entries()) {
      if (!nonempty(keyword)) throw new Error(`${where}.business[${position}] 必須是非空白字串`);
    }
    if (item.handlers !== undefined) throw new Error(`${where}.handlers 已改由帳號設定檔（accounts.json）決定，請移除這個欄位`);
    if (departmentIds.has(item.id)) throw new Error(`${where}.id 重複`);
    departmentIds.add(item.id);
    if (item.business.includes(DEFAULT_KEYWORD)) defaultCount += 1;
    departments.push({ id: item.id, name: item.name, type: item.type ?? '', duty: item.duty, business: [...item.business] });
  }
  if (defaultCount !== 1) throw new Error(`部門設定檔必須恰有一個 business 含「${DEFAULT_KEYWORD}」的預設部門，目前有 ${defaultCount} 個`);
  return departments;
}

/**
 * 讀取並解析部門設定檔；JSON 語法錯誤時只回報檔案無法解析，不輸出內容。
 * @param {string} [file=defaultConfigFile] 設定檔絕對路徑。
 * @returns {Array<object>} 已驗證的部門陣列。
 * @throws {Error} 檔案不存在、JSON 無法解析或內容驗證失敗。
 */
export function loadDepartmentsFile(file = defaultConfigFile) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
    throw new Error(`無法讀取或解析部門設定檔（${error.code || error.name}）`);
  }
  return normalizeDepartments(parsed);
}

/**
 * 建立部門查詢服務；資料在建立時驗證一次，之後所有查詢都回傳複本，避免呼叫端修改內部狀態。
 * @param {object} [options={}] 設定。
 * @param {Array<object>} [options.departments] 已解析的部門資料；未提供時讀取預設設定檔。
 * @returns {object} list、forJudge、findDepartment、defaultDepartment 操作。
 * @throws {Error} 設定內容無效時啟動失敗。
 */
export function createDepartmentService({ departments } = {}) {
  const data = departments ? normalizeDepartments(departments) : loadDepartmentsFile();
  const fallback = data.find((department) => department.business.includes(DEFAULT_KEYWORD));
  /** 複製單一部門，避免外部修改。@param {object} department 部門。@returns {object} 深複本。 */
  function clone(department) { return structuredClone(department); }
  return {
    /** 取得所有部門（id、name、type、duty、business），不含處理人。@returns {Array<object>} 部門複本。 */
    list() { return data.map(clone); },
    /** 取得交給 Gemini 的部門資料，不含 type。@returns {Array<object>} id、name、duty、business。 */
    forJudge() { return data.map(({ id, name, duty, business }) => ({ id, name, duty, business: [...business] })); },
    /** 依部門 id 查詢。@param {unknown} id 部門識別碼。@returns {object|null} 部門複本或 null。 */
    findDepartment(id) {
      const found = typeof id === 'string' ? data.find((department) => department.id === id) : undefined;
      return found ? clone(found) : null;
    },
    /** 取得接收對不到部門需求單的預設部門。@returns {object} 預設部門複本。 */
    defaultDepartment() { return clone(fallback); },
  };
}

export const departmentService = createDepartmentService();
