import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, chmodSync, renameSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { DEMO_ACCOUNTS } from '../personnel/demoPersonnel.js';

const require = createRequire(import.meta.url);

// 'HDK1'：寫入資料庫標頭，還原時用來辨識是否為本服務的資料庫檔。
export const APPLICATION_ID = 0x48444b31;
export const SCHEMA_VERSION = 8;
export const MINIMUM_NODE = '22.14.0';
// 資料表 CHECK 限制允許的假別；使用 leave_entitlements 的需求類型定義（類別欄位的選項）與員工假別額度都必須只使用這三種（registry 依 LEDGER_TABLES 檢查）。
export const LEAVE_TYPES = Object.freeze(['事假', '病假', '特休']);

// 需求類型定義的 ledger.entitlement_table 只能使用這裡列出的資料表（允許清單）；欄位名稱固定寫在程式內，
// 不由設定檔決定，因此可以安全地組成 SQL。categories 為資料表 CHECK 限制允許的類別，定義的類別欄位選項必須是它的子集。
// 剩餘只由額度表的年度額度決定；需求單的送出、簽核、退回與取消都不寫入額度資料表，額度的扣除與調整由人資在公司既有的系統處理
// （結構版本 5 移除額度異動紀錄 leave_log，版本 6 移除人資調整紀錄 leave_adjustments）。
export const LEDGER_TABLES = Object.freeze({
  leave_entitlements: Object.freeze({
    owner: 'employee_no', category: 'leave_type', period: 'year', amount: 'granted_minutes', categories: LEAVE_TYPES,
    // 呼叫端以帳號查詢額度；額度表以員工編號關聯（結構版本 8），由這段固定的子查詢把帳號換成員工編號（參數為帳號）
    ownerByUsername: '(SELECT employee_no FROM accounts WHERE username = ?)',
  }),
});

// 依序套用的資料庫結構；索引 i 會把 user_version 從 i 升到 i+1，已發布的項目不可修改，只能往後新增。
const MIGRATIONS = Object.freeze([
  // 1：需求單整份以 JSON 文件保存，維持既有欄位順序與 API 形狀；seq 保留建立順序。
  `CREATE TABLE tickets (
     seq INTEGER PRIMARY KEY,
     ticket_id TEXT NOT NULL UNIQUE,
     document TEXT NOT NULL CHECK (json_valid(document))
   ) STRICT;
   CREATE TABLE meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`,
  // 2：員工基本資料、各年度假別額度與人資調整紀錄；剩餘時數由需求單（請假表單）即時計算，不另存使用量。
  `CREATE TABLE employees (
     username TEXT PRIMARY KEY,
     display_name TEXT NOT NULL,
     employee_no TEXT NOT NULL UNIQUE,
     hire_date TEXT NOT NULL,
     active INTEGER NOT NULL DEFAULT 1
   ) STRICT;
   CREATE TABLE leave_entitlements (
     username TEXT NOT NULL REFERENCES employees (username),
     leave_type TEXT NOT NULL CHECK (leave_type IN ('事假', '病假', '特休')),
     year INTEGER NOT NULL,
     granted_minutes INTEGER NOT NULL CHECK (granted_minutes >= 0),
     PRIMARY KEY (username, leave_type, year)
   ) STRICT;
   CREATE TABLE leave_adjustments (
     id INTEGER PRIMARY KEY,
     username TEXT NOT NULL,
     leave_type TEXT NOT NULL,
     year INTEGER NOT NULL,
     delta_minutes INTEGER NOT NULL,
     reason TEXT NOT NULL,
     by_user_id TEXT NOT NULL,
     at TEXT NOT NULL
   ) STRICT;
   CREATE INDEX leave_adjustments_lookup ON leave_adjustments (username, year, leave_type);`,
  // 3：人員資料只存資料庫（見 migrateToVersion3）。
  migrateToVersion3,
  // 4：請假額度異動紀錄 leave_log，並以既有需求單與人資調整回填（見 migrateToVersion4）
  migrateToVersion4,
  // 5：移除 leave_log；需求單的送出與簽核不再寫入任何額度相關資料表
  'DROP TABLE leave_log;',
  // 6：移除人資調整紀錄 leave_adjustments（連同索引）；額度的扣除與調整由人資在公司既有的系統處理，本系統只保留年度額度 leave_entitlements
  'DROP TABLE leave_adjustments;',
  // 7：accounts 加上所屬部門的中文名稱 department_name（接在最後一欄），方便直接檢視資料庫；只供顯示，程式判斷部門一律用 department_id，
  // 名稱由開啟資料庫時與人員維運操作依部門設定檔同步（見 personnel.js 的 syncAccountDepartmentNames）
  "ALTER TABLE accounts ADD COLUMN department_name TEXT NOT NULL DEFAULT '';",
  // 8：人員資料改以員工編號 employee_no 關聯（見 migrateToVersion8）
  migrateToVersion8,
]);

// 需要在交易外暫時關閉 foreign_keys 的遷移（重建被其他資料表參照的資料表；SQLite 不允許在交易內切換 foreign_keys）。
const REBUILD_STEPS = new Set([migrateToVersion3, migrateToVersion8]);

// username 的 CHECK 等同 /^[a-z]+(?:\.[a-z]+)+$/：只含 a-z 與點、以字母開頭與結尾、至少一個點且沒有連續的點。
const VERSION_3_SQL = `CREATE TABLE accounts (
     username TEXT PRIMARY KEY CHECK (username NOT GLOB '*[^a-z.]*' AND username GLOB '[a-z]*.*[a-z]' AND username NOT GLOB '*..*'),
     department_id TEXT NOT NULL CHECK (department_id <> ''),
     role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
     active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   ) STRICT;
   CREATE INDEX accounts_department ON accounts (department_id, role, active);
   CREATE TRIGGER accounts_no_delete BEFORE DELETE ON accounts
   BEGIN SELECT RAISE(ABORT, 'accounts 不可刪除，請改為停用（active = 0）'); END;`;

// 版本 3 的 employees：以 username 外鍵參照 accounts；啟用狀態改由 accounts.active 決定，因此移除版本 2 的 employees.active。
const VERSION_3_EMPLOYEES_SQL = `CREATE TABLE employees_v3 (
     username TEXT PRIMARY KEY REFERENCES accounts (username),
     display_name TEXT NOT NULL,
     employee_no TEXT NOT NULL UNIQUE,
     hire_date TEXT NOT NULL
   ) STRICT;
   INSERT INTO employees_v3 (username, display_name, employee_no, hire_date) SELECT username, display_name, employee_no, hire_date FROM employees ORDER BY rowid;
   DROP TABLE employees;
   ALTER TABLE employees_v3 RENAME TO employees;
   CREATE TRIGGER employees_not_admin BEFORE INSERT ON employees
   WHEN (SELECT role FROM accounts WHERE username = NEW.username) = 'ADMIN'
   BEGIN SELECT RAISE(ABORT, '管理員帳號沒有員工資料'); END;`;

