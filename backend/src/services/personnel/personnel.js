import { LEAVE_TYPES } from '../storage/database.js';
import { isCalendarDate } from '../../utils/dates.js';

// 人員資料（帳號、所屬部門、角色、啟用狀態、員工基本資料與假別額度）只存在 SQLite；這個模組集中驗證規則與寫入操作，
// 服務啟動的示範名冊寫入（dataStore）、帳號查詢（accountService）與維運腳本 scripts/personnel.js 共用同一套規則。

// 帳號全小寫、格式為「名.姓」（可多段），例如 racky.huang；資料表 accounts 的 CHECK 限制與這個規則相同。
export const USERNAME_PATTERN = /^[a-z]+(?:\.[a-z]+)+$/;
export const ACCOUNT_ROLES = Object.freeze(['USER', 'ADMIN']);
const YEAR_PATTERN = /^\d{4}$/;
const MINUTES_PATTERN = /^\d+$/;

/**
 * 建立帶固定代碼的人員資料錯誤；訊息只指出欄位與原因，可含帳號名稱，不含員工姓名或員工編號的值。
 * @param {string} code 固定代碼：PERSONNEL_INVALID（格式不符）、PERSONNEL_NOT_FOUND（帳號或員工不存在）、
 *   PERSONNEL_CONFLICT（帳號或員工編號已存在）、PERSONNEL_SCHEMA_OLD（資料庫尚未升級）。
 * @param {string} message 中文說明。
 * @returns {Error} 帶 code 屬性的錯誤。
 */
export function personnelError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * 判斷值是否為一般物件（排除 null 與陣列）。
 * @param {unknown} value 待檢查的值。
 * @returns {boolean} 是一般物件時 true。
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 判斷帳號名稱是否符合「全小寫名.姓」格式。
 * @param {unknown} value 待檢查的值。
 * @returns {boolean} 符合時 true。
 */
export function isValidUsername(value) {
  return typeof value === 'string' && USERNAME_PATTERN.test(value);
}

/**
 * 驗證帳號陣列並整理成固定形狀；錯誤訊息只指出位置與原因，不輸出內容。
 * 規則：username 必填且符合「名.姓」格式、陣列內唯一；department_id 為非空白字串，requireDepartment 為 true 時必須存在於部門設定檔；
 * role 預設 USER，只接受 USER 或 ADMIN。
 * @param {unknown} raw 帳號陣列，每筆為 { username, department_id, role? }。
 * @param {object|null} departments 部門查詢服務（需有 findDepartment）；requireDepartment 為 false 時可為 null。
 * @param {object} [options={}] 選項。
 * @param {boolean} [options.requireDepartment=true] 是否要求部門存在；寫入示範名冊時為 false，部門已不存在的帳號改由啟動警告回報。
 * @returns {Array<{username: string, departmentId: string, role: string}>} 已正規化的帳號陣列，順序與輸入相同。
 * @throws {Error} 內容不是非空陣列、欄位缺漏或格式不符、帳號重複、部門不存在。
 */
export function normalizeAccounts(raw, departments, { requireDepartment = true } = {}) {
  if (!Array.isArray(raw) || !raw.length) throw personnelError('PERSONNEL_INVALID', '帳號資料必須是非空的帳號陣列');
  const seen = new Set();
  const accounts = [];
  for (const [index, item] of raw.entries()) {
    const where = `accounts[${index}]`;
    if (!isPlainObject(item)) throw personnelError('PERSONNEL_INVALID', `${where} 必須是物件`);
    if (!isValidUsername(item.username)) throw personnelError('PERSONNEL_INVALID', `${where}.username 必須是全小寫的「名.姓」格式`);
    if (seen.has(item.username)) throw personnelError('PERSONNEL_INVALID', `${where}.username 重複`);
    seen.add(item.username);
    if (typeof item.department_id !== 'string' || !item.department_id.trim()) throw personnelError('PERSONNEL_INVALID', `${where}.department_id 必須是部門設定檔中存在的部門 id`);
    if (requireDepartment && !departments.findDepartment(item.department_id)) {
      throw personnelError('PERSONNEL_INVALID', `${where}.department_id 必須是部門設定檔中存在的部門 id`);
    }
    const role = item.role ?? 'USER';
    if (!ACCOUNT_ROLES.includes(role)) throw personnelError('PERSONNEL_INVALID', `${where}.role 只接受 USER 或 ADMIN`);
    accounts.push({ username: item.username, departmentId: item.department_id, role });
  }
  return accounts;
}

