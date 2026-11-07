import { env } from '../src/config/env.js';
import { openTicketDatabase, exportTicketsJson } from '../src/services/storage/database.js';
import { logger } from '../src/utils/logger.js';

/**
 * 把 DATABASE_FILE 的需求單依建立順序匯出成舊版 tickets.json 格式，供回滾到 JSON 版映像。
 * 以唯讀方式開啟資料庫，服務執行中也可使用；輸出檔含需求單原文，不得提交 Git。
 * @param {string[]} args 命令列參數，第一個是輸出檔路徑（必須不存在）。
 * @returns {void}
 * @throws {Error} 缺少輸出路徑、資料庫無法開啟或輸出檔已存在。
 */
function main([output]) {
  if (!output) throw new Error('用法：node scripts/export-tickets-json.js <輸出的 tickets.json 路徑>');
  const db = openTicketDatabase(env.databaseFile, { readonly: true });
  try {
    const count = exportTicketsJson(db, output);
    logger('info', 'storage.export.completed', { tickets: count });
  } finally { db.close(); }
}

try { main(process.argv.slice(2)); } catch (error) {
  logger('error', 'storage.export.failed', { detail: String(error?.message || '').slice(0, 200), sqliteCode: error?.code });
  process.exitCode = 1;
}
