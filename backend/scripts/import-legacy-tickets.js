import { existsSync } from 'node:fs';
import { env } from '../src/config/env.js';
import { openTicketDatabase, importLegacyTickets } from '../src/services/storage/database.js';
import { logger } from '../src/utils/logger.js';

/**
 * 判斷預覽時是否要改用記憶體資料庫：DATABASE_FILE 不存在，或存在但尚未初始化（例如 0 位元組、user_version 為 0）時，
 * 檔案裡沒有 meta／tickets 資料表，唯讀開啟後查詢會出現「no such table」，因此改用記憶體資料庫驗證舊檔。
 * 已存在的檔案只以唯讀方式探查、不套用遷移，並沿用 openTicketDatabase 的身分檢查拒絕其他程式的 SQLite 檔。
 * @param {string} file DATABASE_FILE 路徑。
 * @returns {boolean} 需要改用記憶體資料庫時 true。
 * @throws {Error} 檔案不是本服務資料庫（FOREIGN_DATABASE）、版本過新或無法開啟。
 */
function needsScratchDatabase(file) {
  if (!existsSync(file)) return true;
  const probe = openTicketDatabase(file, { readonly: true });
  try { return probe.pragma('user_version', { simple: true }) < 1; } finally { probe.close(); }
}

/**
 * 預覽或執行舊版 tickets.json（TICKETS_FILE）匯入 SQLite（DATABASE_FILE）。服務啟動時只在完全沒有匯入紀錄時自動匯入，
 * 這支腳本主要用 --dry-run 先確認筆數與格式；輸出只含狀態、筆數與雜湊，不含需求單原文。
 * 預覽不改動任何檔案：資料庫已初始化時以唯讀開啟（不套用結構遷移），還不存在或尚未初始化時改用記憶體資料庫驗證。
 * 初始化時沒有舊檔（匯入紀錄為 none）、之後才放入的舊檔不會自動匯入（回報 legacy-appeared）；確認要匯入時加上
 * --import-late，只有資料表為空時才匯入並取代匯入紀錄，否則以 LEGACY_CONFLICT 拒絕。
 * @param {string[]} args 命令列參數，可含 --dry-run 與 --import-late。
 * @returns {void}
 * @throws {Error} 資料庫無法開啟、舊檔格式錯誤或不能合併（LEGACY_CONFLICT）。
 */
function main(args) {
  const dryRun = args.includes('--dry-run');
  const importLate = args.includes('--import-late');
  const db = dryRun && needsScratchDatabase(env.databaseFile) ? openTicketDatabase(':memory:') : openTicketDatabase(env.databaseFile, { readonly: dryRun });
  try {
    const result = importLegacyTickets(db, { legacyFile: env.ticketsFile, dryRun, importLate });
    logger('info', 'storage.legacy_import', { dryRun, importLate, ...result });
  } finally { db.close(); }
}

try { main(process.argv.slice(2)); } catch (error) {
  logger('error', 'storage.legacy_import_failed', { detail: String(error?.message || '').slice(0, 200), sqliteCode: error?.code });
  process.exitCode = 1;
}
