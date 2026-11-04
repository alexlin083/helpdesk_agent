import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestEnv } from './helpers/testEnv.js';

const scratch = mkdtempSync(join(tmpdir(), 'helpdesk-personnel-'));
setupTestEnv();

const { env } = await import('../src/config/env.js');
const { openTicketDatabase, SCHEMA_VERSION, APPLICATION_ID } = await import('../src/services/storage/database.js');
const { createSqliteDataStore } = await import('../src/services/storage/dataStore.js');
const { createAccountService } = await import('../src/services/personnel/accountService.js');
const { createEmployeeService } = await import('../src/services/personnel/employeeService.js');
const { createAuthService } = await import('../src/services/authService.js');
const { createPersonnelAdmin } = await import('../src/services/personnel/personnel.js');
const { DEMO_ACCOUNTS, demoPersonnelSeed } = await import('../src/services/personnel/demoPersonnel.js');
const { departmentService } = await import('../src/services/departmentService.js');
const { getRequestTypes } = await import('../src/services/requestTypes/registry.js');
// 實際請假需求類型的 ledger 規格（通用 ledger 依它計算額度）。
const LEAVE_SPEC = getRequestTypes().ledgerOwner('leave_entitlements').ledgerSpec;
const Database = createRequire(import.meta.url)('better-sqlite3');
const backendRoot = fileURLToPath(new URL('..', import.meta.url));

const stores = [];
const connections = [];
/** 測試結束後關閉所有連線並刪除暫存目錄（Windows 不能刪除仍開啟的檔案）。@returns {void} */
function cleanup() {
  for (const store of stores) store.close();
  for (const db of connections) if (db.open) db.close();
  rmSync(scratch, { recursive: true, force: true });
}
test.after(cleanup);

/**
 * 建立使用暫存檔的需求單儲存並登記到結束時關閉的清單。
 * @param {string} name 暫存目錄中的檔名。
 * @param {object} [options={}] 傳給 createSqliteDataStore 的其他選項（例如 seed）。
 * @returns {object} 需求單儲存。
 */
function storeAt(name, options = {}) {
  const store = createSqliteDataStore({ file: join(scratch, name), ...options });
  stores.push(store);
  return store;
}

/**
 * 以另一條連線開啟同一個資料庫（模擬在另一個程序執行的 scripts/personnel.js）並建立維運操作。
 * @param {string} name 暫存目錄中的檔名。
 * @returns {object} createPersonnelAdmin 的操作。
 */
function adminAt(name) {
  const db = openTicketDatabase(join(scratch, name));
  connections.push(db);
  return createPersonnelAdmin(db, { departments: departmentService, clock: /** 固定時間來源。@returns {number} epoch 毫秒。 */ () => Date.UTC(2026, 10, 1) });
}

/**
 * 計算資料庫檔（含 -wal）的雜湊，確認預覽完全沒有寫入。
 * @param {string} file 資料庫檔路徑。
 * @returns {string} 主檔與 -wal 內容的 sha256。
 */
function fingerprint(file) {
  const hash = createHash('sha256').update(readFileSync(file));
  if (existsSync(`${file}-wal`)) hash.update(readFileSync(`${file}-wal`));
  return hash.digest('hex');
}

/**
 * 依版本 1、2 的結構建立舊版資料庫（與 storage/database.js 已發布的遷移相同），供升級測試使用。
 * @param {string} name 暫存目錄中的檔名。
 * @param {Array<{username: string, active?: number, employeeNo: string}>} employees 要寫入的員工列（假資料）。
 * @returns {string} 資料庫檔路徑。
 */