// 版本 8：人員資料改以員工編號關聯。employees 以 employee_no 為主鍵；accounts 以 employee_no 參照員工資料（管理員沒有員工資料，必須為 NULL），
// department_name 移到 department_id 旁邊；leave_entitlements 以 (employee_no, leave_type, year) 為主鍵並參照 employees。
// 依 SQLite 建議的步驟建立新表、複製資料（維持原本的寫入順序）、刪除舊表再改名，最後重建索引與禁止刪除帳號的觸發器。
const VERSION_8_SQL = `CREATE TABLE employees_v8 (
     employee_no TEXT PRIMARY KEY CHECK (employee_no <> ''),
     display_name TEXT NOT NULL,
     hire_date TEXT NOT NULL
   ) STRICT;
   INSERT INTO employees_v8 (employee_no, display_name, hire_date) SELECT employee_no, display_name, hire_date FROM employees ORDER BY rowid;
   CREATE TABLE accounts_v8 (
     username TEXT PRIMARY KEY CHECK (username NOT GLOB '*[^a-z.]*' AND username GLOB '[a-z]*.*[a-z]' AND username NOT GLOB '*..*'),
     employee_no TEXT UNIQUE REFERENCES employees (employee_no),
     department_id TEXT NOT NULL CHECK (department_id <> ''),
     department_name TEXT NOT NULL DEFAULT '',
     role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
     active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     CHECK (role = 'USER' OR employee_no IS NULL)
   ) STRICT;
   INSERT INTO accounts_v8 (username, employee_no, department_id, department_name, role, active, created_at, updated_at)
     SELECT a.username, e.employee_no, a.department_id, a.department_name, a.role, a.active, a.created_at, a.updated_at
     FROM accounts a LEFT JOIN employees e ON e.username = a.username ORDER BY a.rowid;
   CREATE TABLE leave_entitlements_v8 (
     employee_no TEXT NOT NULL REFERENCES employees (employee_no),
     leave_type TEXT NOT NULL CHECK (leave_type IN ('事假', '病假', '特休')),
     year INTEGER NOT NULL,
     granted_minutes INTEGER NOT NULL CHECK (granted_minutes >= 0),
     PRIMARY KEY (employee_no, leave_type, year)
   ) STRICT;
   INSERT INTO leave_entitlements_v8 (employee_no, leave_type, year, granted_minutes)
     SELECT e.employee_no, l.leave_type, l.year, l.granted_minutes FROM leave_entitlements l JOIN employees e ON e.username = l.username ORDER BY l.rowid;
   DROP TABLE leave_entitlements;
   DROP TABLE employees;
   DROP TABLE accounts;
   ALTER TABLE employees_v8 RENAME TO employees;
   ALTER TABLE accounts_v8 RENAME TO accounts;
   ALTER TABLE leave_entitlements_v8 RENAME TO leave_entitlements;
   CREATE INDEX accounts_department ON accounts (department_id, role, active);
   CREATE TRIGGER accounts_no_delete BEFORE DELETE ON accounts
   BEGIN SELECT RAISE(ABORT, 'accounts 不可刪除，請改為停用（active = 0）'); END;`;

/**
 * 結構版本 8：人員資料改以員工編號 employee_no 關聯（帳號 username 只是登入名稱，可能因同名或改名而變動，員工編號才是人資的穩定識別碼）：
 * employees 以 employee_no 為主鍵（不再存 username）；accounts 加上 employee_no（唯一，參照 employees；管理員必須為 NULL）並把 department_name
 * 移到 department_id 旁邊；leave_entitlements 改以 (employee_no, leave_type, year) 為主鍵並參照 employees。
 * 在 migrate 開啟的 IMMEDIATE 交易內、foreign_keys 已於交易外暫時關閉時執行；帳號、員工與額度的資料與順序都不變，
 * 已送出的需求單仍以帳號記錄提單人，不改寫。migrate 會在提交前執行 foreign_key_check，有任何違反就回滾。
 * @param {import('better-sqlite3').Database} db 可寫入的連線，必須已在交易內、foreign_keys 為 OFF。
 * @returns {void}
 * @throws {Error} SQLite 錯誤（例如 CHECK 限制不符）；交易回滾，資料庫維持版本 7。
 */
function migrateToVersion8(db) {
  db.exec(VERSION_8_SQL);
}

/**
 * 結構版本 3：帳號、所屬部門、角色與啟用狀態改存 accounts 資料表，人員資料不再保留 JSON 檔。
 * 流程（在 migrate 開啟的 IMMEDIATE 交易內，foreign_keys 已於交易外暫時關閉）：
 * 1. 建立 accounts（帳號不可刪除，只能停用；需求單保留歷史）與索引。
 * 2. 版本 2 的資料庫若已有 employees 列，依示範名冊（demoPersonnel.js）替每位員工建立帳號：所屬部門取名冊中同名帳號的部門，
 *    啟用狀態沿用 employees.active；任何員工帳號不在名冊的一般帳號中時，整步回滾並以 PERSONNEL_UNMAPPED 拒絕（無法判斷所屬部門）。
 *    同時補上名冊中的管理員帳號（管理員沒有員工資料，無法由 employees 推得，版本 2 時定義在已刪除的 accounts.json）。
 *    employees 為空（版本 1 升級或全新資料庫）時不建立任何帳號，改由開啟資料庫後的 seedPersonnelIfEmpty 寫入整份名冊。
 * 3. 依 SQLite 建議的步驟重建 employees，加上參照 accounts 的外鍵並移除 employees.active；leave_entitlements 仍以名稱參照 employees。
 * migrate 會在提交前執行 foreign_key_check，有任何違反就回滾。
 * @param {import('better-sqlite3').Database} db 可寫入的連線，必須已在交易內、foreign_keys 為 OFF。
 * @returns {void}
 * @throws {Error} code PERSONNEL_UNMAPPED：既有員工帳號無法對應名冊；SQLite 錯誤（例如 CHECK 限制不符）。
 */