/**
 * 取得「帳號 → 角色」對照：可傳入帳號查詢服務（需有 list，回傳身分）或已正規化的帳號陣列（username、role）。
 * @param {object|Array<{username: string, role: string}>} accounts 帳號來源。
 * @returns {Map<string, string>} 帳號對角色。
 */
function rolesOf(accounts) {
  const list = Array.isArray(accounts) ? accounts : accounts.list();
  return new Map(list.map(/** 取出帳號與角色。@param {{username: string, role: string}} account 帳號。@returns {[string, string]} [帳號, 角色]。 */ (account) => [account.username, account.role]));
}

/**
 * 驗證假別額度物件並轉成列陣列；以四位數年度為鍵，值是以假別（事假、病假、特休）為鍵的非負安全整數分鐘數。
 * @param {unknown} raw 額度物件，例如 { "2026": { 特休: 6720 } }。
 * @param {string} where 錯誤訊息中的位置前綴。
 * @returns {Array<{year: number, leaveType: string, minutes: number}>} 額度列。
 * @throws {Error} code PERSONNEL_INVALID：格式不符。
 */
export function normalizeEntitlements(raw, where) {
  if (!isPlainObject(raw)) throw personnelError('PERSONNEL_INVALID', `${where}.entitlements 必須是以年度為鍵的物件`);
  const entitlements = [];
  for (const [year, byType] of Object.entries(raw)) {
    if (!YEAR_PATTERN.test(year)) throw personnelError('PERSONNEL_INVALID', `${where}.entitlements 的鍵必須是四位數年度`);
    if (!isPlainObject(byType)) throw personnelError('PERSONNEL_INVALID', `${where}.entitlements.${year} 必須是以假別為鍵的物件`);
    for (const [leaveType, minutes] of Object.entries(byType)) {
      if (!LEAVE_TYPES.includes(leaveType)) throw personnelError('PERSONNEL_INVALID', `${where}.entitlements.${year} 只接受假別：${LEAVE_TYPES.join('、')}`);
      if (!Number.isSafeInteger(minutes) || minutes < 0) throw personnelError('PERSONNEL_INVALID', `${where}.entitlements.${year}.${leaveType} 必須是非負整數（分鐘）`);
      entitlements.push({ year: Number(year), leaveType, minutes });
    }
  }
  return entitlements;
}

/**
 * 驗證員工資料陣列並對照帳號，整理成固定形狀；錯誤訊息只指出位置與原因，不輸出內容。
 * 規則：
 * - 內容是陣列，每筆為物件；username 必須是對照帳號中的一般帳號（USER），不可為管理員或不存在的帳號，且不可重複；
 * - 對照帳號中的每個一般帳號恰有一筆資料（缺少任一帳號即失敗）；
 * - display_name、employee_no 為非空白字串，employee_no 陣列內唯一；hire_date 為實際存在的 YYYY-MM-DD；
 * - entitlements 見 normalizeEntitlements。
 * @param {unknown} raw 員工陣列，每筆為 { username, display_name, employee_no, hire_date, entitlements }。
 * @param {object|Array<{username: string, role: string}>} accounts 對照的帳號查詢服務（需有 list）或已正規化的帳號陣列。
 * @returns {Array<{username: string, displayName: string, employeeNo: string, hireDate: string, entitlements: Array<{year: number, leaveType: string, minutes: number}>}>} 已正規化的員工陣列。
 * @throws {Error} code PERSONNEL_INVALID：格式不符、帳號不符、缺漏或重複。
 */
