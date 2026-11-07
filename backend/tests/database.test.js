import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, statSync, renameSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestEnv } from './helpers/testEnv.js';

const scratch = mkdtempSync(join(tmpdir(), 'helpdesk-database-'));
setupTestEnv();
const {
  openTicketDatabase, importLegacyTickets, exportTicketsJson, backupTicketDatabase, inspectTicketDatabase,
  restoreTicketDatabase, assertSupportedNode, parseTicketRow, migrate, moveDatabaseFiles, SCHEMA_VERSION, APPLICATION_ID,
} = await import('../src/services/storage/database.js');
const { createSqliteDataStore } = await import('../src/services/storage/dataStore.js');
const Database = createRequire(import.meta.url)('better-sqlite3');
const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const databaseModuleUrl = new URL('../src/services/storage/database.js', import.meta.url).href;

const opened = [];
/**
 * 開啟測試用資料庫並登記到結束時關閉的清單。
 * @param {string} name 暫存目錄中的檔名，或 ':memory:'。
 * @returns {import('better-sqlite3').Database} 資料庫連線。
 */
function open(name) {
  const db = openTicketDatabase(name === ':memory:' ? name : join(scratch, name));
  opened.push(db);
  return db;
}
/** 關閉所有連線後刪除暫存目錄（Windows 不能刪除仍開啟的檔案）。@returns {void} */
function cleanup() {
  for (const db of opened) if (db.open) db.close();
  rmSync(scratch, { recursive: true, force: true });
}
test.after(cleanup);

/**
 * 計算資料表中的需求單筆數。
 * @param {import('better-sqlite3').Database} db 資料庫連線。
 * @returns {number} 筆數。
 */
function countTickets(db) { return db.prepare('SELECT COUNT(*) AS total FROM tickets').get().total; }

/**
 * 取出需求單的單號，供比對順序。
 * @param {object} ticket 需求單。
 * @returns {string} 單號。
 */
function idOf(ticket) { return ticket.ticket_id; }

/**
 * 以指定參數呼叫同步函式，斷言它拋出符合條件的錯誤；取代 assert.throws 的行內箭頭函式。
 * @param {Function} task 要呼叫的同步函式。
 * @param {unknown[]} args 呼叫參數。
 * @param {object|RegExp|Function} expected 錯誤需符合的條件，與 assert.throws 的第二個參數相同。
 * @param {string} [message] 斷言失敗時的說明。
 * @returns {void}
 */
function assertCallThrows(task, args, expected, message) {
  assert.throws(task.bind(null, ...args), expected, message);
}

/**
 * 以指定參數呼叫同步函式，斷言它沒有拋出錯誤；取代 assert.doesNotThrow 的行內箭頭函式。
 * @param {Function} task 要呼叫的同步函式。
 * @param {unknown[]} args 呼叫參數。
 * @param {string} [message] 斷言失敗時的說明。
 * @returns {void}
 */
function assertCallSucceeds(task, args, message) {
  assert.doesNotThrow(task.bind(null, ...args), message);
}

/**
 * 複製需求單並移除指定欄位，用來產生缺欄位的舊版資料。
 * @param {object} ticket 原需求單。
 * @param {string} field 要移除的第一層欄位名稱。
 * @returns {object} 不含該欄位的複本。
 */
function without(ticket, field) {
  const copy = structuredClone(ticket);
  delete copy[field];
  return copy;
}

/**
 * 組出執行維運腳本用的環境變數：以 production 模式執行，完全不讀取本機 .env，只提供測試用的假設定與指定檔案路徑。
 * @param {object} files 檔案路徑。
 * @param {string} files.databaseFile 測試用 DATABASE_FILE。
 * @param {string} files.ticketsFile 測試用 TICKETS_FILE。
 * @returns {object} 子程序環境變數。
 */
function scriptEnvironment({ databaseFile, ticketsFile }) {
  const environment = {
    NODE_ENV: 'production', LOG_LEVEL: 'info', AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-only-fake-model-key', CORS_ORIGIN: 'http://localhost:5173',
    AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef', ADMIN_PASSWORD: 'test-admin-only-password', DEMO_PASSWORD: 'test-only-password',
    DATABASE_FILE: databaseFile, TICKETS_FILE: ticketsFile,
  };
  // Windows 的子程序需要 SystemRoot 才能正常初始化；只複製存在的值。
  for (const name of ['PATH', 'Path', 'SystemRoot']) if (process.env[name]) environment[name] = process.env[name];
  return environment;
}

/**
 * 執行 backend/scripts 下的腳本並解析輸出的 JSON 日誌；非 JSON 的行（例如 Node 警告）略過。
 * @param {string} script 腳本檔名。
 * @param {string[]} args 命令列參數。
 * @param {object} files 傳給 scriptEnvironment 的檔案路徑。
 * @returns {{status: number|null, records: object[]}} 結束代碼與日誌紀錄。
 */
function runScript(script, args, files) {
  const result = spawnSync(process.execPath, [join(backendRoot, 'scripts', script), ...args], { cwd: backendRoot, env: scriptEnvironment(files), encoding: 'utf8' });
  const records = [];
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try { records.push(JSON.parse(line)); } catch { /* 不是日誌的輸出行略過。 */ }
  }
  return { status: result.status, records };
}