function migrateToVersion3(db) {
  db.exec(VERSION_3_SQL);
  const employees = db.prepare('SELECT username, active FROM employees ORDER BY rowid').all();
  if (employees.length) {
    const roster = new Map(DEMO_ACCOUNTS.map(/** 建立名冊索引。@param {object} account 名冊帳號。@returns {[string, object]} [帳號, 名冊帳號]。 */ (account) => [account.username, account]));
    const unmapped = employees.filter(/** 找出無法對應名冊一般帳號的員工。@param {{username: string}} row 員工列。@returns {boolean} 無法對應時 true。 */ (row) => roster.get(row.username)?.role !== 'USER');
    if (unmapped.length) {
      const sample = unmapped.slice(0, 3).map(/** 取帳號。@param {{username: string}} row 員工列。@returns {string} 帳號。 */ (row) => row.username).join('、');
      throw storageError('PERSONNEL_UNMAPPED', `employees 有 ${unmapped.length} 筆帳號不在示範名冊（例如 ${sample}），無法自動決定所屬部門；請以升級前的備份處理或先移除這些員工資料`);
    }
    const at = new Date().toISOString();
    const insert = db.prepare('INSERT INTO accounts (username, department_id, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of employees) insert.run(row.username, roster.get(row.username).department_id, 'USER', row.active === 0 ? 0 : 1, at, at);
    for (const account of DEMO_ACCOUNTS) if (account.role === 'ADMIN') insert.run(account.username, account.department_id, 'ADMIN', 1, at, at);
  }
  db.exec(VERSION_3_EMPLOYEES_SQL);
}

// 版本 4 的請假額度異動紀錄：數量與剩餘都以分鐘為單位；minutes 為本次異動的分鐘數（請假為請假時數，ADJUSTED、GRANTED 為增減的額度，可為負）；
// remaining_before_minutes／remaining_after_minutes 為異動前後的剩餘（額度＋調整－已核准－待簽核）；
// 需求單事件有 ticket_id、type_id 與請假起訖，ADJUSTED 有 adjustment_id；source 為 live（服務寫入）或 backfill（升級時由既有資料回填）
const VERSION_4_SQL = `CREATE TABLE leave_log (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     event TEXT NOT NULL CHECK (event IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'ADJUSTED', 'GRANTED')),
     username TEXT NOT NULL,
     leave_type TEXT NOT NULL CHECK (leave_type IN ('事假', '病假', '特休')),
     year INTEGER NOT NULL,
     minutes INTEGER NOT NULL,
     start_at TEXT,
     end_at TEXT,
     remaining_before_minutes INTEGER NOT NULL,
     remaining_after_minutes INTEGER NOT NULL,
     ticket_id TEXT,
     type_id TEXT,
     adjustment_id INTEGER,
     by_username TEXT NOT NULL,
     comment TEXT,
     source TEXT NOT NULL CHECK (source IN ('live', 'backfill'))
   ) STRICT;
   CREATE INDEX leave_log_employee ON leave_log (username, year, leave_type, id);
   CREATE INDEX leave_log_ticket ON leave_log (ticket_id);`;

// 回填時採用的需求單歷程事件與它們對待簽核、已核准數量的影響
const TICKET_LOG_EVENTS = new Set(['SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED']);

/**
 * 從需求單取出回填用的額度資料：優先用送出時保存的 form.ledger 快照；沒有快照的請假版本 1 舊單
 * （form.id 為 leave、計算結果為 { minutes, year }）改取當時固定的欄位；類別不是三種假別或資料不完整時不回填
 * @param {object} ticket 需求單文件
 * @returns {{username: string, category: string, period: number, amount: number, start: string|null, end: string|null}|null} 額度資料；不屬於請假額度時 null
 */
function backfillEntry(ticket) {
  const form = ticket?.form;
  const username = ticket?.requester?.username;
  if (!form || typeof username !== 'string') return null;
  const snapshot = form.ledger;
  let entry = null;
  if (snapshot && typeof snapshot === 'object') {
    entry = { category: snapshot.category, period: snapshot.period, amount: snapshot.amount, start: snapshot.start ?? null, end: snapshot.end ?? null };
  } else if (form.id === 'leave' && form.computed && !Array.isArray(form.computed)) {
    const start = form.fields?.start_at ?? null;
    entry = { category: form.fields?.leave_type, period: form.computed.year ?? Number(String(start ?? '').slice(0, 4)), amount: form.computed.minutes, start, end: form.fields?.end_at ?? null };
  }
  if (!entry || !LEAVE_TYPES.includes(entry.category) || !Number.isInteger(entry.period) || !Number.isInteger(entry.amount)) return null;
  return { username, ...entry };
}

/**
 * 結構版本 4：建立請假額度異動紀錄 leave_log，並依時間順序重播既有資料回填（source 為 backfill）：
 * 1. 每張請假需求單的歷程（送出、簽核、退回、取消）各成一個事件，額度資料見 backfillEntry；轉單不影響額度，不記錄；
 * 2. leave_adjustments 的每筆人資調整成一個 ADJUSTED 事件（操作者為 by_user_id 去掉 user- 前綴）；
 * 3. 依事件時間排序（同一時間維持需求單、歷程的原始順序），以 leave_entitlements 目前的額度為起點，
 *    逐筆計算剩餘（額度＋調整－已核准－待簽核）並寫入異動前後的值；年度額度沒有變更歷史，一律以目前的額度計算
 * 類別不是三種假別的人資調整不回填（leave_log 的 CHECK 只允許三種假別）
 * @param {import('better-sqlite3').Database} db 可寫入的連線，必須已在交易內
 * @returns {void}
 * @throws {Error} SQLite 錯誤；交易回滾，資料庫維持版本 3
 */
function migrateToVersion4(db) {
  db.exec(VERSION_4_SQL);
  const granted = new Map();
  for (const row of db.prepare('SELECT username, leave_type, year, granted_minutes FROM leave_entitlements').all()) {
    granted.set(`${row.username}|${row.leave_type}|${row.year}`, row.granted_minutes);
  }
  const events = [];
  for (const row of db.prepare('SELECT document FROM tickets ORDER BY seq').all()) {
    const ticket = JSON.parse(row.document);
    const entry = backfillEntry(ticket);
    if (!entry) continue;
    for (const item of Array.isArray(ticket.history) ? ticket.history : []) {
      if (!TICKET_LOG_EVENTS.has(item?.event) || typeof item.at !== 'string') continue;
      events.push({ ...entry, at: item.at, event: item.event, ticketId: ticket.ticket_id, typeId: ticket.form.id, adjustmentId: null,
        by: item.by_username ?? ticket.requester.username, comment: item.comment ?? null });
    }
  }
  for (const row of db.prepare('SELECT id, username, leave_type, year, delta_minutes, reason, by_user_id, at FROM leave_adjustments ORDER BY id').all()) {
    if (!LEAVE_TYPES.includes(row.leave_type)) continue;
    events.push({ username: row.username, category: row.leave_type, period: row.year, amount: row.delta_minutes, start: null, end: null, at: row.at, event: 'ADJUSTED',
      ticketId: null, typeId: null, adjustmentId: row.id, by: String(row.by_user_id).replace(/^user-/u, ''), comment: row.reason });
  }
  const ordered = events.map(/** 記下原始順序。@param {object} event 事件。@param {number} index 順序。@returns {object} 事件。 */ (event, index) => ({ ...event, index }))
    .sort(/** 依時間排序，同時間維持原始順序。@param {object} a 事件。@param {object} b 事件。@returns {number} 比較結果。 */ (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.index - b.index));
  const states = new Map();
  const insert = db.prepare(`INSERT INTO leave_log (at, event, username, leave_type, year, minutes, start_at, end_at, remaining_before_minutes, remaining_after_minutes,
    ticket_id, type_id, adjustment_id, by_username, comment, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill')`);
  for (const event of ordered) {
    const key = `${event.username}|${event.category}|${event.period}`;
    if (!states.has(key)) states.set(key, { granted: granted.get(key) ?? 0, adjusted: 0, used: 0, pending: 0 });
    const state = states.get(key);
    /** 目前剩餘。@returns {number} 額度＋調整－已核准－待簽核。 */
    const remaining = () => state.granted + state.adjusted - state.used - state.pending;
    const before = remaining();
    if (event.event === 'SUBMITTED') state.pending += event.amount;
    else if (event.event === 'APPROVED') { state.pending -= event.amount; state.used += event.amount; }
    else if (event.event === 'ADJUSTED') state.adjusted += event.amount;
    else state.pending -= event.amount;
    insert.run(event.at, event.event, event.username, event.category, event.period, event.amount, event.start, event.end, before, remaining(),
      event.ticketId, event.typeId, event.adjustmentId, event.by, event.comment);
  }
}

/**
 * 建立帶固定代碼的儲存錯誤；代碼寫進日誌供排查，訊息不含需求單原文。
 * @param {string} code 固定代碼，例如 NODE_TOO_OLD、FOREIGN_DATABASE、SCHEMA_TOO_NEW。
 * @param {string} message 中文說明。
 * @returns {Error} 帶 code 屬性的錯誤。
 */
function storageError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * 把資料列的 document 欄位解析回需求單物件。
 * @param {{document: string}} row 查詢結果列。
 * @returns {object} 需求單。
 */
export function parseTicketRow(row) {
  return JSON.parse(row.document);
}

/**
 * 確認目前 Node 版本可載入 better-sqlite3 13（需要 Node-API 10，即 Node 22.14 以上）。
 * @param {string} [version=process.versions.node] 要檢查的版本字串（不含 v）。
 * @returns {void}
 * @throws {Error} code NODE_TOO_OLD：版本低於 22.14.0，訊息說明應升級的版本。
 */
export function assertSupportedNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 14)) {
    throw storageError('NODE_TOO_OLD', `需求單資料庫需要 Node.js ${MINIMUM_NODE} 以上，目前為 ${version}；請依 .nvmrc 升級`);
  }
}

