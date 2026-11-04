// ============================================================================
// 示範人員名冊（全部是假資料，與任何真實人員、員工編號或密碼無關）。
//
// 帳號、所屬部門、角色、員工基本資料與假別額度只存在 SQLite（accounts、employees、leave_entitlements）；
// 這份名冊不是執行中的資料來源，只在兩個時機使用：
//   1. 開啟資料庫時 accounts 資料表為空（全新資料庫）：整份寫入一次（dataStore 的 seedPersonnelIfEmpty）。
//      資料表已有任何帳號時永遠不再寫入，也不覆寫人資或維運腳本的調整。
//   2. 結構版本 2 → 3 升級：版本 2 只有 employees，沒有帳號表；依這份名冊替既有員工補上帳號與所屬部門，
//      並補上名冊中的管理員帳號（管理員沒有員工資料，無法由 employees 推得）。
// 之後的新增、調部門、停用或額度調整請使用 scripts/personnel.js，不要修改這個檔案來改變既有資料庫。
// ============================================================================

// 每位示範員工 2026、2027 年度的額度（分鐘）：特休 112 小時、事假 112 小時、病假 240 小時。
const DEMO_GRANTS = Object.freeze({ 特休: 6720, 事假: 6720, 病假: 14400 });
const DEMO_YEARS = Object.freeze(['2026', '2027']);

// [帳號, 所屬部門 id, 顯示名稱, 員工編號, 到職日]；16 組一般帳號，每個部門兩組（後 6 組是為請假代理人補上的）。
const DEMO_USERS = Object.freeze([
  ['racky.huang', 'dept-it-1', '示範員工甲', 'T-0001', '2019-03-01'],
  ['cindy.wang', 'dept-it-2', '示範員工乙', 'T-0002', '2020-07-15'],
  ['emily.wu', 'dept-hr-1', '示範員工丙', 'T-0003', '2018-09-03'],
  ['frank.liu', 'dept-hr-1', '示範員工丁', 'T-0004', '2021-02-01'],
  ['grace.tsai', 'dept-ga-1', '示範員工戊', 'T-0005', '2017-05-08'],
  ['henry.yang', 'dept-ga-1', '示範員工己', 'T-0006', '2022-10-17'],
  ['amy.chen', 'dept-fin-1', '示範員工庚', 'T-0007', '2016-11-21'],
  ['brian.lin', 'dept-pur-1', '示範員工辛', 'T-0008', '2023-04-10'],
  ['david.lee', 'dept-legal-1', '示範員工壬', 'T-0009', '2015-08-24'],
  ['ivy.chang', 'dept-it-3', '示範員工癸', 'T-0010', '2024-01-08'],
  ['kevin.ho', 'dept-it-1', '示範員工子', 'T-0011', '2025-06-02'],
  ['lisa.kao', 'dept-it-2', '示範員工丑', 'T-0012', '2024-09-16'],
  ['mike.su', 'dept-it-3', '示範員工寅', 'T-0013', '2025-03-03'],
  ['nina.lo', 'dept-fin-1', '示範員工卯', 'T-0014', '2023-11-13'],
  ['oscar.wei', 'dept-pur-1', '示範員工辰', 'T-0015', '2022-05-23'],
  ['paula.hsu', 'dept-legal-1', '示範員工巳', 'T-0016', '2021-08-30'],
]);

/**
 * 產生示範員工的假別額度物件（以年度為鍵、假別為鍵的分鐘數），每次回傳新物件，避免呼叫端修改共用常數。
 * @returns {Record<string, Record<string, number>>} 例如 { "2026": { 特休: 6720, 事假: 6720, 病假: 14400 }, "2027": {...} }。
 */
function demoEntitlements() {
  return Object.fromEntries(DEMO_YEARS.map(/** 建立單一年度的額度。@param {string} year 四位數年度。@returns {[string, object]} [年度, 額度]。 */ (year) => [year, { ...DEMO_GRANTS }]));
}

// 示範帳號（與資料表欄位同名的原始形狀）：16 組一般帳號在前，獨立管理員 alex.admin 在最後（管理員沒有員工資料、不是處理人）。
export const DEMO_ACCOUNTS = Object.freeze([
  ...DEMO_USERS.map(/** 轉成帳號列。@param {string[]} row 名冊列。@returns {object} username、department_id、role。 */ ([username, departmentId]) => Object.freeze({ username, department_id: departmentId, role: 'USER' })),
  Object.freeze({ username: 'alex.admin', department_id: 'dept-it-1', role: 'ADMIN' }),
]);

/**
 * 取得完整示範名冊的新複本（原始形狀，尚未驗證）：accounts 為 { username, department_id, role }，
 * employees 為 { username, display_name, employee_no, hire_date, entitlements }。
 * 呼叫端（dataStore）會以 personnel.js 的 normalizePersonnelSeed 驗證後才寫入資料庫。
 * @returns {{accounts: Array<object>, employees: Array<object>}} 可自由修改的複本。
 */
export function demoPersonnelSeed() {
  return {
    accounts: DEMO_ACCOUNTS.map(/** 複製帳號列。@param {object} account 帳號。@returns {object} 複本。 */ (account) => ({ ...account })),
    employees: DEMO_USERS.map(/** 轉成員工資料。@param {string[]} row 名冊列。@returns {object} 員工原始資料。 */ ([username, , displayName, employeeNo, hireDate]) => ({
      username, display_name: displayName, employee_no: employeeNo, hire_date: hireDate, entitlements: demoEntitlements() })),
  };
}
