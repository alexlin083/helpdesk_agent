import { statSync } from 'node:fs';
import { env } from '../../config/env.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { openTicketDatabase, importLegacyTickets, parseTicketRow, ensureMetaSecret, LEDGER_TABLES } from './database.js';
import { ACTIVE_STATUSES, computeLedgerBalances, formPath } from './ledger.js';
import { normalizePersonnelSeed, seedPersonnelIfEmpty, syncAccountDepartmentNames } from '../personnel/personnel.js';
import { departmentService } from '../departmentService.js';
import { demoPersonnelSeed } from '../personnel/demoPersonnel.js';

export const TICKET_STATUSES = Object.freeze(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);

// 清空後合併 WAL 時最多等待的毫秒數；有備份等其他讀取連線時不讓事件迴圈卡住整個預設逾時。
const CHECKPOINT_BUSY_TIMEOUT_MS = 250;
const BUSY_TIMEOUT_MS = 5000;

/**
 * 建立需求單儲存無法使用時的固定錯誤並記錄事件；只記錄錯誤代碼（SQLite 代碼或開啟時的固定代碼），
 * 不輸出需求單原文或底層錯誤訊息。
 * @param {string} operation 失敗的操作（load、persist）。
 * @param {unknown} [error] 底層錯誤，僅取 code 供排查。
 * @returns {HttpError} 503 TICKET_STORE_UNAVAILABLE。
 */
function unavailable(operation, error) {
  logger('error', 'tickets.store.unavailable', { operation, errorCode: typeof error?.code === 'string' ? error.code : undefined });
  return new HttpError(503, 'TICKET_STORE_UNAVAILABLE', '需求單儲存暫時無法使用，請稍後再試');
}

/**
 * 建立在交易內使用的 ledger 查詢輔助物件，交給 insert 的 guard、update 的修改函式與 withLedger；必須在同一筆交易內同步呼叫。
 * @param {object} sql 已編譯的固定語句（employeeExists、ledgerOverlap）。
 * @param {Function} statement 依 SQL 取得快取語句的函式。
 * @param {object} ledgerTables 允許的額度資料表。
 * @returns {{ledgerBalances: Function, ledgerOverlaps: Function, ledgerBusy: Function, employeeExists: Function}} 交易內查詢。
 */
function transactionHelpers(sql, statement, ledgerTables) {
  const helpers = {
    /**
     * 計算申請人某期間各類別的額度。
     * @param {object} spec ledger 規格。
     * @param {string} username 申請人帳號。
     * @param {number} period 期間（年度）。
     * @returns {Array<object>} computeLedgerBalances 的結果。
     */
    ledgerBalances(spec, username, period) { return computeLedgerBalances(statement, ledgerTables, spec, username, period); },
    /**
     * 判斷申請人是否已有與 [startAt, endAt) 重疊的待簽核或已核准同類需求單；時間為同格式的當地時間字串，可直接以字串比較，期間相接不算重疊。
     * 起訖優先取自保存的 form.ledger.start／end，舊版需求單改取定義指定的欄位。
     * @param {{typeId: string, startField: string, endField: string}} spec 期間規格。
     * @param {string} username 申請人帳號。
     * @param {string} startAt 起點。
     * @param {string} endAt 終點。
     * @param {string} [excludeTicketId=''] 排除的單號。
     * @returns {boolean} 有重疊時 true。
     */
    ledgerOverlaps(spec, username, startAt, endAt, excludeTicketId = '') {
      return sql.ledgerOverlap.get(spec.typeId, username, formPath('fields', spec.startField), endAt, formPath('fields', spec.endField), startAt, excludeTicketId).total > 0;
    },
    /**
     * 找出哪些帳號在期間內已有任一種「有期間重疊檢查」的待簽核或已核准需求單。
     * @param {Array<object>} specs 期間規格（registry.busySpecs）。
     * @param {string[]} usernames 要檢查的帳號。
     * @param {string} startAt 起點。
     * @param {string} endAt 終點。
     * @returns {Set<string>} 期間內已有申請的帳號。
     */
    ledgerBusy(specs, usernames, startAt, endAt) {
      return new Set(usernames.filter(/** 是否有任一重疊。@param {string} username 帳號。@returns {boolean} 有重疊時 true。 */ (username) => specs.some(/** 比對單一規格。@param {object} spec 期間規格。@returns {boolean} 重疊時 true。 */ (spec) => helpers.ledgerOverlaps(spec, username, startAt, endAt))));
    },
    /**
     * 判斷員工資料表是否有此帳號。
     * @param {string} username 員工帳號。
     * @returns {boolean} 存在時 true。
     */
    employeeExists(username) { return Boolean(sql.employeeExists.get(username)); },
  };
  return helpers;
}