// 假需求單：欄位順序與正式寫入相同，內容與實際環境無關。
const legacy = [
  { ticket_id: 'TK-legacy-1', created_at: '2026-10-01T01:00:00.000Z', updated_at: '2026-10-01T01:00:00.000Z', requester: { user_id: 'user-test.one', username: 'test.one', department_id: 'dept-x', department_name: '測試部' }, subject: '測試主題', content: '測試內容', status: 'PENDING', decision: null, history: [{ at: '2026-10-01T01:00:00.000Z', event: 'SUBMITTED', by_user_id: 'user-test.one', by_username: 'test.one' }], route: 'HANDLER', department_id: 'dept-x', department_name: '測試部', handler: { id: 'test.two', name: 'test.two' }, judgement: null },
  { ticket_id: 'TK-legacy-2', created_at: '2026-10-02T00:30:00.000Z', updated_at: '2026-10-02T01:00:00.000Z', requester: { user_id: 'user-test.three', username: 'test.three', department_id: 'dept-y', department_name: '測試二部' }, subject: '測試主題二', content: '測試內容二', status: 'APPROVED', decision: { by_user_id: 'user-test.two', by_username: 'test.two', at: '2026-10-02T01:00:00.000Z', comment: '' }, history: [{ at: '2026-10-02T00:30:00.000Z', event: 'SUBMITTED', by_user_id: 'user-test.three', by_username: 'test.three' }, { at: '2026-10-02T01:00:00.000Z', event: 'APPROVED', by_user_id: 'user-test.two', by_username: 'test.two' }], route: 'APPROVER', department_id: 'dept-x', department_name: '測試部', handler: null, judgement: { ai_department_id: null, confidence_score: 40, basis: '', model: 'test-model' } },
];

/**
 * 驗證舊版 tickets.json 匯入：預覽不寫入、單一交易依序匯入且與原檔完全相同、可重複執行、
 * 舊檔被改動或無法讀取只回報不合併，以及格式錯誤與資料庫已有資料時的處理。
 * 初始化時沒有舊檔（none 紀錄）之後才出現的舊檔，不論資料庫是否為空都只回報 legacy-appeared，
 * 只有明確指定 importLate 且資料表為空時才匯入。
 * @returns {Promise<void>}
 */
