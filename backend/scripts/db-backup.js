import { env } from '../src/config/env.js';
import { openTicketDatabase, backupTicketDatabase } from '../src/services/storage/database.js';
import { logger } from '../src/utils/logger.js';

/**
 * 在服務執行中產生 DATABASE_FILE 的一致備份（VACUUM INTO），並驗證完整性；只輸出筆數與結構版本。
 * 不可直接複製執行中的 .db 檔，否則可能漏掉仍在 -wal 檔中的內容。
 * @param {string[]} args 命令列參數，第一個是備份檔路徑（必須不存在）。
 * @returns {void}
 * @throws {Error} 缺少輸出路徑、資料庫無法開啟或備份驗證失敗。
 */
function main([output]) {
  if (!output) throw new Error('用法：node scripts/db-backup.js <備份檔路徑>');
  const db = openTicketDatabase(env.databaseFile, { readonly: true });
  try {
    const summary = backupTicketDatabase(db, output);
    logger('info', 'storage.backup.completed', summary);
  } finally { db.close(); }
}

try { main(process.argv.slice(2)); } catch (error) {
  logger('error', 'storage.backup.failed', { detail: String(error?.message || '').slice(0, 200), sqliteCode: error?.code });
  process.exitCode = 1;
}