/**
 * 把員工列與額度列組成員工資料（與 employeeService 記憶體版本相同的形狀）；額度依年度、寫入順序排序。
 * @param {Array<{username: string, display_name: string, employee_no: string, hire_date: string}>} rows 員工列。
 * @param {Array<{username: string, leave_type: string, year: number, granted_minutes: number}>} grants 額度列。
 * @returns {Array<{username: string, displayName: string, employeeNo: string, hireDate: string, entitlements: Array<{year: number, leaveType: string, minutes: number}>}>} 員工資料。
 */
function toEmployees(rows, grants) {
  const byUser = new Map(rows.map(/** 建立員工資料。@param {object} row 員工列。@returns {[string, object]} [帳號, 員工資料]。 */ (row) => [row.username,
    { username: row.username, displayName: row.display_name, employeeNo: row.employee_no, hireDate: row.hire_date, entitlements: [] }]));
  for (const grant of grants) byUser.get(grant.username)?.entitlements.push({ year: grant.year, leaveType: grant.leave_type, minutes: grant.granted_minutes });
  return [...byUser.values()];
}

/**
 * 建立以 SQLite 保存全部需求單的儲存：每張需求單以 JSON 文件存一列，回傳的形狀與欄位順序和寫入時相同。
 * 同一個資料庫另存人員資料（結構版本 3：帳號、所屬部門、角色與啟用狀態；結構版本 2：員工與假別額度；人資調整紀錄已在結構版本 6 移除），
 * 人員資料只存在資料庫，沒有對應的 JSON 檔；需求類型 ledger 的剩餘額度只由額度表的年度額度決定（見 computeLedgerBalances），
 * 需求單的送出、簽核、退回與取消只寫入 tickets，不寫入任何額度相關資料表。
 * 第一次使用時才開啟資料庫，讓只載入模組的測試與工具不會建立檔案；開啟時若 accounts 資料表為空（全新資料庫），
 * 在同一筆 IMMEDIATE 交易內寫入一次人員名冊（預設為 demoPersonnel.js 的假資料）；已有任何帳號時永遠不再寫入。
 * better-sqlite3 為同步 API，單一程序內每個操作都是完整的交易，不需要另外排隊；只適用單一程序。
 * 前端不會直接接觸資料庫：所有讀寫都經由後端 API 進入這個單例的唯一連線，避免多個程序或連線同時寫入；
 * 帳號查詢（accountService）與員工查詢（employeeService）也共用這條連線，不另開第二條，且每次呼叫都重新查詢，
 * 因此維運腳本 scripts/personnel.js 在另一個程序提交的變更，下一個請求就會看到。
 * @param {object} [options={}] 設定。
 * @param {string} [options.file=env.databaseFile] 資料庫檔的絕對路徑，或測試用的 ':memory:'；上層目錄必須已存在。
 * @param {{accounts: Array<object>, employees: Array<object>}|null} [options.seed=demoPersonnelSeed()] 全新資料庫要寫入的人員名冊（原始形狀，
 *   開啟時以 normalizePersonnelSeed 驗證）；null 時不寫入任何人員資料。
 * @param {object} [options.ledgerTables=LEDGER_TABLES] 允許的額度資料表（測試可注入）。
 * @param {{findDepartment: Function}} [options.departments=departmentService] 部門查詢服務，開啟資料庫時用來同步 accounts.department_name。
 * @returns {object} all、find、insert、update、clear、stats、withLedger、ledgerBalances、
 *   listAccounts、findAccount、departmentAccounts、listEmployees、findEmployee、prepare、localAuthSecret、close 操作。
 */
