import { env } from '../src/config/env.js';
import { restoreTicketDatabase } from '../src/services/storage/database.js';
import { logger } from '../src/utils/logger.js';

/**
 * 以備份檔取代 DATABASE_FILE。必須先停止後端再執行（仍有連線開著時以 DATABASE_IN_USE 拒絕）：
 * 備份以唯讀方式開啟後用 VACUUM INTO 寫成 <檔名>.restore-tmp（含備份旁 -wal 中已提交的內容）並驗證筆數一致；
 * 目前的資料庫連同 -wal／-shm 一起改名保留為 <檔名>.before-restore-<UTC 時間，精確到秒>（-wal／-shm 加上相同後綴），
 * 主檔不存在但有殘留的 -wal／-shm 時也把殘留檔改名保留（日誌的 strandedSidecars 為移開的檔案數），避免與備份配對；
 * 再放入驗證過的備份；最後一步失敗時把舊檔改回原名。同一秒內再次還原、保留檔名已存在時以 PREVIOUS_EXISTS 拒絕，
 * 不覆蓋先前保留的副本。
 * @param {string[]} args 命令列參數，第一個是備份檔路徑。
 * @returns {void}
 * @throws {Error} 缺少備份路徑、備份檔驗證失敗（含 BACKUP_NOT_SELF_CONTAINED）、PREVIOUS_EXISTS 或檔案操作失敗。
 */
function main([source]) {
  if (!source) throw new Error('用法：node scripts/db-restore.js <備份檔路徑>（請先停止後端）');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const result = restoreTicketDatabase(env.databaseFile, source, stamp);
  logger('info', 'storage.restore.completed', {
    tickets: result.restored.tickets, schemaVersion: result.restored.schemaVersion, keptPrevious: Boolean(result.previous),
    strandedSidecars: result.strandedSidecars.length,
  });
}

try { main(process.argv.slice(2)); } catch (error) {
  // 回滾也失敗時，正式位置可能沒有資料庫：記錄保留的暫存檔、舊主檔與所有已移開檔案的路徑，供人工改名復原，重啟後端前務必先處理。
  const recovery = error?.rollbackError
    ? { rollbackFailed: true, rollbackCode: error.rollbackError?.code, stagedFile: error.stagedFile, previousFile: error.previousFile, movedFiles: error.movedFiles }
    : {};
  logger('error', 'storage.restore.failed', { detail: String(error?.message || '').slice(0, 200), sqliteCode: error?.code, ...recovery });
  process.exitCode = 1;
}