export function normalizeEmployees(raw, accounts) {
  if (!Array.isArray(raw)) throw personnelError('PERSONNEL_INVALID', '員工資料必須是員工陣列');
  const roles = rolesOf(accounts);
  const seen = new Set();
  const numbers = new Set();
  const employees = [];
  for (const [index, item] of raw.entries()) {
    const where = `employees[${index}]`;
    if (!isPlainObject(item)) throw personnelError('PERSONNEL_INVALID', `${where} 必須是物件`);
    const role = typeof item.username === 'string' ? roles.get(item.username) : undefined;
    if (!role) throw personnelError('PERSONNEL_INVALID', `${where}.username 必須是帳號名冊中的帳號`);
    if (role !== 'USER') throw personnelError('PERSONNEL_INVALID', `${where}.username 不可為管理員帳號（管理員沒有員工資料）`);
    if (seen.has(item.username)) throw personnelError('PERSONNEL_INVALID', `${where}.username 重複`);
    seen.add(item.username);
    for (const field of ['display_name', 'employee_no']) {
      if (typeof item[field] !== 'string' || !item[field].trim()) throw personnelError('PERSONNEL_INVALID', `${where}.${field} 必須是非空白字串`);
    }
    if (numbers.has(item.employee_no)) throw personnelError('PERSONNEL_INVALID', `${where}.employee_no 重複`);
    numbers.add(item.employee_no);
    if (!isCalendarDate(item.hire_date)) throw personnelError('PERSONNEL_INVALID', `${where}.hire_date 必須是實際存在的 YYYY-MM-DD 日期`);
    const entitlements = normalizeEntitlements(item.entitlements, where);
    employees.push({ username: item.username, displayName: item.display_name, employeeNo: item.employee_no, hireDate: item.hire_date, entitlements });
  }
  for (const [username, role] of roles) {
    if (role === 'USER' && !seen.has(username)) throw personnelError('PERSONNEL_INVALID', `員工資料缺少一般帳號 ${username} 的資料`);
  }
  return employees;
}

/**
 * 驗證一份完整人員名冊（帳號＋員工），供全新資料庫寫入。規則同 normalizeAccounts 與 normalizeEmployees：
 * 每個一般帳號恰有一筆員工資料、管理員沒有員工資料。
 * @param {{accounts: unknown, employees: unknown}} raw 原始名冊（例如 demoPersonnelSeed() 或測試注入的假資料）。
 * @param {object} [options={}] 選項。
 * @param {object} [options.departments] 部門查詢服務；提供時要求每個帳號的部門存在，未提供時只檢查部門 id 為非空白字串。
 * @returns {{accounts: Array<object>, employees: Array<object>}} 已正規化的帳號與員工。
 * @throws {Error} code PERSONNEL_INVALID：名冊不是物件或任一欄位驗證失敗。
 */
export function normalizePersonnelSeed(raw, { departments } = {}) {
  if (!isPlainObject(raw)) throw personnelError('PERSONNEL_INVALID', '人員名冊必須是含 accounts 與 employees 的物件');
  const accounts = normalizeAccounts(raw.accounts, departments ?? null, { requireDepartment: Boolean(departments) });
  return { accounts, employees: normalizeEmployees(raw.employees ?? [], accounts) };
}

/**
 * 在呼叫端已開啟的交易內寫入一份已驗證的名冊：先寫員工資料，再寫帳號（啟用，一般帳號帶自己的員工編號）與各年度額度（以員工編號關聯）。
 * 使用一般 INSERT，重複時失敗而不是略過。
 * @param {import('better-sqlite3').Database} db 可寫入的連線，必須已在交易內。
 * @param {{accounts: Array<object>, employees: Array<object>}} seed normalizePersonnelSeed 的結果。
 * @param {string} at 寫入時間（ISO 8601），作為 created_at 與 updated_at。
 * @returns {{accounts: number, employees: number, entitlements: number}} 寫入筆數。
 * @throws {Error} SQLite 錯誤（例如 CHECK、UNIQUE 或外鍵限制不符）；交易由呼叫端回滾。
 */
function insertPersonnel(db, seed, at) {
  const insertAccount = db.prepare('INSERT INTO accounts (username, employee_no, department_id, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)');
  const insertEmployee = db.prepare('INSERT INTO employees (employee_no, display_name, hire_date) VALUES (?, ?, ?)');
  const insertEntitlement = db.prepare('INSERT INTO leave_entitlements (employee_no, leave_type, year, granted_minutes) VALUES (?, ?, ?, ?)');
  const added = { accounts: 0, employees: 0, entitlements: 0 };
  const numbers = new Map();
  for (const employee of seed.employees) {
    added.employees += insertEmployee.run(employee.employeeNo, employee.displayName, employee.hireDate).changes;
    numbers.set(employee.username, employee.employeeNo);
  }
  for (const account of seed.accounts) added.accounts += insertAccount.run(account.username, numbers.get(account.username) ?? null, account.departmentId, account.role, at, at).changes;
  for (const employee of seed.employees) {
    for (const entitlement of employee.entitlements) added.entitlements += insertEntitlement.run(employee.employeeNo, entitlement.leaveType, entitlement.year, entitlement.minutes).changes;
  }
  return added;
}