async function legacyImport() {
  const legacyFile = join(scratch, 'tickets.json');
  writeFileSync(legacyFile, `﻿${JSON.stringify(legacy, null, 2)}\n`);
  const db = open('import.db');
  const preview = importLegacyTickets(db, { legacyFile, dryRun: true });
  assert.equal(preview.status, 'would-import');
  assert.equal(preview.count, 2);
  assert.equal(countTickets(db), 0, '預覽不寫入');
  const imported = importLegacyTickets(db, { legacyFile });
  assert.equal(imported.status, 'imported');
  assert.equal(imported.count, 2);
  const store = createSqliteDataStore({ file: join(scratch, 'import.db') });
  assert.deepEqual(await store.all(), legacy, '匯入後的形狀、欄位順序與建立順序和原檔相同（含 BOM 的檔案）');
  store.close();
  assert.equal(importLegacyTickets(db, { legacyFile }).status, 'already-imported');
  assert.equal(readFileSync(legacyFile, 'utf8'), `﻿${JSON.stringify(legacy, null, 2)}\n`, '舊檔不被修改');
  writeFileSync(legacyFile, '[]');
  assert.equal(importLegacyTickets(db, { legacyFile }).status, 'legacy-changed');
  assert.equal(countTickets(db), 2, '舊檔改動後不合併');
  rmSync(legacyFile);
  mkdirSync(legacyFile);
  const unreadable = importLegacyTickets(db, { legacyFile });
  assert.equal(unreadable.status, 'legacy-unreadable', '已匯入後舊檔無法讀取只回報，不讓服務啟動失敗');
  assert.ok(unreadable.errorCode);
  assertCallThrows(importLegacyTickets, [open(':memory:'), { legacyFile }], { code: 'LEGACY_UNREADABLE' }, '尚未匯入時無法讀取就拒絕');

  const late = open('late.db');
  const lateFile = join(scratch, 'late.json');
  assert.equal(importLegacyTickets(late, { legacyFile: lateFile }).status, 'no-legacy-file');
  assert.equal(importLegacyTickets(late, { legacyFile: lateFile }).status, 'already-imported');
  writeFileSync(lateFile, JSON.stringify(legacy));
  const appeared = importLegacyTickets(late, { legacyFile: lateFile });
  assert.equal(appeared.status, 'legacy-appeared', '初始化時沒有舊檔、之後才放入的舊檔即使資料庫是空的也不自動匯入');
  assert.equal(appeared.count, 0);
  assert.equal(countTickets(late), 0);
  assert.equal(importLegacyTickets(late, { legacyFile: lateFile, importLate: true, dryRun: true }).status, 'would-import', '明確指定時可先預覽');
  assert.equal(countTickets(late), 0, '預覽不寫入');
  const lateImported = importLegacyTickets(late, { legacyFile: lateFile, importLate: true });
  assert.equal(lateImported.status, 'imported', '明確指定 importLate 且資料表為空時才匯入');
  assert.equal(countTickets(late), 2);
  assert.equal(importLegacyTickets(late, { legacyFile: lateFile }).status, 'already-imported', 'none 紀錄已在同一筆交易內被取代');

  const busy = open('busy.db');
  const busyFile = join(scratch, 'busy.json');
  importLegacyTickets(busy, { legacyFile: busyFile });
  busy.prepare('INSERT INTO tickets (ticket_id, document) VALUES (?, ?)').run('TK-new', '{"ticket_id":"TK-new"}');
  writeFileSync(busyFile, JSON.stringify(legacy));
  assert.equal(importLegacyTickets(busy, { legacyFile: busyFile }).status, 'legacy-appeared', '資料庫已有新單時不合併');
  assertCallThrows(importLegacyTickets, [busy, { legacyFile: busyFile, importLate: true }], { code: 'LEGACY_CONFLICT' }, '明確指定時資料表不是空的就拒絕');
  assert.equal(countTickets(busy), 1);
  busy.prepare('DELETE FROM tickets').run();
  assert.equal(importLegacyTickets(busy, { legacyFile: busyFile }).status, 'legacy-appeared', '管理端清空後重啟不會把過期的舊單匯回來');
  assert.equal(countTickets(busy), 0);

  const broken = join(scratch, 'broken.json');
  const [complete] = legacy;
  const invalidCases = [
    ['{"not":"array"}', /不是 JSON 陣列/], ['[{"status":"PENDING"}]', /第 0 筆缺少 ticket_id/],
    [JSON.stringify([complete, complete]), /第 1 筆的 ticket_id 重複/], ['not json', /不是有效的 JSON/],
    [JSON.stringify([complete, without(legacy[1], 'created_at')]), /第 1 筆的 created_at 欄位/],
    [JSON.stringify([{ ...complete, updated_at: 20261001 }]), /第 0 筆的 updated_at 欄位/],
    [JSON.stringify([{ ...complete, status: 'FAKE-STATUS-VALUE' }]), /第 0 筆的 status 欄位/],
    [JSON.stringify([without(complete, 'department_id')]), /第 0 筆的 department_id 欄位/],
    [JSON.stringify([{ ...complete, department_name: null }]), /第 0 筆的 department_name 欄位/],
    [JSON.stringify([without(complete, 'requester')]), /第 0 筆的 requester 欄位/],
    [JSON.stringify([{ ...complete, requester: { username: 'test.one' } }]), /第 0 筆的 requester\.user_id 欄位/],
    [JSON.stringify([{ ...complete, history: 'FAKE-HISTORY-VALUE' }]), /第 0 筆的 history 欄位/],
    [JSON.stringify([without(complete, 'subject')]), /第 0 筆的 subject 欄位/],
    [JSON.stringify([{ ...complete, subject: 12345 }]), /第 0 筆的 subject 欄位/],
    [JSON.stringify([{ ...complete, subject: ' \t ' }]), /第 0 筆的 subject 欄位/],
    [JSON.stringify([{ ...complete, created_at: '' }]), /第 0 筆的 created_at 欄位/],
    [JSON.stringify([{ ...complete, updated_at: '   ' }]), /第 0 筆的 updated_at 欄位/],
    [JSON.stringify([{ ...complete, department_id: ' ' }]), /第 0 筆的 department_id 欄位/],
    [JSON.stringify([{ ...complete, department_name: '' }]), /第 0 筆的 department_name 欄位/],
    [JSON.stringify([{ ...complete, requester: { ...complete.requester, user_id: '  ' } }]), /第 0 筆的 requester\.user_id 欄位/],
    [JSON.stringify([{ ...complete, ticket_id: '   ' }]), /第 0 筆缺少 ticket_id/],
    [JSON.stringify([{ ...complete, ticket_id: ' TK-legacy-1' }]), /第 0 筆的 ticket_id 欄位前後不可有空白/],
    [JSON.stringify([{ ...complete, ticket_id: 'TK-legacy-1\n' }]), /第 0 筆的 ticket_id 欄位前後不可有空白/],
    [JSON.stringify([without(complete, 'decision')]), /第 0 筆的 decision 欄位/],
    [JSON.stringify([{ ...complete, decision: 'FAKE-DECISION-VALUE' }]), /第 0 筆的 decision 欄位/],
    [JSON.stringify([{ ...complete, decision: [] }]), /第 0 筆的 decision 欄位/],
    [JSON.stringify([{ ...legacy[1], decision: { ...legacy[1].decision, at: 20261002 } }]), /第 0 筆的 decision 欄位/],
    [JSON.stringify([{ ...legacy[1], decision: { ...legacy[1].decision, at: null } }]), /第 0 筆的 decision 欄位/],
    [JSON.stringify([{ ...legacy[1], decision: { ...legacy[1].decision, at: ' ' } }]), /第 0 筆的 decision 欄位/],
  ];
  for (const [text, pattern] of invalidCases) {
    writeFileSync(broken, text);
    assertCallThrows(importLegacyTickets, [open(':memory:'), { legacyFile: broken }], { code: 'LEGACY_INVALID', message: pattern });
  }
  writeFileSync(broken, JSON.stringify([{ ...complete, status: 'FAKE-STATUS-VALUE' }]));
  assertCallThrows(importLegacyTickets, [open(':memory:'), { legacyFile: broken }], { message: /^(?!.*FAKE-STATUS-VALUE)/ }, '錯誤訊息只有索引與欄位名稱，不含欄位值');
  writeFileSync(broken, JSON.stringify([{ ...complete, ticket_id: ' FAKE-PADDED-ID ' }]));
  assertCallThrows(importLegacyTickets, [open(':memory:'), { legacyFile: broken }], { message: /^(?!.*FAKE-PADDED-ID)/ }, 'ticket_id 前後有空白時訊息不含單號');
  const undecided = { ...legacy[1], ticket_id: 'TK-legacy-no-at', decision: { by_user_id: 'user-test.two', by_username: 'test.two', comment: '' } };
  writeFileSync(broken, JSON.stringify([undecided]));
  assert.equal(importLegacyTickets(open(':memory:'), { legacyFile: broken }).status, 'imported', 'decision 物件沒有 at 時可匯入（排序改用 updated_at）');
  const occupied = open(':memory:');
  occupied.prepare('INSERT INTO tickets (ticket_id, document) VALUES (?, ?)').run('TK-existing', '{"ticket_id":"TK-existing"}');
  writeFileSync(broken, JSON.stringify(legacy));
  assertCallThrows(importLegacyTickets, [occupied, { legacyFile: broken }], { code: 'LEGACY_CONFLICT' });
}
test('舊版 tickets.json 一次性匯入', legacyImport);

// 子程序執行的程式：載入模組後輸出 ready，收到父程序的放行訊號才依序開啟每個新檔，最後輸出失敗代碼的 JSON 陣列。
const RACE_CHILD_CODE = [
  `import { openTicketDatabase } from ${JSON.stringify(databaseModuleUrl)};`,
  'const files = JSON.parse(process.env.TEST_DATABASE_FILES);',
  "console.log('ready');",
  '/**',
  ' * 收到放行訊號後依序開啟並關閉每個資料庫檔，記錄失敗的錯誤代碼，完成後輸出 JSON 並關閉 stdin 讓程序結束。',
  ' * @returns {void}',
  ' */',
  'function go() {',
  '  const failures = [];',
  '  for (const file of files) { try { openTicketDatabase(file).close(); } catch (error) { failures.push(String(error?.code || error?.message)); } }',
  '  console.log(JSON.stringify(failures));',
  '  process.stdin.destroy();',
  '}',
  "process.stdin.once('data', go);",
].join('\n');

