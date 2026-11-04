import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';
import { openTicketDatabase, LEAVE_TYPES } from '../src/services/storage/database.js';
import { formatHoursMinutes } from '../src/utils/dates.js';
import { logger } from '../src/utils/logger.js';

const USAGE = `用法（以後端的環境設定執行，資料庫為 DATABASE_FILE；唯讀，服務執行中也可使用）：
  node scripts/leave-log.js [--user <帳號>] [--year <四位數年度>] [--leave-type <事假|病假|特休>] [--json]
列出請假額度異動紀錄（leave_log）：每次送出、簽核、退回、取消、人資調整與年度額度變更各一列，含異動前後的剩餘時數；
不加條件時列出全部，--json 改輸出 JSON 陣列（數量與剩餘以分鐘為單位）`;

// 事件的中文名稱：送出時就先扣（待簽核），簽核只把待簽核轉為已使用，退回與取消把時數還回去
const EVENT_LABELS = Object.freeze({ SUBMITTED: '送出', APPROVED: '簽核', REJECTED: '退回', CANCELLED: '取消', ADJUSTED: '人資調整', GRANTED: '年度額度變更' });
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 解析命令列參數；未知選項或格式錯誤時拋出用法錯誤
 * @param {string[]} argv 命令列參數（不含 node 與腳本路徑）
 * @returns {{user: string|null, year: number|null, leaveType: string|null, json: boolean}} 篩選條件與輸出格式
 * @throws {Error} code USAGE：參數不符
 */
function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, strict: true, options: {
      user: { type: 'string' }, year: { type: 'string' }, 'leave-type': { type: 'string' }, json: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    } });
  } catch (error) {
    throw Object.assign(new Error(`參數錯誤：${error.message}`), { code: 'USAGE' });
  }
  const { values } = parsed;
  if (values.help) throw Object.assign(new Error('顯示用法'), { code: 'USAGE' });
  if (values.year !== undefined && !/^\d{4}$/u.test(values.year)) throw Object.assign(new Error('--year 必須是四位數年度'), { code: 'USAGE' });
  if (values['leave-type'] !== undefined && !LEAVE_TYPES.includes(values['leave-type'])) throw Object.assign(new Error(`--leave-type 只能是 ${LEAVE_TYPES.join('、')}`), { code: 'USAGE' });
  return { user: values.user ?? null, year: values.year ? Number(values.year) : null, leaveType: values['leave-type'] ?? null, json: values.json };
}

/**
 * 把 ISO 時間轉成台北時間「YYYY-MM-DD HH:mm」
 * @param {string} iso ISO 時間字串
 * @returns {string} 台北時間；無法解析時原樣回傳
 */
function taipeiTime(iso) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Date(time + TAIPEI_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * 把一列紀錄排成一行易讀的文字：時間、事件、員工、假別與年度、本次時數、剩餘（前 → 後）、請假期間、單號、操作者與備註
 * @param {object} row leave_log 的一列
 * @returns {string} 一行文字（欄位以「｜」分隔）
 */
function describe(row) {
  const change = row.event === 'ADJUSTED' || row.event === 'GRANTED' ? `增減 ${formatHoursMinutes(row.minutes)}` : `請假 ${formatHoursMinutes(row.minutes)}`;
  const period = row.start_at && row.end_at ? `期間 ${row.start_at.replace('T', ' ')}～${row.end_at.replace('T', ' ')}` : '';
  const reference = row.ticket_id ? `單號 ${row.ticket_id}` : row.adjustment_id ? `調整 #${row.adjustment_id}` : '';
  return [taipeiTime(row.at), EVENT_LABELS[row.event] ?? row.event, row.username, `${row.leave_type} ${row.year}`, change,
    `剩餘 ${formatHoursMinutes(row.remaining_before_minutes)} → ${formatHoursMinutes(row.remaining_after_minutes)}`, period, reference,
    `操作者 ${row.by_username}`, row.comment ? `備註 ${row.comment}` : '', row.source === 'backfill' ? '（升級時回填）' : '']
    .filter(Boolean).join('｜');
}

/**
 * 以唯讀方式開啟資料庫並依條件列出請假額度異動紀錄；資料庫必須已升級到結構版本 4（含 leave_log）
 * @param {string[]} argv 命令列參數
 * @returns {void}
 * @throws {Error} 參數錯誤、資料庫不存在、版本較舊或無法讀取
 */
function main(argv) {
  const options = parseOptions(argv);
  if (!existsSync(env.databaseFile)) throw new Error('資料庫檔不存在；請先啟動後端一次');
  const db = openTicketDatabase(env.databaseFile, { readonly: true });
  try {
    if (db.pragma('user_version', { simple: true }) < 4) throw new Error('資料庫尚未升級到結構版本 4（沒有 leave_log）；請先啟動後端一次完成升級');
    const rows = db.prepare(`SELECT * FROM leave_log WHERE (? IS NULL OR username = ?) AND (? IS NULL OR year = ?) AND (? IS NULL OR leave_type = ?) ORDER BY id`)
      .all(options.user, options.user, options.year, options.year, options.leaveType, options.leaveType);
    if (options.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    else process.stdout.write(rows.length ? `${rows.map(describe).join('\n')}\n` : '沒有符合條件的紀錄\n');
  } finally { db.close(); }
}

try { main(process.argv.slice(2)); } catch (error) {
  if (error?.code === 'USAGE') {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
  } else {
    logger('error', 'leave_log.read_failed', { detail: String(error?.message || '').slice(0, 200), sqliteCode: error?.code });
  }
  process.exitCode = 1;
}