/**
 * 只在 accounts 資料表為空（全新資料庫）時寫入整份名冊；資料表已有任何帳號（含已停用者）時不做任何事，
 * 因此人資或維運腳本的調整永遠不會被名冊覆寫，刪掉的示範帳號也不會被補回。檢查與寫入在同一筆 IMMEDIATE 交易內，
 * 兩個程序同時開啟新檔時只有一個會寫入。
 * @param {import('better-sqlite3').Database} db 可寫入、結構版本 3 的連線。
 * @param {{accounts: Array<object>, employees: Array<object>}|null} seed 已驗證的名冊；null 時不寫入。
 * @param {string} [at=new Date().toISOString()] 寫入時間。
 * @returns {{accounts: number, employees: number, entitlements: number}} 本次寫入筆數；未寫入時皆為 0。
 * @throws {Error} SQLite 錯誤或取不到寫入鎖（SQLITE_BUSY）；交易整筆回滾。
 */
export function seedPersonnelIfEmpty(db, seed, at = new Date().toISOString()) {
  /** 在寫入鎖內確認帳號表為空後寫入。@returns {{accounts: number, employees: number, entitlements: number}} 寫入筆數。 */
  function run() {
    if (!seed || db.prepare('SELECT COUNT(*) AS total FROM accounts').get().total > 0) return { accounts: 0, employees: 0, entitlements: 0 };
    return insertPersonnel(db, seed, at);
  }
  return db.transaction(run).immediate();
}

/**
 * 依帳號的部門（accounts.department_id）與部門設定檔，同步 accounts.department_name（部門的中文名稱，結構版本 7 起）：
 * 名稱不同時才更新（不改 updated_at，因為帳號本身沒有變動），部門已不在設定檔時寫入空字串。
 * 這個欄位只是方便直接檢視資料庫，程式判斷部門一律用 department_id。必須在呼叫端已開啟的寫入交易內同步呼叫。
 * @param {import('better-sqlite3').Database} db 可寫入、結構版本 7 以上的連線。
 * @param {{findDepartment: Function}} departments 部門查詢服務。
 * @returns {number} 更新的帳號筆數。
 * @throws {Error} SQLite 錯誤；交易由呼叫端回滾。
 */
export function syncAccountDepartmentNames(db, departments) {
  const rows = db.prepare('SELECT username, department_id, department_name FROM accounts').all();
  const update = db.prepare('UPDATE accounts SET department_name = ? WHERE username = ?');
  let changed = 0;
  for (const row of rows) {
    const name = departments.findDepartment(row.department_id)?.name ?? '';
    if (name !== row.department_name) changed += update.run(name, row.username).changes;
  }
  return changed;
}

/**
 * 確認連線的資料庫已是包含人員資料表的結構版本；唯讀連線（預覽、列表）不會套用遷移，需要先由服務或非預覽指令升級。
 * @param {import('better-sqlite3').Database} db 資料庫連線。
 * @param {number} required 需要的最低 user_version。
 * @returns {void}
 * @throws {Error} code PERSONNEL_SCHEMA_OLD：版本較舊。
 */
export function assertPersonnelSchema(db, required) {
  const version = db.pragma('user_version', { simple: true });
  if (version < required) throw personnelError('PERSONNEL_SCHEMA_OLD', `資料庫結構版本 ${version} 尚未包含人員資料表，請先啟動後端一次或執行不含 --dry-run 的指令完成升級`);
}

/**
 * 把文字轉成非負安全整數（命令列參數用）；只接受純數字。
 * @param {unknown} text 參數文字。
 * @param {string} name 欄位名稱，用於錯誤訊息。
 * @returns {number} 整數值。
 * @throws {Error} code PERSONNEL_INVALID：不是非負整數。
 */
function parseCount(text, name) {
  const value = typeof text === 'string' && MINUTES_PATTERN.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value)) throw personnelError('PERSONNEL_INVALID', `${name} 必須是非負整數`);
  return value;
}