/**
 * 啟動一個競爭初始化用的子程序，回傳等待載入完成與等待結束的 Promise。
 * @param {string[]} files 子程序要依序開啟的資料庫檔路徑（所有子程序共用同一組，才會互相競爭）。
 * @returns {{child: import('node:child_process').ChildProcess, ready: Promise<void>, done: Promise<string[]>}}
 * 子程序、輸出 ready 時完成的 Promise，以及結束後解析出失敗代碼陣列的 Promise（輸出無法解析時以 OUTPUT_UNPARSEABLE 表示）。
 */
function startRaceChild(files) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', RACE_CHILD_CODE], { env: { ...process.env, TEST_DATABASE_FILES: JSON.stringify(files) } });
  let output = '';
  child.stdout.setEncoding('utf8');
  const ready = new Promise(/** 等子程序輸出 ready。@param {Function} resolve 完成函式。@returns {void} */ (resolve) => {
    child.stdout.on('data', /** 累積輸出並在看到 ready 時完成。@param {string} chunk 輸出片段。@returns {void} */ (chunk) => {
      output += chunk;
      if (output.includes('ready')) resolve();
    });
  });
  const done = new Promise(/** 等子程序結束並解析最後一行。@param {Function} resolve 完成函式。@returns {void} */ (resolve) => {
    child.on('close', /** 解析最後一行的失敗代碼陣列。@returns {void} */ () => {
      try { resolve(JSON.parse(output.trim().split(/\r?\n/).pop())); } catch { resolve(['OUTPUT_UNPARSEABLE']); }
    });
  });
  return { child, ready, done };
}

/**
 * 讓多個子程序同時初始化同一組新檔：先等所有子程序載入模組，再同時放行，提高同一時間開啟同一個新檔的機率。
 * 每一輪使用新的檔名，各子程序依序開啟同一組檔案，因此每輪每個檔案都會被所有子程序競爭初始化。
 * @param {object} options 壓力測試設定。
 * @param {number} options.children 每輪同時執行的子程序數。
 * @param {number} options.rounds 輪數。
 * @param {number} options.filesPerRound 每輪的新檔數量。
 * @returns {Promise<{opens: number, failures: string[], files: string[]}>} 總開檔次數、所有失敗代碼與用過的檔案路徑。
 */
async function raceFreshInitialisation({ children, rounds, filesPerRound }) {
  const failures = [];
  const files = [];
  for (let round = 0; round < rounds; round += 1) {
    const roundFiles = Array.from({ length: filesPerRound }, /** 組出這一輪第 index 個新檔路徑。@param {unknown} _ 未使用。@param {number} index 索引。@returns {string} 路徑。 */ (_, index) => join(scratch, `race-${round}-${index}.db`));
    files.push(...roundFiles);
    const runs = Array.from({ length: children }, /** 啟動一個子程序。@returns {object} startRaceChild 的回傳值。 */ () => startRaceChild(roundFiles));
    await Promise.all(runs.map(/** 取出載入完成的 Promise。@param {object} run 子程序資訊。@returns {Promise<void>} ready。 */ (run) => run.ready));
    for (const run of runs) run.child.stdin.write('go\n');
    for (const result of await Promise.all(runs.map(/** 取出結束的 Promise。@param {object} run 子程序資訊。@returns {Promise<string[]>} done。 */ (run) => run.done))) failures.push(...result);
  }
  return { opens: children * rounds * filesPerRound, failures, files };
}

/**
 * 驗證結構遷移與匯入檢查都在 IMMEDIATE 交易內進行：交易外讀到的舊版本不會讓遷移重跑（table already exists），
 * 另一條連線持有寫入鎖時兩者都要等鎖（busy_timeout 為 0 時立即 SQLITE_BUSY）；遷移在寫入鎖內重新檢查檔案身分，
 * 不會改動其他程式的檔案；多個程序同時初始化同一組新檔（6 個子程序 × 4 輪 × 每輪 20 個新檔）全部成功，
 * 不會因交易外分次讀取身分而誤判 FOREIGN_DATABASE，也不會因切換 WAL 的 SQLITE_BUSY 失敗。
 * @returns {Promise<void>}
 */
async function concurrentInitialisation() {
  const db = open('migrated.db');
  assertCallSucceeds(migrate, [db, 0], '交易外讀到過時的 user_version 時，交易內重新確認並略過已套用的步驟');
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  const missing = join(scratch, 'migrated-none.json');
  assert.equal(importLegacyTickets(db, { legacyFile: missing }).status, 'no-legacy-file');

  const holder = new Database(join(scratch, 'migrated.db'));
  holder.exec('BEGIN IMMEDIATE');
  db.pragma('busy_timeout = 0');
  try {
    assertCallThrows(migrate, [db, 0], { code: 'SQLITE_BUSY' }, '遷移先取得寫入鎖再確認版本');
    assertCallThrows(importLegacyTickets, [db, { legacyFile: missing }], { code: 'SQLITE_BUSY' }, '匯入紀錄與筆數的檢查在寫入鎖內進行');
    assert.equal(importLegacyTickets(db, { legacyFile: missing, dryRun: true }).status, 'already-imported', '預覽只需讀取，不等寫入鎖');
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
    db.pragma('busy_timeout = 5000');
  }

  const foreignFile = join(scratch, 'migrate-foreign.db');
  const foreign = new Database(foreignFile);
  foreign.exec('CREATE TABLE other (a TEXT)');
  assertCallThrows(migrate, [foreign, 0], { code: 'FOREIGN_DATABASE' }, '寫入鎖內重新檢查身分，不在其他程式的檔案上建立資料表');
  assert.equal(foreign.prepare("SELECT COUNT(*) AS total FROM sqlite_schema WHERE name = 'tickets'").get().total, 0, '拒絕時交易回滾');
  assert.equal(foreign.pragma('application_id', { simple: true }), 0, '拒絕時不寫入檔案身分');
  foreign.close();

  const race = await raceFreshInitialisation({ children: 6, rounds: 4, filesPerRound: 20 });
  assert.deepEqual(race.failures, [], `多個程序同時初始化同一個新檔都成功（共 ${race.opens} 次開檔）`);
  for (const file of race.files) assert.equal(inspectTicketDatabase(file).schemaVersion, SCHEMA_VERSION);
}
test('結構遷移與匯入檢查的並行初始化', concurrentInitialisation);