function createVersion2(name, employees) {
  const file = join(scratch, name);
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE tickets (seq INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL UNIQUE, document TEXT NOT NULL CHECK (json_valid(document))) STRICT;
    CREATE TABLE meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE employees (username TEXT PRIMARY KEY, display_name TEXT NOT NULL, employee_no TEXT NOT NULL UNIQUE, hire_date TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1) STRICT;
    CREATE TABLE leave_entitlements (username TEXT NOT NULL REFERENCES employees (username), leave_type TEXT NOT NULL CHECK (leave_type IN ('事假', '病假', '特休')),
      year INTEGER NOT NULL, granted_minutes INTEGER NOT NULL CHECK (granted_minutes >= 0), PRIMARY KEY (username, leave_type, year)) STRICT;
    CREATE TABLE leave_adjustments (id INTEGER PRIMARY KEY, username TEXT NOT NULL, leave_type TEXT NOT NULL, year INTEGER NOT NULL, delta_minutes INTEGER NOT NULL,
      reason TEXT NOT NULL, by_user_id TEXT NOT NULL, at TEXT NOT NULL) STRICT;
    CREATE INDEX leave_adjustments_lookup ON leave_adjustments (username, year, leave_type);`);
  const insert = legacy.prepare('INSERT INTO employees (username, display_name, employee_no, hire_date, active) VALUES (?, ?, ?, ?, ?)');
  for (const employee of employees) {
    insert.run(employee.username, '測試員工', employee.employeeNo, '2020-01-01', employee.active ?? 1);
    legacy.prepare("INSERT INTO leave_entitlements VALUES (?, '特休', 2026, 1234)").run(employee.username);
  }
  legacy.prepare('INSERT INTO tickets (ticket_id, document) VALUES (?, ?)').run('TK-v2', JSON.stringify({ ticket_id: 'TK-v2', status: 'PENDING' }));
  legacy.pragma(`application_id = ${APPLICATION_ID}`);
  legacy.pragma('user_version = 2');
  legacy.close();
  return file;
}

/**
 * 驗證全新資料庫寫入完整示範名冊（16 位員工、管理員沒有員工資料、每人 2026／2027 三種假別），
 * 以及帳號表不是空的時重新開啟永遠不再寫入（即使示範帳號已被停用或部門已調整）。
 * @returns {Promise<void>}
 */
async function freshDatabaseSeed() {
  const store = storeAt('fresh.db');
  const prepared = await store.prepare({ legacyFile: join(scratch, 'none.json') });
  assert.deepEqual(prepared.seeded, { accounts: 17, employees: 16, entitlements: 96 });
  assert.equal((await store.stats()).schemaVersion, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 8);
  const accounts = store.listAccounts();
  assert.deepEqual(accounts.map(/** 取帳號。@param {object} row 帳號列。@returns {string} 帳號。 */ (row) => row.username), DEMO_ACCOUNTS.map(/** 取帳號。@param {object} row 名冊帳號。@returns {string} 帳號。 */ (row) => row.username));
  assert.deepEqual(store.findAccount('alex.admin'), { username: 'alex.admin', department_id: 'dept-it-1', role: 'ADMIN', active: 1 });
  assert.equal(store.findEmployee('alex.admin'), null, '管理員沒有員工資料');
  const employees = createEmployeeService({ store });
  assert.equal(employees.list().length, 16);
  assert.deepEqual(employees.find('paula.hsu'), { username: 'paula.hsu', displayName: '示範員工巳', employeeNo: 'T-0016', hireDate: '2021-08-30',
    entitlements: [2026, 2027].flatMap(/** 展開年度額度。@param {number} year 年度。@returns {object[]} 額度。 */ (year) => [{ year, leaveType: '特休', minutes: 6720 }, { year, leaveType: '事假', minutes: 6720 }, { year, leaveType: '病假', minutes: 14400 }]) });
  assert.equal(employees.find(42), null);
  const admin = adminAt('fresh.db');
  admin.setActive('racky.huang', false);
  admin.setDepartment('cindy.wang', 'dept-hr-1');
  store.close();
  const raw = new Database(join(scratch, 'fresh.db'));
  /** 讀出帳號的部門名稱。@param {string} username 帳號。@returns {string} 部門名稱。 */
  const nameOf = (username) => raw.prepare('SELECT department_name FROM accounts WHERE username = ?').get(username).department_name;
  assert.deepEqual([nameOf('racky.huang'), nameOf('alex.admin'), nameOf('emily.wu')], ['資訊管理一部', '資訊管理一部', '人力資源部'], '開啟資料庫時填入部門的中文名稱，管理員也有');
  assert.equal(nameOf('cindy.wang'), '人力資源部', '調整部門時同步更新名稱');
  raw.prepare("UPDATE accounts SET department_name = '舊名稱' WHERE username = 'racky.huang'").run();
  raw.close();
  const reopened = storeAt('fresh.db');
  assert.deepEqual((await reopened.prepare({ legacyFile: join(scratch, 'none.json') })).seeded, { accounts: 0, employees: 0, entitlements: 0 }, '帳號表不是空的時不再寫入');
  assert.equal(reopened.findAccount('racky.huang').active, 0, '停用狀態不被名冊覆寫');
  assert.equal(reopened.findAccount('cindy.wang').department_id, 'dept-hr-1', '部門調整不被名冊覆寫');
  const check = new Database(join(scratch, 'fresh.db'), { readonly: true });
  assert.equal(check.prepare("SELECT department_name FROM accounts WHERE username = 'racky.huang'").get().department_name, '資訊管理一部', '重新開啟時依部門設定檔修正名稱');
  check.close();
  assert.deepEqual(Object.keys(reopened.findAccount('racky.huang')), ['username', 'department_id', 'role', 'active'], '程式讀取帳號時不使用部門名稱欄位');
  // 在全新資料庫先以維運腳本新增帳號：之後服務開啟時不寫入示範名冊。
  const own = adminAt('own.db');
  own.add({ username: 'only.person', department: 'dept-it-1', name: '測試員工', employeeNo: 'T-9100', hireDate: '2024-02-29' });
  const ownStore = storeAt('own.db');
  assert.deepEqual((await ownStore.prepare({ legacyFile: join(scratch, 'none.json') })).seeded, { accounts: 0, employees: 0, entitlements: 0 });
  assert.deepEqual(ownStore.listAccounts().map(/** 取帳號。@param {object} row 帳號列。@returns {string} 帳號。 */ (row) => row.username), ['only.person']);
  assert.ok(storeAt('none.db', { seed: null }).listAccounts().length === 0, 'seed 為 null 時不寫入任何人員資料');
}
test('全新資料庫寫入示範名冊，帳號表不是空的時永遠不再寫入', freshDatabaseSeed);

/**
 * 驗證結構版本 2 升級到 3：依示範名冊替既有員工建立帳號與部門（沿用停用狀態）、補上管理員，保留額度與需求單，
 * employees 改以外鍵參照 accounts 並移除 active 欄位；員工不在名冊時整步回滾並以 PERSONNEL_UNMAPPED 拒絕；employees 為空時改寫入整份名冊。
 * @returns {Promise<void>}
 */
async function version2Upgrade() {
  const file = createVersion2('v2.db', [{ username: 'racky.huang', employeeNo: 'T-0001' }, { username: 'kevin.ho', employeeNo: 'T-0011', active: 0 }]);
  const store = storeAt('v2.db');
  const prepared = await store.prepare({ legacyFile: join(scratch, 'none.json') });
  assert.deepEqual(prepared.seeded, { accounts: 0, employees: 0, entitlements: 0 }, '升級時已建立帳號，不再寫入示範名冊');
  assert.equal((await store.find('TK-v2')).status, 'PENDING');
  assert.deepEqual(store.listAccounts(), [
    { username: 'racky.huang', department_id: 'dept-it-1', role: 'USER', active: 1 },
    { username: 'kevin.ho', department_id: 'dept-it-1', role: 'USER', active: 0 },
    { username: 'alex.admin', department_id: 'dept-it-1', role: 'ADMIN', active: 1 },
  ]);
  assert.equal((await store.ledgerBalances(LEAVE_SPEC, 'racky.huang', 2026)).balances[2].granted, 1234, '保留既有額度');
  store.close();
  const check = new Database(file, { readonly: true });
  connections.push(check);
  assert.deepEqual(check.pragma('table_info(employees)').map(/** 取欄位名稱。@param {object} column 欄位。@returns {string} 名稱。 */ (column) => column.name), ['employee_no', 'display_name', 'hire_date']);
  assert.deepEqual(check.pragma('foreign_key_list(accounts)').map(/** 取參照資料表。@param {object} key 外鍵。@returns {string} 資料表。 */ (key) => key.table), ['employees'], '帳號以員工編號參照員工資料');
  assert.deepEqual(check.pragma('foreign_key_list(leave_entitlements)').map(/** 取參照資料表。@param {object} key 外鍵。@returns {string} 資料表。 */ (key) => `${key.table}.${key.to}`), ['employees.employee_no']);
  assert.deepEqual(check.prepare('SELECT username, employee_no FROM accounts ORDER BY rowid').all(),
    [{ username: 'racky.huang', employee_no: 'T-0001' }, { username: 'kevin.ho', employee_no: 'T-0011' }, { username: 'alex.admin', employee_no: null }]);
  check.close();
  const writable = openTicketDatabase(file);
  connections.push(writable);
  assert.throws(/** 嘗試刪除帳號。@returns {void} */ () => writable.prepare("DELETE FROM accounts WHERE username = 'kevin.ho'").run(), /不可刪除/);
  assert.throws(/** 嘗試讓管理員帶員工編號。@returns {void} */ () => writable.prepare("UPDATE accounts SET employee_no = 'T-0001' WHERE username = 'alex.admin'").run(), { code: 'SQLITE_CONSTRAINT_CHECK' }, '管理員沒有員工資料');
  assert.throws(/** 嘗試讓帳號參照不存在的員工編號。@returns {void} */ () => writable.prepare("UPDATE accounts SET employee_no = 'T-NONE' WHERE username = 'racky.huang'").run(), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  assert.throws(/** 嘗試讓兩個帳號共用員工編號。@returns {void} */ () => writable.prepare("UPDATE accounts SET employee_no = 'T-0001' WHERE username = 'kevin.ho'").run(), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
  assert.throws(/** 嘗試寫入格式不符的帳號。@returns {void} */ () => writable.prepare("INSERT INTO accounts (username, department_id, role, active, created_at, updated_at) VALUES ('Bad.Name', 'dept-it-1', 'USER', 1, 'x', 'x')").run(), { code: 'SQLITE_CONSTRAINT_CHECK' });
  writable.close();

  const unmapped = createVersion2('v2-unmapped.db', [{ username: 'racky.huang', employeeNo: 'T-0001' }, { username: 'stranger.person', employeeNo: 'T-0999' }]);
  await assert.rejects(storeAt('v2-unmapped.db').prepare({ legacyFile: join(scratch, 'none.json') }), { code: 'PERSONNEL_UNMAPPED', message: /stranger\.person/ });
  const untouched = new Database(unmapped, { readonly: true });
  connections.push(untouched);
  assert.equal(untouched.pragma('user_version', { simple: true }), 2, '整步回滾，維持版本 2');
  assert.equal(untouched.prepare("SELECT COUNT(*) AS total FROM sqlite_schema WHERE name = 'accounts'").get().total, 0);
  assert.equal(untouched.prepare('SELECT COUNT(*) AS total FROM employees').get().total, 2);
  untouched.close();

  createVersion2('v2-empty.db', []);
  const empty = storeAt('v2-empty.db');
  assert.deepEqual((await empty.prepare({ legacyFile: join(scratch, 'none.json') })).seeded, { accounts: 17, employees: 16, entitlements: 96 }, '沒有員工的版本 2 資料庫升級後寫入整份名冊');
}
test('結構版本 2 升級到 3：依名冊建立帳號、外鍵、無法對應時回滾', version2Upgrade);

/**
 * 驗證維運操作與服務共用的驗證規則、預覽不寫入任何內容，以及調部門與停用在執行中的服務立即生效（每次呼叫重新查詢）：
 * 處理人名單、代理人候選來源（handlersOf、list）、登入與既有憑證。
 * @returns {Promise<void>}
 */
async function personnelOperations() {
  const store = storeAt('ops.db');
  await store.prepare({ legacyFile: join(scratch, 'none.json') });
  const accounts = createAccountService({ store });
  const auth = createAuthService({ ...env, authSecret: 'test-only-secret-value-that-is-long-enough' }, accounts);
  const admin = adminAt('ops.db');
  /** 取處理人帳號。@param {string} departmentId 部門。@returns {string[]} 帳號。 */
  const handlers = (departmentId) => accounts.handlersOf(departmentId).map(/** 取 id。@param {{id: string}} handler 處理人。@returns {string} 帳號。 */ (handler) => handler.id);
  assert.deepEqual(handlers('dept-it-1'), ['racky.huang', 'kevin.ho']);

  const file = join(scratch, 'ops.db');
  store.close();
  const before = fingerprint(file);
  const readonly = openTicketDatabase(file, { readonly: true });
  connections.push(readonly);
  const preview = createPersonnelAdmin(readonly, { departments: departmentService });
  assert.deepEqual(preview.setDepartment('kevin.ho', 'dept-it-2', { dryRun: true }),
    { action: 'set-department', username: 'kevin.ho', changed: true, changes: { department_id: { from: 'dept-it-1', to: 'dept-it-2' } }, dryRun: true });
  assert.equal(preview.setActive('racky.huang', false, { dryRun: true }).changed, true);
  assert.deepEqual(preview.grant('racky.huang', '特休', '2028', '600', { dryRun: true }).changes, { entitlement: { leave_type: '特休', year: 2028, from: null, to: 600 } });
  assert.equal(preview.add({ username: 'new.person', department: 'dept-hr-1', name: '測試員工', employeeNo: 'T-9200', hireDate: '2025-01-01' }, { dryRun: true }).changed, true);
  assert.equal(fingerprint(file), before, '預覽不寫入任何內容');
  readonly.close();

  assert.deepEqual(admin.setDepartment('kevin.ho', 'dept-it-2').changes, { department_id: { from: 'dept-it-1', to: 'dept-it-2' } });
  assert.deepEqual(handlers('dept-it-1'), ['racky.huang'], '另一條連線提交後立即生效，不需重啟');
  assert.deepEqual(handlers('dept-it-2'), ['cindy.wang', 'kevin.ho', 'lisa.kao'], '依帳號建立順序');
  assert.equal(accounts.find('kevin.ho').department.id, 'dept-it-2');
  assert.equal(admin.setDepartment('kevin.ho', 'dept-it-2').changed, false, '部門相同時不寫入');

  const session = await auth.issue(auth.credentials('racky.huang', 'test-only-password'));
  assert.equal((await auth.verify(session.token)).username, 'racky.huang');
  admin.setActive('racky.huang', false);
  assert.equal(auth.credentials('racky.huang', 'test-only-password'), null, '停用的帳號不能登入');
  await assert.rejects(auth.verify(session.token), { status: 401 }, '既有憑證立即失效');
  assert.deepEqual(handlers('dept-it-1'), [], '停用的帳號不是處理人');
  assert.equal(accounts.findHandler('racky.huang'), null);
  assert.equal(accounts.find('racky.huang'), null, '停用的帳號不能當代理人（需求類型引擎以 find 驗證帳號欄位）');
  assert.ok(!accounts.list().some(/** 是否為停用帳號。@param {object} account 帳號。@returns {boolean} 相符時 true。 */ (account) => account.username === 'racky.huang'), '不列入代理人候選');
  assert.ok(!accounts.usernames.includes('racky.huang'));
  admin.setActive('racky.huang', true);
  assert.ok(auth.credentials('racky.huang', 'test-only-password'), '恢復後可以登入');

  assert.deepEqual(admin.grant('racky.huang', '特休', 2026, 100).changes, { entitlement: { leave_type: '特休', year: 2026, from: 6720, to: 100 } });
  assert.equal((await store.ledgerBalances(LEAVE_SPEC, 'racky.huang', 2026)).balances[2].granted, 100);
  await store.insert({ ticket_id: 'TK-grant-check', status: 'PENDING', created_at: '2026-11-01T00:00:00.000Z', requester: { username: 'racky.huang' },
    form: { id: 'leave', ledger: { category: '特休', amount: 60, period: 2026, start: null, end: null } }, history: [] });
  admin.grant('racky.huang', '特休', 2026, 200);
  const [, , special] = (await store.ledgerBalances(LEAVE_SPEC, 'racky.huang', 2026)).balances;
  assert.deepEqual([special.granted, special.pending, special.remaining], [200, 60, 200], '剩餘只由額度與人資調整決定，待簽核的請假單只列為參考');
  const added = admin.add({ username: 'new.person', department: 'dept-hr-1', name: '測試員工', employeeNo: 'T-9200', hireDate: '2025-01-01' });
  assert.deepEqual(added.changes.employee_profile, { from: false, to: true });
  assert.deepEqual(handlers('dept-hr-1'), ['emily.wu', 'frank.liu', 'new.person']);
  admin.add({ username: 'second.admin', department: 'dept-it-1', role: 'ADMIN' });
  assert.equal(accounts.find('second.admin').role, 'ADMIN');
  assert.equal(accounts.findHandler('second.admin'), null, '管理員不是處理人');

  const invalid = [
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.add({ username: 'Bad.Name', department: 'dept-it-1', name: 'x', employeeNo: 'T-1', hireDate: '2020-01-01' }), /名\.姓/],
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.add({ username: 'a.b', department: 'dept-missing', name: 'x', employeeNo: 'T-1', hireDate: '2020-01-01' }), /department_id/],
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.add({ username: 'a.b', department: 'dept-it-1', role: 'BOSS' }), /role/],
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.add({ username: 'a.b', department: 'dept-it-1' }), /display_name/],
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.add({ username: 'a.b', department: 'dept-it-1', name: 'x', employeeNo: 'T-1', hireDate: '2020-02-30' }), /hire_date/],
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.add({ username: 'a.b', department: 'dept-it-1', role: 'ADMIN', name: 'x' }), /管理員/],
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.add({ username: 'a.b', department: 'dept-it-1', name: 'x', employeeNo: 'T-0001', hireDate: '2020-01-01' }), { code: 'PERSONNEL_CONFLICT' }],
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.add({ username: 'racky.huang', department: 'dept-it-1', name: 'x', employeeNo: 'T-1', hireDate: '2020-01-01' }), { code: 'PERSONNEL_CONFLICT' }],
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.setDepartment('missing.person', 'dept-it-1'), { code: 'PERSONNEL_NOT_FOUND' }],
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.setDepartment('racky.huang', 'dept-missing'), /department_id/],
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.grant('alex.admin', '特休', 2026, 1), { code: 'PERSONNEL_NOT_FOUND' }],
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.grant('racky.huang', '公假', 2026, 1), /假別/],
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.grant('racky.huang', '特休', '26', 1), /四位數年度/],
    [/** 執行應被拒絕的維運操作。@returns {object} 不會回傳。@throws {Error} 驗證失敗。 */ () => admin.grant('racky.huang', '特休', 2026, '-5'), /非負整數/],
  ];
  for (const [task, expected] of invalid) assert.throws(task, expected);
}
test('人員維運操作：驗證規則、預覽不寫入、調部門與停用立即生效', personnelOperations);

/**
 * 驗證所屬部門已不在部門設定檔的帳號：列在 missingDepartments（啟動警告用），不能登入、不是處理人。
 * 部門 id 只能以 SQL 直接改成不存在的值（維運腳本會拒絕），模擬部門設定檔移除部門的情況。
 * @returns {Promise<void>}
 */
async function missingDepartment() {
  const store = storeAt('missing.db');
  await store.prepare({ legacyFile: join(scratch, 'none.json') });
  const raw = openTicketDatabase(join(scratch, 'missing.db'));
  connections.push(raw);
  raw.prepare("UPDATE accounts SET department_id = 'dept-gone' WHERE username = 'amy.chen'").run();
  const accounts = createAccountService({ store });
  assert.deepEqual(accounts.missingDepartments(), [{ username: 'amy.chen', departmentId: 'dept-gone', active: true }]);
  assert.equal(accounts.find('amy.chen'), null);
  assert.equal(accounts.findHandler('amy.chen'), null);
  assert.deepEqual(accounts.handlersOf('dept-fin-1').map(/** 取 id。@param {{id: string}} handler 處理人。@returns {string} 帳號。 */ (handler) => handler.id), ['nina.lo']);
  assert.deepEqual(accounts.handlersOf('dept-gone'), []);
  const listed = createPersonnelAdmin(raw, { departments: departmentService }).list({ department: 'dept-gone' });
  assert.deepEqual(listed.map(/** 取帳號與旗標。@param {object} row 列表列。@returns {object[]} 帳號與旗標。 */ (row) => [row.username, row.department_missing]), [['amy.chen', true]]);
}
test('部門已不存在的帳號會被回報，且不能登入或當處理人', missingDepartment);

/**
 * 以子程序執行 scripts/personnel.js（假的環境參數，只設定在子程序），解析輸出的 JSON 行。
 * @param {string[]} args 命令列參數。
 * @param {string} databaseFile 測試用 DATABASE_FILE。
 * @returns {{status: number|null, results: object[], events: object[], stdout: string}} 結束代碼、指令結果、日誌事件與原始輸出。
 */
function runPersonnel(args, databaseFile) {
  const environment = { NODE_ENV: 'production', LOG_LEVEL: 'info', AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-only-fake-model-key', CORS_ORIGIN: 'http://localhost:5173',
    AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef', ADMIN_PASSWORD: 'test-admin-only-password', DEMO_PASSWORD: 'test-only-password', DATABASE_FILE: databaseFile };
  for (const name of ['PATH', 'Path', 'SystemRoot']) if (process.env[name]) environment[name] = process.env[name];
  const result = spawnSync(process.execPath, [join(backendRoot, 'scripts', 'personnel.js'), ...args], { cwd: backendRoot, env: environment, encoding: 'utf8' });
  const results = [];
  const events = [];
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    (parsed.event ? events : results).push(parsed);
  }
  return { status: result.status, results, events, stdout: result.stdout };
}

/**
 * 驗證維運腳本：--dry-run 不寫入且輸出會改變的項目，正式執行寫入並記錄只含帳號的 storage.personnel.* 事件，
 * list 輸出 JSON 陣列，參數錯誤時結束碼 2、驗證錯誤時結束碼 1。
 * @returns {Promise<void>}
 */
async function personnelScript() {
  const file = join(scratch, 'cli.db');
  const store = storeAt('cli.db');
  await store.prepare({ legacyFile: join(scratch, 'none.json') });
  store.close();
  const before = fingerprint(file);
  const dry = runPersonnel(['set-department', 'kevin.ho', 'dept-it-2', '--dry-run'], file);
  assert.equal(dry.status, 0);
  assert.deepEqual(dry.results, [{ action: 'set-department', username: 'kevin.ho', changed: true, changes: { department_id: { from: 'dept-it-1', to: 'dept-it-2' } }, dryRun: true }]);
  assert.equal(dry.events[0].event, 'storage.personnel.dry_run');
  assert.equal(fingerprint(file), before, '--dry-run 不寫入');
  const added = runPersonnel(['add', 'new.person', '--department', 'dept-hr-1', '--name', '測試員工姓名', '--employee-no', 'T-9300', '--hire-date', '2025-01-01'], file);
  assert.equal(added.status, 0);
  assert.equal(added.events[0].event, 'storage.personnel.changed');
  assert.ok(!JSON.stringify(added.events).includes('測試員工姓名') && !JSON.stringify(added.events).includes('T-9300'), '日誌只含帳號，不含姓名與員工編號');
  assert.equal(runPersonnel(['deactivate', 'new.person'], file).status, 0);
  const listed = runPersonnel(['list', '--department', 'dept-hr-1'], file);
  assert.equal(listed.status, 0);
  const rows = JSON.parse(listed.stdout.slice(0, listed.stdout.lastIndexOf(']') + 1));
  assert.deepEqual(rows.map(/** 取帳號與狀態。@param {object} row 列表列。@returns {Array} 帳號與狀態。 */ (row) => [row.username, row.active]), [['emily.wu', true], ['frank.liu', true], ['new.person', false]]);
  assert.equal(runPersonnel(['grant', 'new.person', '病假', '2026', '480'], file).status, 0);
  assert.equal(runPersonnel(['remove', 'new.person'], file).status, 2, '不提供刪除');
  assert.equal(runPersonnel(['set-department', 'new.person'], file).status, 2);
  const failed = runPersonnel(['set-department', 'new.person', 'dept-missing'], file);
  assert.equal(failed.status, 1);
  assert.equal(failed.events[0].event, 'storage.personnel.failed');
  assert.equal(runPersonnel(['list', '--dry-run'], join(scratch, 'absent.db')).status, 1, '預覽時資料庫不存在不會建立檔案');
  assert.equal(existsSync(join(scratch, 'absent.db')), false);
  const reader = storeAt('cli.db');
  assert.equal(reader.findAccount('new.person').active, 0);
  assert.equal((await reader.ledgerBalances(LEAVE_SPEC, 'new.person', 2026)).balances[1].granted, 480);
  assert.equal(reader.findAccount('kevin.ho').department_id, 'dept-it-1', '預覽沒有改變部門');
}
test('scripts/personnel.js：預覽不寫入、正式寫入、只記錄帳號', personnelScript);

/**
 * 驗證示範名冊模組與資料表規則一致：每個一般帳號恰有一筆員工資料、部門都存在、每個部門至少兩個一般帳號，且複本可修改不影響常數。
 * @returns {void}
 */
function demoRoster() {
  const seed = demoPersonnelSeed();
  assert.equal(seed.accounts.length, 17);
  assert.equal(seed.employees.length, 16);
  for (const account of seed.accounts) assert.ok(departmentService.findDepartment(account.department_id), account.username);
  for (const department of departmentService.list()) {
    assert.ok(seed.accounts.filter(/** 同部門一般帳號。@param {object} account 帳號。@returns {boolean} 相符時 true。 */ (account) => account.department_id === department.id && account.role === 'USER').length >= 2, department.id);
  }
  seed.employees[0].entitlements['2026'].特休 = 1;
  assert.equal(demoPersonnelSeed().employees[0].entitlements['2026'].特休, 6720);
}
test('示範名冊（假資料）與部門設定一致', demoRoster);