/**
 * 以 600 權限預先建立空的資料庫檔，讓 SQLite 之後建立的 -wal／-shm 沿用相同權限。
 * 不會建立上層目錄，避免設定錯誤時在意外位置產生資料夾。
 * @param {string} file 要建立的檔案路徑，必須不存在。
 * @returns {void}
 * @throws {Error} code DIRECTORY_MISSING：上層目錄不存在；其他檔案系統錯誤原樣拋出。
 */
function createPrivateFile(file) {
  try { closeSync(openSync(file, 'wx', 0o600)); } catch (error) {
    if (error.code === 'ENOENT') throw storageError('DIRECTORY_MISSING', '資料庫檔的上層目錄不存在，請先建立或修正 DATABASE_FILE');
    throw error;
  }
}

/**
 * 讀取檔案身分（application_id）、結構版本（user_version）與非系統物件數量。
 * 三個值必須在同一筆交易（同一個快照）內讀取；呼叫端負責開啟交易，否則另一個程序可能在兩次讀取之間提交初始化，
 * 讀到「application_id 仍為 0、但已有資料表」這種不存在的中間組合。
 * @param {import('better-sqlite3').Database} db 資料庫連線，必須已在交易內。
 * @returns {{applicationId: number, version: number, objects: number}} 讀到的三個值。
 */