/**
 * 驗證匯出、線上備份、檢查與還原：匯出形狀與舊版相同且不覆寫、備份可唯讀驗證（含唯讀的備份檔）、
 * 還原保留完整舊檔、同一個時間標記再次還原時拒絕而不覆蓋保留檔、後端仍在使用時拒絕還原、
 * 目前資料庫損毀時仍可還原，失敗時不改動目前的資料庫。
 * @returns {Promise<void>}
 */
async function backupAndRestore() {
  const file = join(scratch, 'live.db');
  const store = createSqliteDataStore({ file });
  for (const ticket of legacy) await store.insert(ticket);
  const db = open('live.db');
  const exported = join(scratch, 'export.json');
  assert.equal(exportTicketsJson(db, exported), 2);
  assert.deepEqual(JSON.parse(readFileSync(exported, 'utf8')), legacy);
  assertCallThrows(exportTicketsJson, [db, exported], { code: 'OUTPUT_EXISTS' });
  writeFileSync(join(scratch, 'export-2.json.tmp'), 'leftover');
  assertCallThrows(exportTicketsJson, [db, join(scratch, 'export-2.json')], { code: 'OUTPUT_EXISTS' }, '殘留的暫存檔不被覆寫');

  const backup = join(scratch, 'backup.db');
  assert.deepEqual(backupTicketDatabase(db, backup), { tickets: 2, schemaVersion: SCHEMA_VERSION });
  assertCallThrows(backupTicketDatabase, [db, backup], { code: 'OUTPUT_EXISTS' });
  await store.insert({ ticket_id: 'TK-after-backup' });

  assertCallThrows(restoreTicketDatabase, [file, backup, 'busy'], { code: 'DATABASE_IN_USE' }, '後端仍開著資料庫時拒絕還原');
  assert.equal(inspectTicketDatabase(file).tickets, 3, '拒絕還原時不動目前的資料庫');
  assert.equal(existsSync(`${file}.restore-tmp`), false, '不留下暫存檔');
  db.close();
  store.close();

  // 模擬放在唯讀掛載上的備份檔：來源只會以唯讀方式開啟。
  chmodSync(backup, 0o444);
  let result;
  try { result = restoreTicketDatabase(file, backup, '20261101-000000'); } finally { chmodSync(backup, 0o644); }
  assert.deepEqual(result.restored, { tickets: 2, schemaVersion: SCHEMA_VERSION });
  assert.ok(result.previous.endsWith('.before-restore-20261101-000000'));
  assert.equal(inspectTicketDatabase(result.previous).tickets, 3, '舊檔完整保留（含備份後新增的單）');
  assert.equal(existsSync(`${file}-wal`), false);
  const reopened = createSqliteDataStore({ file });
  assert.deepEqual((await reopened.all()).map(idOf), ['TK-legacy-1', 'TK-legacy-2']);
  await reopened.insert({ ticket_id: 'TK-after-restore' });
  reopened.close();

  assertCallThrows(restoreTicketDatabase, [file, backup, '20261101-000000'], { code: 'PREVIOUS_EXISTS' }, '同一秒內再次還原時拒絕，不覆蓋先前保留的副本');
  assert.equal(inspectTicketDatabase(result.previous).tickets, 3, '先前保留的副本不變');
  assert.equal(inspectTicketDatabase(file).tickets, 3, '拒絕時不動目前的資料庫');
  assert.equal(existsSync(`${file}.restore-tmp`), false);
  writeFileSync(`${file}.before-restore-sidecar-wal`, 'fake leftover');
  assertCallThrows(restoreTicketDatabase, [file, backup, 'sidecar'], { code: 'PREVIOUS_EXISTS' }, '保留檔的 -wal 已存在時同樣拒絕');
  assert.equal(existsSync(`${file}.before-restore-sidecar`), false, '拒絕前沒有移動任何檔案');
  assert.equal(inspectTicketDatabase(file).tickets, 3);

  const notDatabase = join(scratch, 'not-a-db.db');
  writeFileSync(notDatabase, 'plain text');
  assertCallThrows(restoreTicketDatabase, [file, notDatabase, 'x'], Error);
  assert.equal(inspectTicketDatabase(file).tickets, 3, '來源驗證失敗時不動目前的資料庫');

  const corrupt = join(scratch, 'corrupt-live.db');
  writeFileSync(corrupt, 'garbage, not sqlite');
  const repaired = restoreTicketDatabase(corrupt, backup, 'repair');
  assert.equal(repaired.restored.tickets, 2, '目前的資料庫損毀時仍可用備份取代');
  assert.equal(readFileSync(repaired.previous, 'utf8'), 'garbage, not sqlite', '損毀的檔案改名保留');
}
test('匯出、線上備份與還原', backupAndRestore);

/**
 * 驗證直接複製執行中 WAL 資料庫（主檔加 -wal）當作來源時，還原依邏輯內容寫入，-wal 中較新的需求單不會遺失。
 * @returns {Promise<void>}
 */
async function restoreFromRawWalCopy() {
  const liveFile = join(scratch, 'wal-live.db');
  const store = createSqliteDataStore({ file: liveFile });
  for (const ticket of legacy) await store.insert(ticket);
  const checkpointer = open('wal-live.db');
  checkpointer.pragma('wal_checkpoint(TRUNCATE)');
  await store.insert({ ...legacy[0], ticket_id: 'TK-only-in-wal' });
  const raw = join(scratch, 'raw-copy.db');
  copyFileSync(liveFile, raw);
  copyFileSync(`${liveFile}-wal`, `${raw}-wal`);
  checkpointer.close();
  store.close();
  copyFileSync(raw, join(scratch, 'raw-copy-main.db'));
  assert.equal(inspectTicketDatabase(join(scratch, 'raw-copy-main.db')).tickets, 2, '前提：單獨的主檔可以開啟，但少了 -wal 中的單');

  const target = join(scratch, 'wal-target.db');
  const result = restoreTicketDatabase(target, raw, 'walcopy');
  assert.equal(result.previous, null);
  assert.equal(result.restored.tickets, 3, '還原包含來源 -wal 中已提交的需求單');
  const reopened = createSqliteDataStore({ file: target });
  assert.deepEqual((await reopened.all()).map(idOf), ['TK-legacy-1', 'TK-legacy-2', 'TK-only-in-wal']);
  reopened.close();
  assert.equal(existsSync(`${target}.restore-tmp`), false, '不留下暫存檔');
}
test('從執行中資料庫的原始複本還原', restoreFromRawWalCopy);