/**
 * 建立人員資料維運操作（scripts/personnel.js 與測試使用）：每個寫入操作在同一筆 IMMEDIATE 交易內重新讀取目前狀態、驗證並寫入；
 * dryRun 時只在讀取交易內計算「會改變什麼」，不寫入任何內容（可用唯讀連線）。驗證規則與服務相同（normalizeAccounts、normalizeEmployees、
 * normalizeEntitlements、部門設定檔），不提供刪除帳號：帳號只能停用，需求單保留歷史。
 * 執行中的服務每次請求都重新查詢資料庫，因此這裡提交後不需要重啟服務。
 * @param {import('better-sqlite3').Database} db 目前結構版本（5）的連線；只做預覽或列表時可為唯讀。
 * @param {object} options 依賴。
 * @param {object} options.departments 部門查詢服務（需有 findDepartment）。
 * @param {Function} [options.clock=Date.now] epoch 毫秒時間來源，用於 updated_at。
 * @returns {object} list、add、setDepartment、setActive、grant 操作。
 */
export function createPersonnelAdmin(db, { departments, clock = Date.now }) {
  const sql = {
    account: db.prepare('SELECT username, department_id, role, active FROM accounts WHERE username = ?'),
    employee: db.prepare('SELECT e.employee_no FROM accounts a JOIN employees e ON e.employee_no = a.employee_no WHERE a.username = ?'),
    employeeNo: db.prepare('SELECT employee_no FROM employees WHERE employee_no = ?'),
    entitlement: db.prepare('SELECT granted_minutes FROM leave_entitlements WHERE employee_no = ? AND leave_type = ? AND year = ?'),
  };

  /**
   * 執行一個操作：預覽時用讀取交易，正式執行時用 IMMEDIATE 交易（讀取、驗證與寫入在同一個寫入鎖內）。
   * @param {(write: boolean) => object} task 同步操作，write 為 false 時不得寫入；回傳結果摘要。
   * @param {boolean} dryRun 是否只預覽。
   * @returns {object} task 的結果，附上 dryRun。
   * @throws {Error} task 拋出的錯誤；交易整筆回滾。
   */
  function execute(task, dryRun) {
    /** 在交易內執行操作。@returns {object} 結果摘要。 */
    function run() { return { ...task(!dryRun), dryRun }; }
    const transaction = db.transaction(run);
    return dryRun ? transaction.deferred() : transaction.immediate();
  }

  /**
   * 讀取帳號列，不存在時拋錯。
   * @param {unknown} username 帳號。
   * @returns {{username: string, department_id: string, role: string, active: number}} 帳號列。
   * @throws {Error} code PERSONNEL_INVALID（格式不符）或 PERSONNEL_NOT_FOUND（不存在）。
   */
  function existingAccount(username) {
    if (!isValidUsername(username)) throw personnelError('PERSONNEL_INVALID', 'username 必須是全小寫的「名.姓」格式');
    const row = sql.account.get(username);
    if (!row) throw personnelError('PERSONNEL_NOT_FOUND', `找不到帳號 ${username}`);
    return row;
  }

  /**
   * 確認部門存在於部門設定檔。
   * @param {unknown} departmentId 部門 id。
   * @returns {string} 部門 id。
   * @throws {Error} code PERSONNEL_INVALID：部門不存在。
   */
  function existingDepartment(departmentId) {
    if (typeof departmentId !== 'string' || !departments.findDepartment(departmentId)) throw personnelError('PERSONNEL_INVALID', 'department_id 必須是部門設定檔中存在的部門 id');
    return departmentId;
  }

  return {
    /**
     * 列出帳號（含已停用者）與其員工資料、各年度額度，依寫入順序；可依部門 id 篩選（也可篩選已不存在於部門設定檔的部門）。
     * @param {object} [filter={}] 篩選條件。
     * @param {string} [filter.department] 部門 id。
     * @returns {Array<object>} username、department_id、department_missing、role、active、display_name、employee_no、hire_date、entitlements（{ 年度: { 假別: 分鐘 } }）。
     */
    list({ department } = {}) {
      /** 讀取帳號、員工與額度。@returns {{rows: Array<object>}} 列表。 */
      function read() {
        const accounts = db.prepare(`SELECT a.username, a.department_id, a.role, a.active, e.display_name, e.employee_no, e.hire_date
          FROM accounts a LEFT JOIN employees e ON e.employee_no = a.employee_no ORDER BY a.rowid`).all();
        const grants = db.prepare(`SELECT a.username, l.leave_type, l.year, l.granted_minutes FROM leave_entitlements l JOIN accounts a ON a.employee_no = l.employee_no
          ORDER BY a.username, l.year, l.leave_type`).all();
        return { rows: accounts.filter(/** 依部門篩選。@param {object} row 帳號列。@returns {boolean} 相符時 true。 */ (row) => department === undefined || row.department_id === department)
          .map(/** 組出列表列。@param {object} row 帳號列。@returns {object} 列表列。 */ (row) => {
            const entitlements = {};
            for (const grant of grants) {
              if (grant.username !== row.username) continue;
              entitlements[grant.year] = { ...entitlements[grant.year], [grant.leave_type]: grant.granted_minutes };
            }
            return { username: row.username, department_id: row.department_id, department_missing: !departments.findDepartment(row.department_id), role: row.role,
              active: row.active === 1, display_name: row.display_name ?? null, employee_no: row.employee_no ?? null, hire_date: row.hire_date ?? null, entitlements };
          }) };
      }
      return db.transaction(read).deferred().rows;
    },
    /**
     * 新增帳號。一般帳號（USER）必須同時提供員工資料（姓名、員工編號、到職日），管理員（ADMIN）不可提供；新員工沒有任何額度，請再以 grant 設定。
 * 寫入帳號時一併以 syncAccountDepartmentNames 填入部門的中文名稱。
     * @param {object} input 新帳號。
     * @param {string} input.username 帳號（全小寫「名.姓」）。
     * @param {string} input.department 部門 id。
     * @param {string} [input.role='USER'] USER 或 ADMIN。
     * @param {string} [input.name] 員工顯示名稱。
     * @param {string} [input.employeeNo] 員工編號（全庫唯一）。
     * @param {string} [input.hireDate] 到職日 YYYY-MM-DD。
     * @param {object} [options={}] 選項。
     * @param {boolean} [options.dryRun=false] 只預覽。
     * @returns {object} action、username、changed、changes（department_id、role、active、employee_profile）、dryRun。
     * @throws {Error} code PERSONNEL_INVALID（格式不符）、PERSONNEL_CONFLICT（帳號或員工編號已存在）。
     */
    add({ username, department, role = 'USER', name, employeeNo, hireDate }, { dryRun = false } = {}) {
      const [account] = normalizeAccounts([{ username, department_id: department, role }], departments);
      const profile = [name, employeeNo, hireDate];
      let employee = null;
      if (account.role === 'ADMIN') {
        if (profile.some(/** 是否提供了任一員工欄位。@param {unknown} value 欄位值。@returns {boolean} 有值時 true。 */ (value) => value !== undefined)) throw personnelError('PERSONNEL_INVALID', '管理員帳號沒有員工資料，請勿提供 --name、--employee-no、--hire-date');
      } else {
        [employee] = normalizeEmployees([{ username, display_name: name, employee_no: employeeNo, hire_date: hireDate, entitlements: {} }], [account]);
      }
      /** 檢查衝突後寫入帳號與員工資料。@param {boolean} write 是否寫入。@returns {object} 結果摘要。 */
      function task(write) {
        if (sql.account.get(account.username)) throw personnelError('PERSONNEL_CONFLICT', `帳號 ${account.username} 已存在；要恢復已停用的帳號請改用 activate`);
        if (employee && sql.employeeNo.get(employee.employeeNo)) throw personnelError('PERSONNEL_CONFLICT', '員工編號已被其他員工使用');
        if (write) {
          const at = new Date(clock()).toISOString();
          if (employee) db.prepare('INSERT INTO employees (employee_no, display_name, hire_date) VALUES (?, ?, ?)').run(employee.employeeNo, employee.displayName, employee.hireDate);
          db.prepare('INSERT INTO accounts (username, employee_no, department_id, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
            .run(account.username, employee?.employeeNo ?? null, account.departmentId, account.role, at, at);
          syncAccountDepartmentNames(db, departments);
        }
        return { action: 'add', username: account.username, changed: true,
          changes: { department_id: { from: null, to: account.departmentId }, role: { from: null, to: account.role }, active: { from: null, to: true }, employee_profile: { from: false, to: Boolean(employee) } } };
      }
      return execute(task, dryRun);
    },
    /**
     * 調整帳號的所屬部門；新部門必須存在於部門設定檔。部門相同時不寫入（changed 為 false），有變更時在同一筆交易內同步 accounts.department_name。
     * 執行中的服務下一個請求就會以新部門判斷處理人名單、代理人候選與簽核權限。
     * @param {string} username 帳號。
     * @param {string} departmentId 新部門 id。
     * @param {object} [options={}] 選項。
     * @param {boolean} [options.dryRun=false] 只預覽。
     * @returns {object} action、username、changed、changes（department_id）、dryRun。
     * @throws {Error} code PERSONNEL_INVALID、PERSONNEL_NOT_FOUND。
     */
    setDepartment(username, departmentId, { dryRun = false } = {}) {
      const target = existingDepartment(departmentId);
      /** 讀取目前部門並寫入新部門。@param {boolean} write 是否寫入。@returns {object} 結果摘要。 */
      function task(write) {
        const row = existingAccount(username);
        const changed = row.department_id !== target;
        if (write && changed) {
          db.prepare('UPDATE accounts SET department_id = ?, updated_at = ? WHERE username = ?').run(target, new Date(clock()).toISOString(), username);
          syncAccountDepartmentNames(db, departments);
        }
        return { action: 'set-department', username, changed, changes: changed ? { department_id: { from: row.department_id, to: target } } : {} };
      }
      return execute(task, dryRun);
    },
    /**
     * 停用或恢復帳號。停用後不能登入（既有憑證也立即失效），不列入處理人、代理人候選與簽核；需求單歷史保留。狀態相同時不寫入。
     * @param {string} username 帳號。
     * @param {boolean} active true 恢復、false 停用。
     * @param {object} [options={}] 選項。
     * @param {boolean} [options.dryRun=false] 只預覽。
     * @returns {object} action（activate／deactivate）、username、changed、changes（active）、dryRun。
     * @throws {Error} code PERSONNEL_INVALID、PERSONNEL_NOT_FOUND。
     */
    setActive(username, active, { dryRun = false } = {}) {
      const value = active ? 1 : 0;
      /** 讀取目前狀態並寫入新狀態。@param {boolean} write 是否寫入。@returns {object} 結果摘要。 */
      function task(write) {
        const row = existingAccount(username);
        const changed = row.active !== value;
        if (write && changed) db.prepare('UPDATE accounts SET active = ?, updated_at = ? WHERE username = ?').run(value, new Date(clock()).toISOString(), username);
        return { action: active ? 'activate' : 'deactivate', username, changed, changes: changed ? { active: { from: row.active === 1, to: Boolean(active) } } : {} };
      }
      return execute(task, dryRun);
    },
    /**
     * 設定員工某年度某假別的額度（取代原值，不是增減；本系統不記錄額度的增減，人資在公司既有的系統處理）。只適用有員工資料的一般帳號。
     * @param {string} username 帳號。
     * @param {string} leaveType 假別（事假、病假、特休）。
     * @param {string|number} year 四位數年度。
     * @param {string|number} minutes 非負整數分鐘數。
     * @param {object} [options={}] 選項。
     * @param {boolean} [options.dryRun=false] 只預覽。
     * @returns {object} action、username、changed、changes（entitlement：leave_type、year、from、to）、dryRun。
     * @throws {Error} code PERSONNEL_INVALID、PERSONNEL_NOT_FOUND（帳號或員工資料不存在）。
     */
    grant(username, leaveType, year, minutes, { dryRun = false } = {}) {
      const amount = typeof minutes === 'number' ? minutes : parseCount(minutes, 'minutes');
      const [entry] = normalizeEntitlements({ [String(year)]: { [leaveType]: amount } }, 'grant');
      /** 讀取原額度並寫入新額度。@param {boolean} write 是否寫入。@returns {object} 結果摘要。 */
      function task(write) {
        existingAccount(username);
        const employeeNo = sql.employee.get(username)?.employee_no;
        if (!employeeNo) throw personnelError('PERSONNEL_NOT_FOUND', `帳號 ${username} 沒有員工資料（管理員或尚未建立），無法設定額度`);
        const before = sql.entitlement.get(employeeNo, entry.leaveType, entry.year)?.granted_minutes ?? null;
        const changed = before !== entry.minutes;
        if (write && changed) {
          db.prepare(`INSERT INTO leave_entitlements (employee_no, leave_type, year, granted_minutes) VALUES (?, ?, ?, ?)
            ON CONFLICT (employee_no, leave_type, year) DO UPDATE SET granted_minutes = excluded.granted_minutes`).run(employeeNo, entry.leaveType, entry.year, entry.minutes);
        }
        return { action: 'grant', username, changed, changes: changed ? { entitlement: { leave_type: entry.leaveType, year: entry.year, from: before, to: entry.minutes } } : {} };
      }
      return execute(task, dryRun);
    },
  };
}