function readIdentity(db) {
  return {
    applicationId: db.pragma('application_id', { simple: true }),
    version: db.pragma('user_version', { simple: true }),
    objects: db.prepare("SELECT COUNT(*) AS total FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get().total,
  };
}

/**
 * 確認讀到的身分屬於本服務：application_id 為 HDK1，或是完全空白的新檔（application_id、user_version 皆為 0 且沒有任何物件）；
 * 結構版本不可比程式支援的新。
 * @param {{applicationId: number, version: number, objects: number}} identity readIdentity 在單一快照內讀到的值。
 * @returns {void}
 * @throws {Error} code FOREIGN_DATABASE：其他程式的 SQLite 檔；SCHEMA_TOO_NEW：結構版本比程式新。
 */
function assertOwnDatabase({ applicationId, version, objects }) {
  if (applicationId !== APPLICATION_ID && (applicationId !== 0 || version !== 0 || objects !== 0)) {
    throw storageError('FOREIGN_DATABASE', '不是需求單資料庫檔，拒絕開啟以免改動其他程式的資料');
  }
  if (version > SCHEMA_VERSION) throw storageError('SCHEMA_TOO_NEW', `資料庫結構版本 ${version} 比程式支援的 ${SCHEMA_VERSION} 新，請改用對應版本的映像`);
}

// 切換 WAL 時遇到 SQLITE_BUSY 的重試上限（毫秒），與連線的 busy timeout 相同。
const WAL_SWITCH_TIMEOUT_MS = 5000;

/**
 * 把連線切換成 WAL 日誌模式。新檔仍是 rollback 日誌模式時，切換需要獨佔鎖；多個程序同時初始化同一個新檔時，
 * SQLite 為避免死結會直接回 SQLITE_BUSY 而不經過 busy timeout，因此這裡自行以短暫、帶隨機抖動的同步等待重試，
 * 直到成功或超過 WAL_SWITCH_TIMEOUT_MS。已是 WAL 模式時這個 PRAGMA 不需要等鎖，會立即完成。
 * @param {import('better-sqlite3').Database} db 可寫入、檔案型的資料庫連線。
 * @returns {void}
 * @throws {Error} SQLITE_BUSY 以外的 SQLite 錯誤立即拋出；逾時仍取不到鎖時拋出最後一次的 SQLITE_BUSY。
 * 副作用：重試期間以 Atomics.wait 阻塞目前執行緒（每次最多約 25 毫秒），只發生在啟動或維運腳本開檔時。
 */
function enableWal(db) {
  const deadline = Date.now() + WAL_SWITCH_TIMEOUT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (error) {
      if (error?.code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw error;
      Atomics.wait(sleeper, 0, 0, 5 + Math.floor(Math.random() * 20));
    }
  }
}

/**
 * 開啟（必要時建立）需求單 SQLite 資料庫：先檢查檔案身分與結構版本，通過後才設定 PRAGMA 並依序套用結構遷移，
 * 避免誤指到其他程式的 SQLite 檔時改動它。新建的檔案權限為 600（-wal／-shm 沿用）。
 * 身分、版本與物件數量在同一筆讀取交易內讀取，得到一致的快照：多個程序同時初始化同一個新檔時，
 * 只會看到「完全空白」或「已初始化為 HDK1」兩種狀態，不會因讀到另一個程序提交前後混合的值而誤判 FOREIGN_DATABASE。
 * 晚一步建立檔案的程序遇到 EEXIST 視為檔案已由他方建立，照常開啟；結構遷移在 IMMEDIATE 交易內重新確認身分與版本，
 * 不會重複建立資料表，也不會在檢查之後才被換成其他程式的檔案時改動它；切換 WAL 時遇到同時初始化造成的 SQLITE_BUSY 會短暫重試（enableWal）。
 * @param {string} file 資料庫檔的絕對路徑，或測試用的 ':memory:'。
 * @param {object} [options={}] 開啟選項。
 * @param {boolean} [options.readonly=false] 唯讀開啟（備份驗證、預覽用），不設定 PRAGMA、不套用遷移也不寫入標頭。
 * @returns {import('better-sqlite3').Database} 已就緒的資料庫連線，同步 API。
 * @throws {Error} code NODE_TOO_OLD、DIRECTORY_MISSING、FOREIGN_DATABASE、SCHEMA_TOO_NEW，或 SQLite 錯誤（例如 SQLITE_NOTADB、SQLITE_CANTOPEN、SQLITE_BUSY）。
 */
export function openTicketDatabase(file, { readonly = false } = {}) {
  assertSupportedNode();
  const Database = require('better-sqlite3');
  const inMemory = file === ':memory:';
  if (!inMemory && !readonly && !existsSync(file)) {
    try { createPrivateFile(file); } catch (error) {
      // 另一個程序剛好先建立了同一個檔案；交給下方的身分檢查與遷移處理。
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const db = new Database(file, { readonly, fileMustExist: !inMemory, timeout: 5000 });
  try {
    const identity = db.transaction(readIdentity).deferred(db);
    assertOwnDatabase(identity);
    const { version } = identity;
    db.pragma('foreign_keys = ON');
    if (!readonly) {
      if (!inMemory) enableWal(db);
      db.pragma('synchronous = NORMAL');
      // 需求單含原文，刪除時覆寫頁面內容，避免清空後仍殘留在檔案的空閒頁面。
      db.pragma('secure_delete = ON');
      migrate(db, version);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * 從指定版本起依序套用尚未執行的遷移；每一步與 user_version 更新放在同一筆 IMMEDIATE 交易，失敗時整步回滾。
 * 傳入的版本只是交易外讀到的起點，可能已過時（例如另一個程序同時初始化同一個新檔）：每一步取得寫入鎖後
 * 重新讀取檔案身分、user_version 與物件數量，已套用過的步驟直接略過，因此不會出現「table tickets already exists」；
 * 鎖內讀到的身分不屬於本服務（其他程式的檔案）或版本比程式新時拒絕，不寫入任何內容。
 * 遷移項目可以是 SQL 字串，或接收連線的函式（例如版本 3 需要依既有資料建立帳號）。重建資料表的步驟（REBUILD_STEPS）依 SQLite 建議，
 * 在交易外暫時關閉 foreign_keys，並在提交前以 foreign_key_check 確認沒有違反外鍵，結束後恢復原本的 foreign_keys 設定。
 * @param {import('better-sqlite3').Database} db 可寫入的資料庫連線。
 * @param {number} version 交易外讀到的 user_version，作為開始檢查的步驟。
 * @returns {void}
 * @throws {Error} code FOREIGN_DATABASE、SCHEMA_TOO_NEW（寫入鎖內重新檢查未通過）、FOREIGN_KEY_VIOLATION（重建後外鍵不一致）、
 *   PERSONNEL_UNMAPPED（版本 3 無法替既有員工決定部門），任一遷移失敗，或在逾時內取不到寫入鎖（SQLITE_BUSY）。
 */
export function migrate(db, version) {
  for (let step = version; step < MIGRATIONS.length; step += 1) {
    const migration = MIGRATIONS[step];
    const rebuild = REBUILD_STEPS.has(migration);
    /**
     * 在寫入鎖內重新確認身分與版本；尚未套用時執行這一步遷移並更新版本與檔案身分，已套用時不做任何事。
     * @returns {void}
     * @throws {Error} code FOREIGN_DATABASE、SCHEMA_TOO_NEW：鎖內讀到的檔案不屬於本服務；FOREIGN_KEY_VIOLATION：重建後外鍵不一致；拋出時交易回滾。
     */
    function apply() {
      const identity = readIdentity(db);
      assertOwnDatabase(identity);
      if (identity.version > step) return;
      if (typeof migration === 'function') migration(db); else db.exec(migration);
      if (rebuild && db.pragma('foreign_key_check').length) throw storageError('FOREIGN_KEY_VIOLATION', `結構版本 ${step + 1} 遷移後外鍵不一致，已回滾`);
      db.pragma(`application_id = ${APPLICATION_ID}`);
      db.pragma(`user_version = ${step + 1}`);
    }
    const foreignKeys = rebuild ? db.pragma('foreign_keys', { simple: true }) : 0;
    if (rebuild) db.pragma('foreign_keys = OFF');
    try { db.transaction(apply).immediate(); } finally {
      if (rebuild && foreignKeys) db.pragma('foreign_keys = ON');
    }
  }
}

/**
 * 讀取 meta 表中以 JSON 保存的值。
 * @param {import('better-sqlite3').Database} db 資料庫連線。
 * @param {string} name 項目名稱。
 * @returns {object|null} 解析後的值，不存在時 null。
 */
function readMeta(db, name) {
  const row = db.prepare('SELECT value FROM meta WHERE name = ?').get(name);
  return row ? JSON.parse(row.value) : null;
}

/**
 * 寫入或取代 meta 表中的項目。
 * @param {import('better-sqlite3').Database} db 可寫入的資料庫連線。
 * @param {string} name 項目名稱。
 * @param {object} value 以 JSON 保存的值。
 * @returns {void}
 */
function writeMeta(db, name, value) {
  db.prepare('INSERT INTO meta (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value').run(name, JSON.stringify(value));
}

/**
 * 取得 meta 表中保存的隨機秘密值；不存在（或格式不符）時產生 32 bytes 隨機值（64 個十六進位字元）寫入後回傳。
 * 讀取與寫入在同一筆 IMMEDIATE 交易內完成，多個程序同時第一次取得時只會有一個值。
 * 用於本機未設定 AUTH_SECRET 時的登入簽章金鑰，讓 node --watch 等重新啟動後既有登入仍有效；值不寫入日誌。
 * @param {import('better-sqlite3').Database} db 可寫入的資料庫連線。
 * @param {string} name meta 項目名稱。
 * @returns {string} 64 個十六進位字元的秘密值。
 * @throws {Error} SQLite 讀寫失敗。
 */
export function ensureMetaSecret(db, name) {
  /** 在交易內讀取既有值，沒有時產生並寫入。@returns {string} 秘密值。 */
  function readOrCreate() {
    const current = readMeta(db, name);
    if (typeof current === 'string' && /^[0-9a-f]{64}$/.test(current)) return current;
    const created = randomBytes(32).toString('hex');
    writeMeta(db, name, created);
    return created;
  }
  return db.transaction(readOrCreate).immediate();
}

// 舊版需求單可接受的狀態；與 dataStore.TICKET_STATUSES 相同，這裡另列以免兩個模組互相引用。
const LEGACY_STATUSES = Object.freeze(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);

/**
 * 判斷值是否為一般物件（排除 null 與陣列）。
 * @param {unknown} value 要檢查的值。
 * @returns {boolean} 是一般物件時 true。
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 判斷值是否為非空白字串：型別為字串，且去掉前後空白後仍有內容。
 * @param {unknown} value 要檢查的值。
 * @returns {boolean} 是非空白字串時 true；空字串、只有空白或非字串時 false。
 */
function isFilledString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 判斷 decision 欄位是否可安全使用：必須是 null（尚未簽核）或一般物件；物件含 at 屬性時 at 必須是非空白字串，
 * 因為已完成列表以 decision?.at ?? updated_at 排序並換算日期，數字或 null 以外的型別會讓端點回 500。
 * 缺少 decision 欄位（undefined）視為格式不符，正式寫入的需求單一律帶有這個欄位。
 * @param {object} ticket 需求單。
 * @returns {boolean} 符合時 true。
 */
function hasValidDecision(ticket) {
  if (ticket.decision === null) return true;
  if (!isPlainObject(ticket.decision)) return false;
  return !Object.hasOwn(ticket.decision, 'at') || isFilledString(ticket.decision.at);
}

// API 列表、排序與異動端點依賴的欄位；每項為 [欄位名稱, 檢查函式]，名稱只用於錯誤訊息。字串欄位一律不可為空或只有空白。
const LEGACY_REQUIRED_FIELDS = Object.freeze([
  ['created_at', /** 建立時間必須是非空白字串。@param {object} ticket 需求單。@returns {boolean} 是否符合。 */ (ticket) => isFilledString(ticket.created_at)],
  ['updated_at', /** 更新時間必須是非空白字串。@param {object} ticket 需求單。@returns {boolean} 是否符合。 */ (ticket) => isFilledString(ticket.updated_at)],
  ['subject', /** 主題必須是非空白字串（列表、搜尋與詳情都會顯示）。@param {object} ticket 需求單。@returns {boolean} 是否符合。 */ (ticket) => isFilledString(ticket.subject)],
  ['status', /** 狀態必須是四種固定值之一。@param {object} ticket 需求單。@returns {boolean} 是否符合。 */ (ticket) => LEGACY_STATUSES.includes(ticket.status)],
  ['department_id', /** 部門代碼必須是非空白字串。@param {object} ticket 需求單。@returns {boolean} 是否符合。 */ (ticket) => isFilledString(ticket.department_id)],
  ['department_name', /** 部門名稱必須是非空白字串。@param {object} ticket 需求單。@returns {boolean} 是否符合。 */ (ticket) => isFilledString(ticket.department_name)],
  ['requester', /** 申請人必須是物件。@param {object} ticket 需求單。@returns {boolean} 是否符合。 */ (ticket) => isPlainObject(ticket.requester)],
  ['requester.user_id', /** 申請人代碼必須是非空白字串。@param {object} ticket 需求單。@returns {boolean} 是否符合。 */ (ticket) => isFilledString(ticket.requester.user_id)],
  ['history', /** 歷程必須是陣列。@param {object} ticket 需求單。@returns {boolean} 是否符合。 */ (ticket) => Array.isArray(ticket.history)],
  ['decision', /** 簽核結果必須是 null 或物件，at 存在時為非空白字串。@param {object} ticket 需求單。@returns {boolean} 是否符合。 */ hasValidDecision],
]);

/**
 * 驗證舊版 JSON 需求單內容：必須是陣列，每筆是物件、ticket_id 為不重複的非空白字串且前後不可有空白，並具備 API 依賴的欄位：
 * 非空白字串 created_at／updated_at／subject、狀態為 PENDING／APPROVED／REJECTED／CANCELLED、非空白字串 department_id／department_name、
 * requester 物件含非空白字串 user_id、陣列 history，以及 decision 為 null 或物件（at 存在時為非空白字串）；
 * 缺少這些欄位的需求單匯入後會讓列表、排序與異動端點回 500。空字串或只有空白的字串一律視為缺少。
 * 錯誤只指出索引與欄位名稱，不輸出欄位值或需求單原文。
 * @param {unknown} tickets 解析後的 JSON 內容。
 * @returns {object[]} 驗證通過的需求單陣列。
 * @throws {Error} code LEGACY_INVALID：格式不符。
 */
function validateLegacyTickets(tickets) {
  if (!Array.isArray(tickets)) throw storageError('LEGACY_INVALID', '舊版需求單檔不是 JSON 陣列');
  const seen = new Set();
  for (const [index, ticket] of tickets.entries()) {
    if (!isPlainObject(ticket)) throw storageError('LEGACY_INVALID', `第 ${index} 筆不是物件`);
    if (!isFilledString(ticket.ticket_id)) throw storageError('LEGACY_INVALID', `第 ${index} 筆缺少 ticket_id`);
    // 單號前後有空白時，以單號查詢、簽核或取消的端點永遠找不到這筆需求單。
    if (ticket.ticket_id !== ticket.ticket_id.trim()) throw storageError('LEGACY_INVALID', `第 ${index} 筆的 ticket_id 欄位前後不可有空白`);
    if (seen.has(ticket.ticket_id)) throw storageError('LEGACY_INVALID', `第 ${index} 筆的 ticket_id 重複`);
    for (const [field, valid] of LEGACY_REQUIRED_FIELDS) {
      if (!valid(ticket)) throw storageError('LEGACY_INVALID', `第 ${index} 筆的 ${field} 欄位缺少或格式不符`);
    }
    seen.add(ticket.ticket_id);
  }
  return tickets;
}

/**
 * 把舊版 tickets.json 一次性匯入資料庫，可重複執行；舊檔維持原狀作為回滾來源。
 * 正式匯入時，匯入紀錄與筆數的檢查、全部寫入與讀回比對都在同一筆 IMMEDIATE 交易內完成，
 * 避免兩個程序同時判斷「尚未匯入」而重複匯入；任何不一致都整批回滾。預覽（dryRun）只用讀取交易，可在唯讀連線執行。
 * 判斷順序：
 * 1. 已有 tickets.json 匯入紀錄：舊檔相同回報 already-imported、改動回報 legacy-changed，無法讀取只回報 legacy-unreadable，不讓服務啟動失敗。
 * 2. 完全沒有匯入紀錄：才會自動匯入；資料庫已有需求單時以 LEGACY_CONFLICT 拒絕合併。
 * 3. 匯入紀錄為 source:'none'（初始化時沒有舊檔）而之後出現舊檔：不論資料庫內容一律回報 legacy-appeared、不自動匯入，
 *    避免管理端清空資料後重啟又把過期的舊單匯回來；只有明確指定 importLate（腳本的 --import-late）且資料表為空時才匯入，
 *    並在同一筆交易內以 tickets.json 紀錄取代 none 紀錄；資料表不是空的時以 LEGACY_CONFLICT 拒絕。
 * @param {import('better-sqlite3').Database} db 資料庫連線；dryRun 時可為唯讀連線。
 * @param {object} options 匯入選項。
 * @param {string} options.legacyFile 舊版 JSON 檔路徑。
 * @param {boolean} [options.dryRun=false] 只驗證並回報筆數，不寫入資料庫。
 * @param {boolean} [options.importLate=false] 明確同意匯入在 none 紀錄之後才出現的舊檔；只供維運腳本使用，服務啟動時不得開啟。
 * @returns {object} status（imported、would-import、already-imported、legacy-changed、legacy-appeared、legacy-unreadable、no-legacy-file）、count、sha256，無法讀取時另有 errorCode。
 * @throws {Error} code LEGACY_UNREADABLE、LEGACY_INVALID、LEGACY_CONFLICT（資料庫已有需求單但不能合併），讀回比對不一致，或取不到寫入鎖（SQLITE_BUSY）。
 */
export function importLegacyTickets(db, { legacyFile, dryRun = false, importLate = false }) {
  /**
   * 在交易內依匯入紀錄、舊檔與資料表筆數決定結果，必要時寫入需求單與匯入紀錄。
   * @returns {object} 與 importLegacyTickets 相同的結果摘要。
   * @throws {Error} 與 importLegacyTickets 相同的錯誤；拋出時交易整筆回滾。
   */
  function run() {
    const marker = readMeta(db, 'legacy_import');
    let text;
    try { text = readFileSync(legacyFile, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') {
        if (marker) return { status: 'already-imported', count: marker.count, sha256: marker.sha256 };
        if (!dryRun) writeMeta(db, 'legacy_import', { source: 'none', count: 0, at: new Date().toISOString() });
        return { status: 'no-legacy-file', count: 0 };
      }
      if (marker) return { status: 'legacy-unreadable', count: marker.count, sha256: marker.sha256, errorCode: error.code };
      throw storageError('LEGACY_UNREADABLE', `舊版需求單檔無法讀取（${error.code}）`);
    }
    const sha256 = createHash('sha256').update(text).digest('hex');
    if (marker && marker.source !== 'none') return { status: marker.sha256 === sha256 ? 'already-imported' : 'legacy-changed', count: marker.count, sha256 };
    // none 紀錄之後才出現的舊檔：只回報，除非維運人員明確指定 importLate。
    if (marker && !importLate) return { status: 'legacy-appeared', count: 0, sha256 };
    // Windows 編輯器另存時可能加上 UTF-8 BOM；去掉後再解析，雜湊仍以原始內容計算。
    const json = text.replace(/^﻿/, '');
    let parsed;
    try { parsed = JSON.parse(json); } catch { throw storageError('LEGACY_INVALID', '舊版需求單檔不是有效的 JSON'); }
    const tickets = validateLegacyTickets(parsed);
    const existing = db.prepare('SELECT COUNT(*) AS total FROM tickets').get().total;
    if (existing > 0) throw storageError('LEGACY_CONFLICT', marker ? '資料庫已有需求單，拒絕匯入之後才出現的舊檔' : '資料庫已有需求單但沒有匯入紀錄，拒絕合併');
    if (dryRun) return { status: 'would-import', count: tickets.length, sha256 };
    const insert = db.prepare('INSERT INTO tickets (ticket_id, document) VALUES (?, ?)');
    for (const ticket of tickets) insert.run(ticket.ticket_id, JSON.stringify(ticket));
    const readBack = db.prepare('SELECT document FROM tickets ORDER BY seq').all().map(parseTicketRow);
    if (!isDeepStrictEqual(readBack, JSON.parse(json))) throw new Error('匯入後讀回的資料與原檔不一致');
    writeMeta(db, 'legacy_import', { source: 'tickets.json', count: tickets.length, sha256, at: new Date().toISOString() });
    return { status: 'imported', count: tickets.length, sha256 };
  }
  const transaction = db.transaction(run);
  return dryRun ? transaction.deferred() : transaction.immediate();
}

/**
 * 依建立順序匯出全部需求單，形狀與舊版 tickets.json 相同，供回滾到 JSON 版映像。
 * 以 600 權限新建暫存檔寫入後改名；輸出檔或殘留的暫存檔已存在時拒絕，不覆寫。
 * @param {import('better-sqlite3').Database} db 資料庫連線。
 * @param {string} output 輸出的 JSON 檔路徑。
 * @returns {number} 匯出筆數。
 * @throws {Error} code OUTPUT_EXISTS：輸出檔或暫存檔已存在；其他寫入錯誤原樣拋出。
 */
export function exportTicketsJson(db, output) {
  const temporary = `${output}.tmp`;
  if (existsSync(output) || existsSync(temporary)) throw storageError('OUTPUT_EXISTS', '輸出檔或暫存檔已存在，請指定新的路徑');
  const tickets = db.prepare('SELECT document FROM tickets ORDER BY seq').all().map(parseTicketRow);
  writeFileSync(temporary, `${JSON.stringify(tickets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temporary, output);
  return tickets.length;
}

/**
 * 以 VACUUM INTO 產生一致的線上備份（含 WAL 中已提交的內容），再以唯讀方式開啟驗證完整性。
 * 備份檔先以 600 權限建立成空檔再寫入；備份失敗時刪除這個空檔。
 * @param {import('better-sqlite3').Database} db 來源資料庫連線，可在服務執行中使用（唯讀連線亦可）。
 * @param {string} output 備份檔路徑，必須不存在。
 * @returns {object} tickets（筆數）、schemaVersion。
 * @throws {Error} code OUTPUT_EXISTS、DIRECTORY_MISSING，備份失敗或完整性檢查未通過。
 */
export function backupTicketDatabase(db, output) {
  if (existsSync(output)) throw storageError('OUTPUT_EXISTS', '備份檔已存在，請指定新的路徑');
  createPrivateFile(output);
  try { db.prepare('VACUUM INTO ?').run(output); } catch (error) {
    rmSync(output, { force: true });
    throw error;
  }
  return inspectTicketDatabase(output);
}

/**
 * 以唯讀方式開啟資料庫檔並檢查完整性、檔案身分與結構版本，只回傳彙總數字。
 * @param {string} file 資料庫檔路徑。
 * @returns {object} tickets（筆數）、schemaVersion。
 * @throws {Error} 檔案不是本服務資料庫、版本過新、尚未初始化或 integrity_check 未通過。
 */
export function inspectTicketDatabase(file) {
  const db = openTicketDatabase(file, { readonly: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw storageError('INTEGRITY_FAILED', '資料庫完整性檢查未通過');
    const schemaVersion = db.pragma('user_version', { simple: true });
    if (schemaVersion < 1) throw storageError('NOT_INITIALIZED', '資料庫尚未初始化');
    return { tickets: db.prepare('SELECT COUNT(*) AS total FROM tickets').get().total, schemaVersion };
  } finally { db.close(); }
}

/**
 * 確認沒有其他連線正在使用資料庫：嘗試切換成 DELETE 日誌模式，成功時順便把 WAL 合併回主檔並移除 -wal。
 * 有其他連線（例如後端仍在執行）時 SQLite 回 SQLITE_BUSY，改丟出明確的錯誤；檔案損毀或無法開啟時不阻擋，
 * 讓損毀的資料庫仍能被改名保留並以備份取代。
 * @param {string} file 目前的資料庫檔路徑。
 * @returns {void}
 * @throws {Error} code DATABASE_IN_USE：資料庫仍被其他連線開啟。
 */
function assertNotInUse(file) {
  const Database = require('better-sqlite3');
  let db;
  try {
    db = new Database(file, { fileMustExist: true, timeout: 0 });
    db.pragma('journal_mode = DELETE');
  } catch (error) {
    if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error?.code)) throw storageError('DATABASE_IN_USE', '資料庫仍在使用中，請先停止後端再還原');
  } finally {
    try { db?.close(); } catch { /* 開啟失敗時沒有連線可關閉。 */ }
  }
}

// SQLite 放在主檔旁、內容屬於該主檔的附屬檔；必須與主檔一起移動，不能和其他主檔配對。
const SIDECARS = Object.freeze(['-wal', '-shm']);

/**
 * 依序執行一組改名；任一步失敗時把已完成的改名依相反順序改回，再拋出原始錯誤。
 * 改回也失敗時不吞掉原始錯誤，而是把第一個回滾錯誤附在原始錯誤的 rollbackError 屬性上，
 * 讓呼叫端知道檔案可能停在新舊兩處，需要人工處理。
 * @param {Array<[string, string]>} moves 依序執行的 [來源, 目標] 路徑組。
 * @param {(source: string, target: string) => void} rename 改名函式，正式執行時為 fs.renameSync。
 * @returns {void}
 * @throws {Error} 第一個失敗的改名錯誤；回滾失敗時帶 rollbackError 屬性。
 */
function renameAll(moves, rename) {
  const done = [];
  try {
    for (const [source, target] of moves) {
      rename(source, target);
      done.push([source, target]);
    }
  } catch (error) {
    for (const [source, target] of done.reverse()) {
      try { rename(target, source); } catch (rollbackError) {
        // 保留原始錯誤；第一個回滾錯誤另外附上，檔案仍在 target，可依錯誤內容人工改回。
        if (error && typeof error === 'object' && !error.rollbackError) error.rollbackError = rollbackError;
      }
    }
    throw error;
  }
}

/**
 * 列出把資料庫檔從 from 移到 to 時要執行的改名：先列存在的 -wal／-shm，最後才列主檔，
 * 讓失敗時最多只留下「附屬檔已移走、主檔仍在原位」並可依序改回。
 * @param {string} from 原主檔路徑。
 * @param {string} to 新主檔路徑。
 * @param {object} [options={}] 選項。
 * @param {boolean} [options.includeMain=true] 是否包含主檔；主檔不存在、只剩殘留的 -wal／-shm 時傳 false。
 * @returns {Array<[string, string]>} [來源, 目標] 路徑組；只包含呼叫當下存在的附屬檔。
 */
function databaseFileMoves(from, to, { includeMain = true } = {}) {
  const moves = [];
  for (const suffix of SIDECARS) if (existsSync(`${from}${suffix}`)) moves.push([`${from}${suffix}`, `${to}${suffix}`]);
  if (includeMain) moves.push([from, to]);
  return moves;
}

/**
 * 把資料庫主檔與存在的 -wal／-shm 一起改名，讓保留的副本完整。先移動 -wal／-shm、最後才移動主檔，
 * 任一步失敗時把已移動的檔案依相反順序改回原名再拋出原始錯誤，避免留下「主檔不存在」或主檔與 -wal 分離的狀態；
 * 改回也失敗時，原始錯誤帶 rollbackError 屬性。
 * 呼叫端必須先確認目標名稱（含 -wal／-shm）都不存在，因為 renameSync 會直接取代既有檔案。
 * @param {string} from 原主檔路徑，必須存在（不存在時拋出 ENOENT）。
 * @param {string} to 新主檔路徑。
 * @param {object} [options={}] 選項。
 * @param {(source: string, target: string) => void} [options.rename=renameSync] 改名函式；只供測試注入失敗。
 * @returns {void}
 * @throws {Error} 任一改名失敗時的原始檔案系統錯誤（已盡力回滾；回滾失敗時帶 rollbackError）。
 */
export function moveDatabaseFiles(from, to, { rename = renameSync } = {}) {
  renameAll(databaseFileMoves(from, to), rename);
}

/**
 * 以備份檔取代目前的資料庫；必須在後端停止時執行。流程依序為：
 * 1. 以唯讀方式驗證備份檔，並確認保留舊檔用的名稱（含 -wal／-shm）都不存在（PREVIOUS_EXISTS），在移動任何檔案前就拒絕；
 *    主檔不存在但旁邊仍有殘留的 -wal／-shm 時同樣檢查，因為這些殘留檔也要改名保留；
 * 2. 以唯讀連線開啟備份，用 VACUUM INTO 依邏輯內容（含備份旁 -wal 中已提交的資料）寫入同目錄預先建立的 600 暫存檔，
 *    再驗證暫存檔，並比對備份與暫存檔的需求單筆數，不同時以 BACKUP_NOT_SELF_CONTAINED 拒絕；備份放在唯讀掛載上也可使用；
 * 3. 主檔存在時確認目前資料庫沒有其他連線（DATABASE_IN_USE）；
 * 4. 把目前資料庫連同 -wal／-shm 改名為 <檔名>.before-restore-<時間>（附屬檔加上相同後綴）。
 *    主檔不存在但有殘留的 -wal／-shm 時，只把殘留檔改名為 <檔名>.before-restore-<時間>-wal／-shm 保留：
 *    SQLite 會把同名的 -wal 套用到放進來的備份上，留在原位會讓還原後的內容錯誤甚至損毀。
 *    這種情況沒有主檔可確認是否仍有連線（無法偵測），因此選擇改名保留而不刪除，內容可供事後檢查；
 * 5. 把暫存檔改名為正式檔，失敗時把第 4 步移開的檔案（含 -wal／-shm）改回原名。
 * 任何一步失敗都不會留下「正式檔不存在」的狀態，避免重啟後誤把舊版 tickets.json 重新匯入；
 * 唯一例外是回滾本身也失敗：此時拋出的仍是原始錯誤，另帶 rollbackError（回滾錯誤）、stagedFile（保留不刪的已驗證暫存檔）
 * previousFile（保留舊主檔的路徑；原本沒有主檔時為 null）與 movedFiles（實際被移開、尚未改回的檔案目前路徑，
 * 含主檔不存在時移開的殘留 -wal／-shm），讓維運人員依這些路徑人工復原。
 * @param {string} file 目前資料庫檔路徑。
 * @param {string} source 備份檔路徑。
 * @param {string} stamp 保留舊檔時使用的時間標記（例如 20261101-120000）。
 * @param {object} [options={}] 選項。
 * @param {(source: string, target: string) => void} [options.rename=renameSync] 第 4、5 步使用的改名函式；只供測試注入失敗。
 * @returns {object} restored（還原後的彙總）、previous（舊主檔改名後的路徑，原本不存在時 null）、
 * strandedSidecars（主檔不存在時改名保留的殘留 -wal／-shm 新路徑，沒有時為空陣列）。
 * @throws {Error} 備份檔驗證失敗、BACKUP_NOT_SELF_CONTAINED、PREVIOUS_EXISTS（同名的保留檔已存在）、
 * 資料庫仍在使用中（DATABASE_IN_USE）或檔案操作失敗（回滾失敗時帶 rollbackError、stagedFile、previousFile、movedFiles）。
 */
export function restoreTicketDatabase(file, source, stamp, { rename = renameSync } = {}) {
  const expected = inspectTicketDatabase(source);
  const mainExists = existsSync(file);
  const stranded = SIDECARS.some(/** 判斷主檔旁是否有這個附屬檔。@param {string} suffix 附屬檔後綴。@returns {boolean} 存在時 true。 */ (suffix) => existsSync(`${file}${suffix}`));
  const keep = `${file}.before-restore-${stamp}`;
  const previous = mainExists ? keep : null;
  // 時間標記只到秒，同一秒內第二次還原會撞名；renameSync 會直接取代既有檔案，因此在移動任何檔案前就拒絕。
  if (mainExists || stranded) {
    for (const suffix of ['', ...SIDECARS]) {
      if (existsSync(`${keep}${suffix}`)) throw storageError('PREVIOUS_EXISTS', '保留舊資料庫用的檔名已存在，請稍候再執行或先移走同名檔案');
    }
  }
  const temporary = `${file}.restore-tmp`;
  for (const path of [temporary, ...SIDECARS.map(/** 組出暫存檔的附屬檔路徑。@param {string} suffix 附屬檔後綴。@returns {string} 路徑。 */ (suffix) => `${temporary}${suffix}`)]) rmSync(path, { force: true });
  try {
    createPrivateFile(temporary);
    const reader = openTicketDatabase(source, { readonly: true });
    try { reader.prepare('VACUUM INTO ?').run(temporary); } finally { reader.close(); }
    try { chmodSync(temporary, 0o600); } catch { /* 不支援 POSIX 權限時略過。 */ }
    const staged = inspectTicketDatabase(temporary);
    if (staged.tickets !== expected.tickets) {
      throw storageError('BACKUP_NOT_SELF_CONTAINED', '備份檔內容在複製過程中不一致（可能是執行中資料庫的副本），請改用 scripts/db-backup.js 產生的備份');
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    // 唯讀檢查時可能留下 -wal／-shm，不能跟著暫存檔進入正式位置。
    for (const suffix of SIDECARS) rmSync(`${temporary}${suffix}`, { force: true });
  }
  let moved = [];
  try {
    if (mainExists) assertNotInUse(file);
    // assertNotInUse 成功時會把 -wal 合併回主檔並移除，因此在它之後才列出實際要移動的檔案。
    moved = mainExists || stranded ? databaseFileMoves(file, keep, { includeMain: mainExists }) : [];
    renameAll(moved, rename);
    try { rename(temporary, file); } catch (error) {
      try { renameAll(moved.map(/** 反轉改名方向，把移開的檔案改回原名。@param {[string, string]} move [原路徑, 新路徑]。@returns {[string, string]} [新路徑, 原路徑]。 */ ([from, to]) => [to, from]), rename); } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      throw error;
    }
  } catch (error) {
    if (error?.rollbackError) {
      // 回滾失敗：正式位置可能沒有資料庫，已驗證的暫存檔是唯一可直接放回的副本，保留並回報路徑。
      // previousFile 只在原本有主檔時才有意義；movedFiles 列出實際被移開的檔案（含殘留的 -wal／-shm）目前所在路徑。
      Object.assign(error, { stagedFile: temporary, previousFile: previous, movedFiles: moved.map(/** 取出移開後的路徑。@param {[string, string]} move [原路徑, 新路徑]。@returns {string} 新路徑。 */ ([, to]) => to) });
    } else {
      rmSync(temporary, { force: true });
    }
    throw error;
  }
  const strandedSidecars = mainExists ? [] : moved.map(/** 取出殘留附屬檔改名後的路徑。@param {[string, string]} move [原路徑, 新路徑]。@returns {string} 新路徑。 */ ([, to]) => to);
  return { restored: inspectTicketDatabase(file), previous, strandedSidecars };
}