/**
 * 建立含指定需求單的已驗證備份檔，供還原測試使用。
 * @param {string} name 暫存目錄中的檔名前綴，會產生 <name>-live.db 與 <name>-backup.db。
 * @param {object[]} tickets 要寫入的假需求單。
 * @returns {Promise<string>} 備份檔路徑。
 */
async function makeBackup(name, tickets) {
  const store = createSqliteDataStore({ file: join(scratch, `${name}-live.db`) });
  for (const ticket of tickets) await store.insert(ticket);
  store.close();
  const db = openTicketDatabase(join(scratch, `${name}-live.db`));
  const backup = join(scratch, `${name}-backup.db`);
  try { backupTicketDatabase(db, backup); } finally { db.close(); }
  return backup;
}

/**
 * 產生另一個資料庫還沒合併回主檔的 -wal／-shm 內容，模擬主檔被刪除後殘留在 DATABASE_FILE 旁的附屬檔。
 * 來源連線關閉自動檢查點，複製時 -wal 內仍有已提交的頁面，與任何備份配對都會套用到錯誤的主檔上。
 * @param {string} target 要放置殘留檔的主檔路徑（只建立 <target>-wal 與 <target>-shm，不建立主檔）。
 * @returns {Buffer} 複製過去的 -wal 原始內容，供確認改名保留後內容不變。
 */
function plantForeignSidecars(target) {
  const sourceFile = join(scratch, `${target.split(/[\\/]/).pop()}-foreign-source.db`);
  const source = openTicketDatabase(sourceFile);
  try {
    source.pragma('wal_autocheckpoint = 0');
    const insert = source.prepare('INSERT INTO tickets (ticket_id, document) VALUES (?, ?)');
    for (let index = 0; index < 20; index += 1) insert.run(`TK-foreign-${index}`, JSON.stringify({ ticket_id: `TK-foreign-${index}`, subject: 'x'.repeat(500) }));
    copyFileSync(`${sourceFile}-wal`, `${target}-wal`);
    copyFileSync(`${sourceFile}-shm`, `${target}-shm`);
  } finally { source.close(); }
  return readFileSync(`${target}-wal`);
}

/**
 * 驗證 DATABASE_FILE 不存在但旁邊殘留其他資料庫的 -wal／-shm 時：還原前先把殘留檔改名為
 * <檔名>.before-restore-<時間>-wal／-shm 保留（內容不變），放入的備份不會和殘留的 WAL 配對，內容與備份相同；
 * 保留用的名稱已存在時以 PREVIOUS_EXISTS 拒絕且不移動任何檔案；沒有殘留檔時 strandedSidecars 為空陣列。
 * 也驗證維運腳本的成功日誌回報移開的殘留檔數量。
 * @returns {Promise<void>}
 */
async function restoreMovesStrandedSidecars() {
  const backup = await makeBackup('stranded', legacy);
  const target = join(scratch, 'stranded-target.db');
  const foreignWal = plantForeignSidecars(target);
  assert.equal(existsSync(target), false, '前提：主檔不存在');

  const result = restoreTicketDatabase(target, backup, 'stale');
  assert.equal(result.previous, null, '沒有舊主檔可保留');
  assert.deepEqual(result.strandedSidecars, [`${target}.before-restore-stale-wal`, `${target}.before-restore-stale-shm`]);
  assert.deepEqual(readFileSync(`${target}.before-restore-stale-wal`), foreignWal, '殘留的 -wal 改名保留，內容不變');
  assert.deepEqual(result.restored, { tickets: 2, schemaVersion: SCHEMA_VERSION }, '還原結果只有備份的內容');
  const reopened = createSqliteDataStore({ file: target });
  assert.deepEqual(await reopened.all(), legacy, '重新開啟後不會套用殘留的 WAL');
  reopened.close();

  const blocked = join(scratch, 'stranded-blocked.db');
  plantForeignSidecars(blocked);
  writeFileSync(`${blocked}.before-restore-dup-shm`, 'fake leftover');
  assertCallThrows(restoreTicketDatabase, [blocked, backup, 'dup'], { code: 'PREVIOUS_EXISTS' }, '殘留檔的保留名稱已存在時拒絕');
  assert.equal(existsSync(`${blocked}-wal`), true, '拒絕前沒有移動殘留檔');
  assert.equal(existsSync(blocked), false, '拒絕時沒有放入備份');
  assert.equal(existsSync(`${blocked}.restore-tmp`), false, '不留下暫存檔');

  assert.deepEqual(restoreTicketDatabase(join(scratch, 'stranded-clean.db'), backup, 'clean').strandedSidecars, [], '沒有殘留檔時為空陣列');

  const scripted = join(scratch, 'stranded-script.db');
  plantForeignSidecars(scripted);
  const run = runScript('db-restore.js', [backup], { databaseFile: scripted, ticketsFile: join(scratch, 'stranded-none.json') });
  assert.equal(run.status, 0);
  const completed = run.records.find(/** 找出還原完成事件。@param {object} record 日誌紀錄。@returns {boolean} 是否符合。 */ (record) => record.event === 'storage.restore.completed');
  assert.equal(completed?.strandedSidecars, 2, '腳本日誌回報移開的殘留檔數量');
  assert.equal(completed?.keptPrevious, false);
  assert.equal(inspectTicketDatabase(scripted).tickets, 2);
}
test('主檔不存在時移開殘留的 -wal／-shm 再還原', restoreMovesStrandedSidecars);