export function createSqliteDataStore({ file = env.databaseFile, seed = demoPersonnelSeed(), ledgerTables = LEDGER_TABLES, departments = departmentService } = {}) {
  let db;
  let statements;
  // 依 SQL 文字快取的動態語句（額度表查詢等，SQL 只由允許清單與固定文字組成）；關閉連線時清空。
  let dynamic = new Map();
  let seeded = { accounts: 0, employees: 0, entitlements: 0 };

  /**
   * 開啟連線、預先編譯語句，並在帳號表為空時寫入人員名冊，接著依部門設定檔同步 accounts.department_name（只供直接檢視資料庫，名稱不同時才更新）；錯誤原樣拋出（含 NODE_TOO_OLD、FOREIGN_DATABASE、SCHEMA_TOO_NEW、
   * PERSONNEL_UNMAPPED、PERSONNEL_INVALID 等代碼），開啟失敗時不快取。
   * @returns {object} db 與 statements。
   * @throws {Error} 資料庫無法開啟、結構遷移、名冊驗證或寫入失敗。
   */
  function openConnection() {
    if (db) return { db, statements };
    const opened = openTicketDatabase(file);
    let prepared;
    try {
      prepared = {
        all: opened.prepare('SELECT document FROM tickets ORDER BY seq'),
        find: opened.prepare('SELECT document FROM tickets WHERE ticket_id = ?'),
        insert: opened.prepare('INSERT INTO tickets (ticket_id, document) VALUES (?, ?)'),
        update: opened.prepare('UPDATE tickets SET document = ? WHERE ticket_id = ?'),
        clear: opened.prepare('DELETE FROM tickets'),
        stats: opened.prepare("SELECT json_extract(document, '$.status') AS status, COUNT(*) AS total FROM tickets GROUP BY 1"),
        // rowid 保留寫入順序（名冊順序，之後新增的帳號排在後面）。
        // 結構版本 8 起員工資料與額度以員工編號關聯，這裡以 accounts.employee_no 串回帳號，對外的形狀仍以帳號辨識。
        allAccounts: opened.prepare('SELECT username, department_id, role, active FROM accounts ORDER BY rowid'),
        findAccount: opened.prepare('SELECT username, department_id, role, active FROM accounts WHERE username = ?'),
        departmentAccounts: opened.prepare("SELECT username, department_id, role, active FROM accounts WHERE department_id = ? AND role = 'USER' AND active = 1 ORDER BY rowid"),
        allEmployees: opened.prepare('SELECT a.username, e.display_name, e.employee_no, e.hire_date FROM employees e JOIN accounts a ON a.employee_no = e.employee_no ORDER BY e.rowid'),
        findEmployee: opened.prepare('SELECT a.username, e.display_name, e.employee_no, e.hire_date FROM employees e JOIN accounts a ON a.employee_no = e.employee_no WHERE a.username = ?'),
        allEntitlements: opened.prepare('SELECT a.username, l.leave_type, l.year, l.granted_minutes FROM leave_entitlements l JOIN accounts a ON a.employee_no = l.employee_no ORDER BY l.year, l.rowid'),
        employeeEntitlements: opened.prepare(`SELECT a.username, l.leave_type, l.year, l.granted_minutes FROM leave_entitlements l JOIN accounts a ON a.employee_no = l.employee_no
          WHERE a.username = ? ORDER BY l.year, l.rowid`),
        employeeExists: opened.prepare('SELECT 1 AS found FROM accounts a JOIN employees e ON e.employee_no = a.employee_no WHERE a.username = ?'),
        // 參數依序為類型 id、帳號、起點路徑、新單終點、終點路徑、新單起點、排除單號：既有起點 < 新終點 且 既有終點 > 新起點 即重疊。
        ledgerOverlap: opened.prepare(`SELECT COUNT(*) AS total FROM tickets
          WHERE json_extract(document, '$.form.id') = ? AND json_extract(document, '$.requester.username') = ?
            AND json_extract(document, '$.status') IN ${ACTIVE_STATUSES}
            AND COALESCE(json_extract(document, '$.form.ledger.start'), json_extract(document, ?)) < ?
            AND COALESCE(json_extract(document, '$.form.ledger.end'), json_extract(document, ?)) > ?
            AND ticket_id <> ?`),
      };
      seeded = seedPersonnelIfEmpty(opened, seed ? normalizePersonnelSeed(seed) : null);
      const synced = opened.transaction(/** 依部門設定檔同步帳號的部門名稱。@returns {number} 更新筆數。 */ () => syncAccountDepartmentNames(opened, departments)).immediate();
      if (synced) logger('info', 'storage.department_names.synced', { accounts: synced });
    } catch (error) {
      opened.close();
      throw error;
    }
    db = opened;
    statements = prepared;
    dynamic = new Map();
    return { db, statements };
  }

  /**
   * 取得（必要時編譯並快取）一個動態 SQL 語句；只在連線已開啟時呼叫。
   * @param {string} sql SQL 文字（由允許清單的資料表與欄位名稱組成）。
   * @returns {import('better-sqlite3').Statement} 已編譯的語句。
   */
  function statement(sql) {
    if (!dynamic.has(sql)) dynamic.set(sql, db.prepare(sql));
    return dynamic.get(sql);
  }

  /**
   * 建立目前連線的交易內查詢；只在連線已開啟、交易內同步呼叫。
   * @returns {object} transactionHelpers 的結果。
   */
  function helpersOf() {
    return transactionHelpers(statements, statement, ledgerTables);
  }

  /**
   * 取得連線供 API 使用；開啟失敗轉成固定的 503，並在日誌記錄錯誤代碼。
   * @returns {object} db 與 statements。
   * @throws {HttpError} 503 TICKET_STORE_UNAVAILABLE。
   */
  function connection() {
    try { return openConnection(); } catch (error) { throw unavailable('load', error); }
  }

  /**
   * 執行資料庫操作，只把 SQLite 錯誤（code 以 SQLITE_ 開頭）轉成固定的 503；
   * 其他錯誤（例如修改函式拋出的 HttpError 或程式錯誤）原樣拋出，交易已由驅動回滾。
   * @param {string} operation 失敗時記錄的操作名稱（load、persist）。
   * @param {Function} task 同步操作。
   * @returns {*} 操作結果。
   * @throws {HttpError} 503，或 task 拋出的非 SQLite 錯誤。
   */
  function guarded(operation, task) {
    try { return task(); } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('SQLITE_')) throw unavailable(operation, error);
      throw error;
    }
  }

  /**
   * 取得檔案大小；記憶體資料庫回傳 null，檔案不存在（例如 WAL 已合併刪除）回傳 0。
   * @param {string} path 檔案路徑。
   * @returns {number|null} 位元組數。
   */
  function sizeOf(path) {
    if (file === ':memory:') return null;
    try { return statSync(path).size; } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  /**
   * 把 WAL 合併回主檔並截斷，讓已刪除的原文不留在 WAL；有其他讀取連線時只短暫等待，未完成就記錄警告。
   * @param {import('better-sqlite3').Database} database 已開啟的連線。
   * @returns {void}
   */
  function checkpoint(database) {
    try {
      database.pragma(`busy_timeout = ${CHECKPOINT_BUSY_TIMEOUT_MS}`);
      const [result] = database.pragma('wal_checkpoint(TRUNCATE)');
      if (result?.busy) logger('warn', 'tickets.store.checkpoint_failed', { busy: result.busy, walFrames: result.log, checkpointed: result.checkpointed });
    } catch (error) {
      logger('warn', 'tickets.store.checkpoint_failed', { errorCode: error?.code });
    } finally {
      database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
  }

  return {
    /**
     * 取得管理監測用的彙總數字：結構版本、各狀態筆數與資料庫／WAL 檔大小。只做計數，不讀出需求單內容欄位。
     * @returns {Promise<object>} schemaVersion、total、byStatus（PENDING、APPROVED、REJECTED、CANCELLED）、fileBytes、walBytes。
     * @throws {HttpError} 503 資料庫無法開啟或讀取。
     */
    async stats() {
      const { db: database, statements: sql } = connection();
      /** 以一次分組查詢統計各狀態筆數並讀取檔案大小。@returns {object} 彙總數字。 */
      function summarize() {
        const byStatus = { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0 };
        let total = 0;
        for (const row of sql.stats.all()) {
          total += row.total;
          if (row.status in byStatus) byStatus[row.status] = row.total;
        }
        return { schemaVersion: database.pragma('user_version', { simple: true }), total, byStatus,
          fileBytes: sizeOf(file), walBytes: sizeOf(`${file}-wal`) };
      }
      return guarded('load', summarize);
    },
    /**
     * 在維護鎖內清空所有需求單（secure_delete 覆寫頁面；帳號、員工與額度保留），再把 WAL 合併回主檔。呼叫端必須先阻擋新請求並排空既有工作，避免 AI 回覆在清空後重新寫入。
     * @returns {Promise<number>} 已清除的工作單筆數。
     * @throws {HttpError} 資料庫無法開啟或刪除失敗；失敗時整筆回滾，不重置其他保護計數。
     */
    async clear() {
      const { db: database, statements: sql } = connection();
      /** 刪除全部需求單。@returns {number} 刪除的需求單筆數。 */
      function deleteAll() { return sql.clear.run().changes; }
      const deleted = guarded('persist', database.transaction(deleteAll).immediate);
      checkpoint(database);
      return deleted;
    },
    /** 依建立順序取得所有需求單的複本。@returns {Promise<object[]>} 需求單陣列。@throws {HttpError} 503 資料庫無法讀取。 */
    async all() {
      const { statements: sql } = connection();
      /** 依建立順序讀出全部需求單。@returns {object[]} 需求單陣列。 */
      function readAll() { return sql.all.all().map(parseTicketRow); }
      return guarded('load', readAll);
    },
    /**
     * 依單號查詢。
     * @param {string} ticketId 單號。
     * @returns {Promise<object|null>} 需求單複本，查無時 null。
     * @throws {HttpError} 503 資料庫無法讀取。
     */
    async find(ticketId) {
      const { statements: sql } = connection();
      /** 讀出單張需求單。@returns {object|null} 需求單或 null。 */
      function readOne() { const row = sql.find.get(ticketId); return row ? parseTicketRow(row) : null; }
      return guarded('load', readOne);
    },
    /**
     * 新增一張需求單；單號重複視為程式錯誤。寫入失敗時不留下任何資料，呼叫端重送不會產生重複的需求單。
     * 提供 guard 時，guard 與寫入在同一筆 IMMEDIATE 交易內執行（例如需求類型 ledger 的重疊與剩餘額度檢查，只讀取），guard 拒絕時不寫入；
     * 只寫入 tickets 一列，不寫入額度相關資料表。
     * @param {object} ticket 已組好的需求單。
     * @param {object} [options={}] 選項。
     * @param {(helpers: object) => void} [options.guard] 同步檢查函式，收到 transactionHelpers 的交易內查詢；可拋出 HttpError 拒絕寫入。
     * @returns {Promise<object>} 寫入內容的複本。
     * @throws {HttpError} guard 拋出的錯誤，或 503 單號重複、寫入失敗。
     */
    async insert(ticket, { guard } = {}) {
      const { db: database, statements: sql } = connection();
      /** 執行檢查後寫入一列。@returns {object} SQLite 執行結果。@throws {HttpError} guard 拒絕。 */
      function writeOne() {
        if (guard) guard(helpersOf());
        return sql.insert.run(ticket.ticket_id, JSON.stringify(ticket));
      }
      guarded('persist', guard ? database.transaction(writeOne).immediate : writeOne);
      return structuredClone(ticket);
    },
    /**
     * 以修改函式更新一張需求單（簽核、退回、轉單、取消）；讀取、修改與寫回在同一筆 IMMEDIATE 交易內完成，修改函式拋錯時不寫入；
     * 只改寫 tickets 這一列，不寫入額度相關資料表（額度的扣除由人資在公司既有的系統處理）。
     * @param {string} ticketId 單號。
     * @param {(ticket: object, helpers: object) => object} mutate 同步修改函式，收到複本與交易內查詢（transactionHelpers），回傳的物件取代原記錄；可拋出 HttpError 拒絕更新。
     * @returns {Promise<object>} 更新後的複本。
     * @throws {HttpError} 404 TICKET_NOT_FOUND、修改函式拋出的錯誤或 503 寫入失敗。
     */
    async update(ticketId, mutate) {
      const { db: database, statements: sql } = connection();
      /** 讀取、修改並寫回單張需求單。@returns {object} 更新後的需求單。@throws {HttpError} 查無或修改函式拒絕。 */
      function apply() {
        const row = sql.find.get(ticketId);
        if (!row) throw new HttpError(404, 'TICKET_NOT_FOUND', '找不到這張需求單');
        const next = mutate(parseTicketRow(row), helpersOf());
        sql.update.run(JSON.stringify(next), ticketId);
        return next;
      }
      return structuredClone(guarded('persist', database.transaction(apply).immediate));
    },
    /**
     * 在同一個讀取快照（DEFERRED 交易）內執行 ledger 查詢，供「自動生成」的驗證與 AI 工具使用；fn 必須是同步函式。
     * @param {(helpers: object) => *} fn 收到 transactionHelpers 交易內查詢的同步函式。
     * @returns {Promise<*>} fn 的回傳值。
     * @throws {HttpError} 503 資料庫無法讀取；fn 拋出的其他錯誤原樣拋出。
     */
    async withLedger(fn) {
      const { db: database } = connection();
      /** 在讀取交易內執行。@returns {*} fn 的結果。 */
      function read() { return fn(helpersOf()); }
      return guarded('load', database.transaction(read).deferred);
    },
    /**
     * 查詢申請人某期間各類別的額度（額度、調整、已核准、待簽核與剩餘），在同一個讀取快照內計算。
     * @param {object} spec ledger 規格（需求類型的 ledgerSpec）。
     * @param {string} username 帳號。
     * @param {number} period 期間（年度）。
     * @returns {Promise<{known: boolean, balances: Array<object>}>} known 表示員工資料表有此帳號；balances 見 computeLedgerBalances。
     * @throws {HttpError} 503 資料庫無法讀取。
     */
    async ledgerBalances(spec, username, period) {
      /** 讀取員工是否存在並計算額度。@param {object} helpers 交易內查詢。@returns {{known: boolean, balances: Array<object>}} 結果。 */
      function read(helpers) { return { known: helpers.employeeExists(username), balances: helpers.ledgerBalances(spec, username, period) }; }
      const { db: database } = connection();
      /** 在讀取交易內計算。@returns {{known: boolean, balances: Array<object>}} 結果。 */
      function run() { return read(helpersOf()); }
      return guarded('load', database.transaction(run).deferred);
    },
    /**
     * 依寫入順序取得全部帳號列（含已停用與部門已不存在者），同步查詢、每次呼叫都讀取資料庫目前內容，不快取。
     * 共用這個儲存的唯一連線；第一次呼叫時才開啟資料庫（全新資料庫會先寫入人員名冊）。
     * @returns {Array<{username: string, department_id: string, role: string, active: number}>} 帳號列；active 為 1（啟用）或 0（停用）。
     * @throws {HttpError} 503 TICKET_STORE_UNAVAILABLE：資料庫無法開啟或讀取。
     */
    listAccounts() {
      const { statements: sql } = connection();
      /** 讀出全部帳號列。@returns {Array<object>} 帳號列。 */
      function readAll() { return sql.allAccounts.all(); }
      return guarded('load', readAll);
    },
    /**
     * 依帳號查詢一列（含已停用者），同步查詢、不快取；區分大小寫。
     * @param {string} username 帳號。
     * @returns {{username: string, department_id: string, role: string, active: number}|null} 帳號列，查無時 null。
     * @throws {HttpError} 503 TICKET_STORE_UNAVAILABLE：資料庫無法開啟或讀取。
     */
    findAccount(username) {
      const { statements: sql } = connection();
      /** 讀出單一帳號列。@returns {object|null} 帳號列或 null。 */
      function readOne() { return sql.findAccount.get(username) ?? null; }
      return guarded('load', readOne);
    },
    /**
     * 取得某部門啟用中的一般帳號列（不含管理員與已停用帳號），依寫入順序；同步查詢、不快取。
     * @param {string} departmentId 部門 id。
     * @returns {Array<{username: string, department_id: string, role: string, active: number}>} 帳號列。
     * @throws {HttpError} 503 TICKET_STORE_UNAVAILABLE：資料庫無法開啟或讀取。
     */
    departmentAccounts(departmentId) {
      const { statements: sql } = connection();
      /** 讀出部門的一般帳號列。@returns {Array<object>} 帳號列。 */
      function readDepartment() { return sql.departmentAccounts.all(departmentId); }
      return guarded('load', readDepartment);
    },
    /**
     * 依寫入順序取得全部員工基本資料與各年度額度（含所屬帳號已停用者），同步查詢、不快取；管理員沒有員工資料。
     * @returns {Array<{username: string, displayName: string, employeeNo: string, hireDate: string, entitlements: Array<{year: number, leaveType: string, minutes: number}>}>} 員工資料。
     * @throws {HttpError} 503 TICKET_STORE_UNAVAILABLE：資料庫無法開啟或讀取。
     */
    listEmployees() {
      const { db: database, statements: sql } = connection();
      /** 在同一個讀取快照內讀出員工與額度。@returns {Array<object>} 員工資料。 */
      function readAll() { return toEmployees(sql.allEmployees.all(), sql.allEntitlements.all()); }
      return guarded('load', database.transaction(readAll).deferred);
    },
    /**
     * 依帳號查詢一位員工的基本資料與各年度額度，同步查詢、不快取；區分大小寫。
     * @param {string} username 帳號。
     * @returns {{username: string, displayName: string, employeeNo: string, hireDate: string, entitlements: Array<object>}|null} 員工資料，查無時 null。
     * @throws {HttpError} 503 TICKET_STORE_UNAVAILABLE：資料庫無法開啟或讀取。
     */
    findEmployee(username) {
      const { db: database, statements: sql } = connection();
      /** 在同一個讀取快照內讀出員工與額度。@returns {object|null} 員工資料或 null。 */
      function readOne() {
        const row = sql.findEmployee.get(username);
        return row ? toEmployees([row], sql.employeeEntitlements.all(username))[0] : null;
      }
      return guarded('load', database.transaction(readOne).deferred);
    },
    /**
     * 開啟資料庫（套用結構遷移；帳號表為空時寫入人員名冊）並匯入尚未匯入的舊版 tickets.json；啟動時呼叫，讓設定錯誤在監聽前就失敗。
     * 只在完全沒有匯入紀錄時自動匯入；初始化時沒有舊檔、之後才出現的舊檔只回報 legacy-appeared，不會自動匯入（不傳 importLate）。
     * 錯誤原樣拋出，保留 NODE_TOO_OLD、DIRECTORY_MISSING、FOREIGN_DATABASE、SCHEMA_TOO_NEW、PERSONNEL_UNMAPPED、PERSONNEL_INVALID、LEGACY_* 或 SQLite 代碼供啟動日誌區分原因。
     * @param {object} options 選項。
     * @param {string} options.legacyFile 舊版 JSON 檔路徑。
     * @returns {Promise<object>} importLegacyTickets 的結果摘要，另含 seeded（本次開啟時寫入的 accounts、employees、entitlements 筆數；
     *   資料庫已有帳號時不寫入，皆為 0）。
     * @throws {Error} 資料庫無法開啟、名冊寫入或匯入失敗（訊息不含需求單原文）。
     */
    async prepare({ legacyFile }) {
      const { db: database } = openConnection();
      return { ...importLegacyTickets(database, { legacyFile }), seeded: { ...seeded } };
    },
    /**
     * 取得本機登入簽章金鑰：讀取 meta 表的 local_auth_secret，沒有時產生 32 bytes 隨機值保存後回傳。
     * 只在未設定 AUTH_SECRET（本機）時使用，讓重新啟動後既有登入仍有效；production 一律要求 AUTH_SECRET，不會走到這裡。
     * @returns {string} 64 個十六進位字元的金鑰（呼叫端不得記錄或回傳給前端）。
     * @throws {HttpError} 503 TICKET_STORE_UNAVAILABLE：資料庫無法開啟或寫入。
     */
    localAuthSecret() {
      const { db: database } = connection();
      /** 讀取或建立金鑰。@returns {string} 金鑰。 */
      function readOrCreate() { return ensureMetaSecret(database, 'local_auth_secret'); }
      return guarded('persist', readOrCreate);
    },
    /** 關閉資料庫連線；之後再操作會重新開啟。關機與測試清理時使用。@returns {void} */
    close() {
      if (!db) return;
      db.close();
      db = undefined;
      statements = undefined;
      dynamic = new Map();
    },
  };
}

export const dataStore = createSqliteDataStore();
