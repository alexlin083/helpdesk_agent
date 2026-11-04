import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';
import { openTicketDatabase, SCHEMA_VERSION } from '../src/services/storage/database.js';
import { createPersonnelAdmin, assertPersonnelSchema, personnelError } from '../src/services/personnel/personnel.js';
import { departmentService } from '../src/services/departmentService.js';
import { getRequestTypes } from '../src/services/requestTypes/registry.js';
import { logger } from '../src/utils/logger.js';

const USAGE = `用法（以後端的環境設定執行，資料庫為 DATABASE_FILE）：
  node scripts/personnel.js list [--department <部門 id>]
  node scripts/personnel.js add <username> --department <部門 id> [--role USER|ADMIN] [--name <顯示名稱> --employee-no <員工編號> --hire-date YYYY-MM-DD] [--dry-run]
  node scripts/personnel.js set-department <username> <部門 id> [--dry-run]
  node scripts/personnel.js deactivate <username> [--dry-run]
  node scripts/personnel.js activate <username> [--dry-run]
  node scripts/personnel.js grant <username> <假別> <年度> <分鐘> [--dry-run]
一般帳號（USER）新增時必須提供 --name、--employee-no、--hire-date；管理員（ADMIN）沒有員工資料。
不提供刪除帳號：請改用 deactivate（需求單保留歷史）。--dry-run 不寫入任何內容，只輸出會改變的項目。`;

// 每個子指令需要的位置參數數量（不含子指令本身）。
const ARITY = Object.freeze({ list: 0, add: 1, 'set-department': 2, deactivate: 1, activate: 1, grant: 4 });

/**
 * 解析命令列參數；未知選項、子指令或位置參數數量不符時拋出用法錯誤。
 * @param {string[]} argv 命令列參數（不含 node 與腳本路徑）。
 * @returns {{command: string, args: string[], options: object}} 子指令、位置參數與選項（department、role、name、employee-no、hire-date、dry-run）。
 * @throws {Error} code USAGE：參數不符。
 */
function parseCommand(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      department: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' }, 'employee-no': { type: 'string' },
      'hire-date': { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    } });
  } catch (error) {
    throw Object.assign(new Error(`參數錯誤：${error.message}`), { code: 'USAGE' });
  }
  const [command, ...args] = parsed.positionals;
  if (parsed.values.help || !command) throw Object.assign(new Error('請指定子指令'), { code: 'USAGE' });
  if (!(command in ARITY) || args.length !== ARITY[command]) throw Object.assign(new Error(`子指令或參數數量不符：${command}`), { code: 'USAGE' });
  return { command, args, options: parsed.values };
}

/**
 * 開啟資料庫：列表與預覽（--dry-run）以唯讀開啟、不套用遷移，因此不寫入任何內容；資料庫必須已存在且已升級到目前版本。
 * 正式寫入以讀寫開啟（必要時套用遷移，但不寫入示範名冊：在全新資料庫先新增帳號時，服務啟動就不會再寫入示範名冊）。
 * 兩者都沿用 openTicketDatabase 的 WAL 與 busy timeout 5000 ms，可在後端執行中使用；後端每次請求都重新查詢，不需重啟。
 * @param {boolean} readonly 是否唯讀。
 * @returns {import('better-sqlite3').Database} 資料庫連線。
 * @throws {Error} code PERSONNEL_SCHEMA_OLD（唯讀時版本較舊）、PERSONNEL_NOT_FOUND（唯讀時檔案不存在），或 openTicketDatabase 的錯誤。
 */
function openDatabase(readonly) {
  if (readonly && !existsSync(env.databaseFile)) throw personnelError('PERSONNEL_NOT_FOUND', '資料庫檔不存在；請先啟動後端一次，或執行不含 --dry-run 的指令');
  const db = openTicketDatabase(env.databaseFile, { readonly });
  try {
    assertPersonnelSchema(db, SCHEMA_VERSION);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * 依子指令執行人員資料操作並輸出結果；結果以 JSON 寫到 stdout，另記錄 storage.personnel.* 事件
 * （只含帳號、部門 id、角色、啟用狀態與額度數字，不含員工姓名或員工編號）。
 * @param {string[]} argv 命令列參數。
 * @returns {void}
 * @throws {Error} 參數、驗證或資料庫錯誤。
 */
function main(argv) {
  const { command, args, options } = parseCommand(argv);
  const dryRun = options['dry-run'];
  const db = openDatabase(command === 'list' || dryRun);
  try {
    // grant 改年度額度時在 leave_log 記一列 GRANTED，需要使用 leave_entitlements 的需求類型（請假）的 ledger 規格計算前後剩餘
    const ledgerSpec = command === 'grant' ? getRequestTypes().ledgerOwner('leave_entitlements')?.ledgerSpec ?? null : null;
    const admin = createPersonnelAdmin(db, { departments: departmentService, ledgerSpec });
    if (command === 'list') {
      const rows = admin.list({ department: options.department });
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      logger('info', 'storage.personnel.listed', { department: options.department ?? null, count: rows.length });
      return;
    }
    const [username] = args;
    let result;
    if (command === 'add') {
      result = admin.add({ username, department: options.department, role: options.role ?? 'USER', name: options.name, employeeNo: options['employee-no'], hireDate: options['hire-date'] }, { dryRun });
    } else if (command === 'set-department') {
      result = admin.setDepartment(username, args[1], { dryRun });
    } else if (command === 'deactivate' || command === 'activate') {
      result = admin.setActive(username, command === 'activate', { dryRun });
    } else {
      result = admin.grant(username, args[1], args[2], args[3], { dryRun });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    logger('info', dryRun ? 'storage.personnel.dry_run' : 'storage.personnel.changed', result);
  } finally { db.close(); }
}

try { main(process.argv.slice(2)); } catch (error) {
  if (error?.code === 'USAGE') process.stderr.write(`${error.message}\n${USAGE}\n`);
  logger('error', 'storage.personnel.failed', { reason: typeof error?.code === 'string' ? error.code : 'PERSONNEL_FAILED', detail: String(error?.message || '').slice(0, 200) });
  process.exitCode = error?.code === 'USAGE' ? 2 : 1;
}