/**
 * 建立會在指定改名上失敗的改名函式，其餘改名交給真正的 renameSync，用來注入還原流程的檔案系統錯誤。
 * @param {Array<{source?: string, target?: string, error: Error}>} rules 失敗規則：來源或目標符合時拋出對應的錯誤。
 * @returns {(source: string, target: string) => void} 注入失敗的改名函式。
 */
function failingRename(rules) {
  return /** 依規則拋出假錯誤或執行真正的改名。@param {string} source 來源路徑。@param {string} target 目標路徑。@returns {void} @throws {Error} 符合規則時的假錯誤。 */ (source, target) => {
    for (const rule of rules) {
      if ((rule.source === undefined || rule.source === source) && (rule.target === undefined || rule.target === target)) throw rule.error;
    }
    renameSync(source, target);
  };
}

/**
 * 驗證放入暫存檔失敗時的回滾：
 * - 只有放入失敗：拋出原始錯誤、舊檔改回原名、暫存檔刪除；
 * - 放入失敗且把舊檔改回原名也失敗：仍拋出原始錯誤（不被回滾錯誤取代），回滾錯誤放在 rollbackError，
 *   已驗證的暫存檔保留不刪並以 stagedFile 回報、保留的舊檔以 previousFile 回報、實際移開的檔案以 movedFiles 回報，內容都完整可供人工復原；
 * - 主檔不存在、只移開殘留 -wal／-shm 時回滾失敗：previousFile 為 null，movedFiles 指向殘留檔實際所在路徑；
 * - moveDatabaseFiles 本身回滾失敗時，原始錯誤同樣帶 rollbackError。
 * @returns {Promise<void>}
 */
async function restoreRollbackFailure() {
  const backup = await makeBackup('rollback', legacy);
  const file = join(scratch, 'rollback-target.db');
  const store = createSqliteDataStore({ file });
  for (const ticket of [...legacy, { ...legacy[0], ticket_id: 'TK-rollback-extra' }]) await store.insert(ticket);
  store.close();
  const temporary = `${file}.restore-tmp`;

  const installFailure = Object.assign(new Error('FAKE install failure'), { code: 'EPERM' });
  assertCallThrows(restoreTicketDatabase, [file, backup, 'once', { rename: failingRename([{ source: temporary, error: installFailure }]) }],
    /** 確認拋出的是原始錯誤且沒有回滾錯誤。@param {Error} error 錯誤。@returns {boolean} 是否符合。 */ (error) => error === installFailure && error.rollbackError === undefined);
  assert.equal(inspectTicketDatabase(file).tickets, 3, '舊檔改回原名');
  assert.equal(existsSync(`${file}.before-restore-once`), false);
  assert.equal(existsSync(temporary), false, '回滾成功時刪除暫存檔');

  const rollbackFailure = Object.assign(new Error('FAKE rollback failure'), { code: 'EBUSY' });
  let thrown;
  try {
    restoreTicketDatabase(file, backup, 'twice', { rename: failingRename([{ source: temporary, error: installFailure }, { target: file, error: rollbackFailure }]) });
  } catch (error) { thrown = error; }
  assert.equal(thrown, installFailure, '拋出原始錯誤，不被回滾錯誤取代');
  assert.equal(thrown.code, 'EPERM');
  assert.equal(thrown.rollbackError, rollbackFailure, '回滾錯誤另外附上');
  assert.equal(thrown.stagedFile, temporary);
  assert.equal(thrown.previousFile, `${file}.before-restore-twice`);
  assert.deepEqual(inspectTicketDatabase(thrown.stagedFile), { tickets: 2, schemaVersion: SCHEMA_VERSION }, '已驗證的暫存檔保留不刪');
  assert.equal(inspectTicketDatabase(thrown.previousFile).tickets, 3, '保留的舊檔完整');
  assert.equal(existsSync(file), false, '前提：回滾失敗時正式位置沒有資料庫，必須靠回報的路徑人工復原');
  assert.deepEqual(thrown.movedFiles, [`${file}.before-restore-twice`], '回報實際移開的檔案');
  renameSync(thrown.previousFile, file);
  rmSync(thrown.stagedFile);

  // 主檔不存在、只有殘留 -wal／-shm 時回滾失敗：previousFile 為 null，movedFiles 指向殘留檔實際所在位置。
  const stranded = join(scratch, 'rollback-stranded.db');
  for (const suffix of ['-wal', '-shm']) writeFileSync(`${stranded}${suffix}`, `stale${suffix}`);
  let strandedError;
  try {
    restoreTicketDatabase(stranded, backup, 'stranded', { rename: failingRename([{ source: `${stranded}.restore-tmp`, error: installFailure }, { target: `${stranded}-wal`, error: rollbackFailure }]) });
  } catch (error) { strandedError = error; }
  assert.equal(strandedError, installFailure);
  assert.equal(strandedError.previousFile, null, '原本沒有主檔時不回報不存在的舊主檔路徑');
  assert.ok(strandedError.movedFiles.includes(`${stranded}.before-restore-stranded-wal`), '回報殘留 -wal 實際所在路徑');
  for (const path of strandedError.movedFiles) assert.equal(existsSync(path), true, `${path} 確實存在`);

  const from = join(scratch, 'move-rollback.db');
  const to = join(scratch, 'move-rollback-target.db');
  for (const suffix of ['', '-wal']) writeFileSync(`${from}${suffix}`, `fake${suffix}`);
  const mainFailure = new Error('FAKE main move failure');
  const walBackFailure = new Error('FAKE wal rollback failure');
  assertCallThrows(moveDatabaseFiles, [from, to, { rename: failingRename([{ source: from, error: mainFailure }, { source: `${to}-wal`, error: walBackFailure }]) }],
    /** 確認原始錯誤帶回滾錯誤。@param {Error} error 錯誤。@returns {boolean} 是否符合。 */ (error) => error === mainFailure && error.rollbackError === walBackFailure);
  assert.equal(readFileSync(`${to}-wal`, 'utf8'), 'fake-wal', '回滾失敗的檔案留在目標位置，可依錯誤內容人工改回');
}
test('還原放入失敗且回滾也失敗時保留原始錯誤與暫存檔', restoreRollbackFailure);

/**
 * 驗證移動資料庫檔時先移 -wal／-shm、最後才移主檔，任一步失敗都把已移動的檔案改回原名：
 * -shm 的目標無法覆寫（非空目錄）或主檔的目標無法覆寫時，原來三個檔案都留在原位，目標位置沒有殘留。
 * @returns {void}
 */
function moveRollsBack() {
  const from = join(scratch, 'move.db');
  const to = join(scratch, 'moved.db');
  for (const suffix of ['', '-wal', '-shm']) writeFileSync(`${from}${suffix}`, `fake${suffix}`);
  for (const blocked of [`${to}-shm`, to]) {
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'occupied'), 'fake');
    assertCallThrows(moveDatabaseFiles, [from, to], Error);
    for (const suffix of ['', '-wal', '-shm']) assert.equal(readFileSync(`${from}${suffix}`, 'utf8'), `fake${suffix}`, `失敗時 ${suffix || '主檔'} 改回原名`);
    for (const suffix of ['', '-wal', '-shm']) {
      if (`${to}${suffix}` !== blocked) assert.equal(existsSync(`${to}${suffix}`), false, '目標位置沒有殘留');
    }
    rmSync(blocked, { recursive: true, force: true });
  }
  moveDatabaseFiles(from, to);
  for (const suffix of ['', '-wal', '-shm']) assert.equal(readFileSync(`${to}${suffix}`, 'utf8'), `fake${suffix}`, '成功時三個檔案一起改名');
}
test('移動資料庫檔失敗時回滾', moveRollsBack);

/**
 * 驗證匯入腳本：DATABASE_FILE 存在但尚未初始化（0 位元組）時預覽改用記憶體資料庫且不改動檔案；
 * none 紀錄之後才出現的舊檔不帶旗標只回報 legacy-appeared，加上 --import-late 才匯入。
 * @returns {void}
 */
function importScript() {
  const ticketsFile = join(scratch, 'script-tickets.json');
  writeFileSync(ticketsFile, JSON.stringify(legacy));

  const empty = join(scratch, 'script-empty.db');
  writeFileSync(empty, '');
  const preview = runScript('import-legacy-tickets.js', ['--dry-run'], { databaseFile: empty, ticketsFile });
  assert.equal(preview.status, 0, '尚未初始化的資料庫檔預覽不失敗');
  assert.equal(preview.records.find(isLegacyImportRecord)?.status, 'would-import');
  assert.equal(statSync(empty).size, 0, '預覽不改動資料庫檔');

  const databaseFile = join(scratch, 'script-late.db');
  const initial = openTicketDatabase(databaseFile);
  importLegacyTickets(initial, { legacyFile: join(scratch, 'script-missing.json') });
  initial.close();
  const plain = runScript('import-legacy-tickets.js', [], { databaseFile, ticketsFile });
  assert.equal(plain.status, 0);
  assert.equal(plain.records.find(isLegacyImportRecord)?.status, 'legacy-appeared', '沒有旗標時不匯入之後才出現的舊檔');
  assert.equal(inspectTicketDatabase(databaseFile).tickets, 0);
  const late = runScript('import-legacy-tickets.js', ['--import-late'], { databaseFile, ticketsFile });
  assert.equal(late.status, 0);
  assert.equal(late.records.find(isLegacyImportRecord)?.status, 'imported', '--import-late 明確同意後才匯入');
  assert.equal(inspectTicketDatabase(databaseFile).tickets, 2);
}
test('匯入腳本的預覽與 --import-late', importScript);

/**
 * 判斷日誌紀錄是否為匯入腳本的成功事件。
 * @param {object} record 解析後的日誌紀錄。
 * @returns {boolean} 事件名稱為 storage.legacy_import 時 true。
 */
function isLegacyImportRecord(record) { return record.event === 'storage.legacy_import'; }

/**
 * 驗證版本與身分防護都帶固定代碼：Node 版本不足、目錄不存在、結構版本比程式新、其他程式的 SQLite 檔，
 * 而且拒絕時不改動其他程式的檔案；啟動用的 prepare 保留原始代碼。
 * @returns {Promise<void>}
 */
async function guards() {
  assertCallThrows(assertSupportedNode, ['22.3.0'], { code: 'NODE_TOO_OLD', message: /22\.14\.0/ });
  assertCallSucceeds(assertSupportedNode, ['22.14.0']);
  assertCallSucceeds(assertSupportedNode, ['24.1.0']);
  assertCallThrows(openTicketDatabase, [join(scratch, 'missing-dir', 'helpdesk.db')], { code: 'DIRECTORY_MISSING' });
  const newer = open('newer.db');
  newer.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  newer.close();
  assertCallThrows(openTicketDatabase, [join(scratch, 'newer.db')], { code: 'SCHEMA_TOO_NEW' });
  const foreignFile = join(scratch, 'foreign.db');
  const foreign = new Database(foreignFile);
  foreign.exec('CREATE TABLE other (a TEXT)');
  foreign.close();
  assertCallThrows(openTicketDatabase, [foreignFile], { code: 'FOREIGN_DATABASE' });
  const untouched = new Database(foreignFile, { readonly: true });
  assert.equal(untouched.pragma('application_id', { simple: true }), 0, '拒絕時不寫入檔案身分');
  assert.equal(untouched.pragma('journal_mode', { simple: true }), 'delete', '拒絕時不切換日誌模式');
  untouched.close();
  const fresh = open('fresh.db');
  assert.equal(fresh.pragma('application_id', { simple: true }), APPLICATION_ID, '新檔寫入檔案身分');
  await assert.rejects(createSqliteDataStore({ file: foreignFile }).prepare({ legacyFile: join(scratch, 'none.json') }), { code: 'FOREIGN_DATABASE' });
  await assert.rejects(createSqliteDataStore({ file: foreignFile }).all(), { status: 503, code: 'TICKET_STORE_UNAVAILABLE' });
  assert.deepEqual(parseTicketRow({ document: '{"ticket_id":"TK-1"}' }), { ticket_id: 'TK-1' });
}
test('Node 版本、目錄、結構版本與檔案身分防護', guards);
