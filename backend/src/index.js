import { accountService } from './services/personnel/accountService.js';
import { taskTracker } from './services/taskTracker.js';
import { dataStore } from './services/storage/dataStore.js';
import { SCHEMA_VERSION } from './services/storage/database.js';
import { getRequestTypes } from './services/requestTypes/registry.js';
import { installShutdown, listenServer } from './utils/shutdown.js';
import { app } from './server.js';
import { env } from './config/env.js';
import { logger, diagnoseError } from './utils/logger.js';

// 舊版 tickets.json 匯入結果需要提醒操作者的情況；這些狀態不會讓服務啟動失敗。
const LEGACY_WARNINGS = Object.freeze({
  'legacy-changed': '舊版 tickets.json 在匯入後被修改，服務不會自動合併；請確認是否誤放備份檔。',
  'legacy-appeared': '資料庫初始化後才出現舊版 tickets.json；不論資料庫是否已有需求單，服務都不會自動匯入或合併。確認要匯入時執行 node scripts/import-legacy-tickets.js --import-late（只有需求單資料表為空時才會匯入，否則以 LEGACY_CONFLICT 拒絕）。',
  'legacy-unreadable': '資料庫已有匯入紀錄，但舊版 tickets.json 目前無法讀取；服務照常使用資料庫，回滾或匯入前請確認檔案權限。',
});

/**
 * 監聽前開啟需求單資料庫（套用結構遷移；accounts 資料表為空的全新資料庫，在同一筆交易內寫入一次示範人員名冊）並匯入尚未匯入的舊版 tickets.json；
 * 失敗時記錄原因代碼並以非零碼結束，不開始監聽。
 * 舊檔只讀不改，留作回滾來源；匯入後舊檔被改動、無法讀取，或在資料庫初始化（匯入紀錄為 none）後才出現，都只發出警告，不自動匯入或合併。
 * 資料庫中所屬部門已不在部門設定檔 data/departments.json 的帳號，逐一記錄警告 storage.account_department_missing
 * （不讓啟動失敗；這些帳號不能登入，也不能當處理人、帳號欄位的人選或簽核人）。
 * @returns {Promise<void>} 資料庫就緒。
 */
async function prepareStorage() {
  try {
    const result = await dataStore.prepare({ legacyFile: env.ticketsFile });
    logger('info', 'storage.ready', { engine: 'sqlite', schemaVersion: SCHEMA_VERSION, legacyImport: result.status, legacyCount: result.count,
      seededAccounts: result.seeded?.accounts ?? 0, seededEmployees: result.seeded?.employees ?? 0, seededEntitlements: result.seeded?.entitlements ?? 0 });
    if (LEGACY_WARNINGS[result.status]) logger('warn', 'storage.legacy_warning', { legacyImport: result.status, errorCode: result.errorCode, hint: LEGACY_WARNINGS[result.status] });
    for (const missing of accountService.missingDepartments()) {
      logger('warn', 'storage.account_department_missing', { username: missing.username, departmentId: missing.departmentId, active: missing.active,
        hint: '帳號所屬部門已不在 data/departments.json，此帳號不能登入，也不能當處理人、帳號欄位的人選或簽核人；請修正部門設定，或執行 node scripts/personnel.js set-department <帳號> <部門 id>。' });
    }
  } catch (error) {
    logger('error', 'storage.failed', { reason: typeof error?.code === 'string' ? error.code : 'PREPARE_FAILED', detail: String(error?.message || '').slice(0, 200),
      hint: '依 reason 排查：DIRECTORY_MISSING／SQLITE_CANTOPEN 看 DATABASE_FILE 目錄與權限，NODE_TOO_OLD 看 Node 版本，SCHEMA_TOO_NEW 改用對應映像，FOREIGN_DATABASE 檢查路徑，PERSONNEL_UNMAPPED 表示版本 2 資料庫的員工不在示範名冊、無法決定部門，LEGACY_* 檢查舊版 tickets.json。' });
    closeStorage();
    process.exit(1);
  }
}

/**
 * 監聽前載入並驗證需求單類型設定（data/requestTypes/_catalog.json 與各類型定義檔），讓設定錯誤在監聽前就失敗。
 * 失敗時記錄 request_types.failed（reason、含檔名與鍵路徑的 detail），關閉資料庫並以非零碼結束。
 * @returns {void}
 */
function prepareRequestTypes() {
  try {
    const types = getRequestTypes();
    logger('info', 'request_types.ready', { types: types.ids(), defaultType: types.catalog.defaultType, catalogVersion: types.catalog.version });
  } catch (error) {
    logger('error', 'request_types.failed', { reason: typeof error?.code === 'string' ? error.code : 'LOAD_FAILED', detail: String(error?.message || '').slice(0, 300),
      hint: '依 detail 修正 data/requestTypes/ 中的檔案（檔名與鍵路徑已列出），修正後重新啟動。' });
    closeStorage();
    process.exit(1);
  }
}

prepareRequestTypes();
await prepareStorage();
// 不把 onListening 傳給 app.listen：Express 5 會在監聽失敗時也呼叫該回呼，listenServer 只在 'listening' 事件記錄啟動。
const server = listenServer(app, env.port, { onListening, onError: onServerError });

/**
 * 監聽成功（'listening' 事件）後記錄可公開的啟動設定（含主要與備援 AI 供應商、模型、自動生成的 HTTP 與每日額度）；主要供應商的金鑰只顯示是否設定，不測試外部連線。監聽失敗時不會被呼叫。
 * @returns {void}
 */
function onListening() {
  logger('info', 'server.started', { port: env.port, nodeEnv: env.nodeEnv, nodeVersion: process.version,
    corsOrigin: env.corsOrigin, aiProvider: env.aiProvider, model: env.aiModel, aiFallbackProvider: env.aiFallbackProvider,
    credentialsConfigured: Boolean(env.aiApiKey), logLevel: env.logLevel,
    localUrl: `http://localhost:${env.port}/api` });
  if (!env.aiApiKey) {
    logger('warn', 'server.credentials.missing', { aiProvider: env.aiProvider, aiFallbackProvider: env.aiFallbackProvider,
      hint: env.aiFallbackProvider ? `沒有設定 ${env.aiKeyName}，AI 改由備援 ${env.aiFallbackProvider} 處理；要使用主要供應商請設定後重新啟動。`
        : `請在後端設定 ${env.aiKeyName} 並重新啟動（AI_PROVIDER=${env.aiProvider}）。` });
  }
  logger('info', 'server.limits', { store: env.limitStore, ticketStore: 'sqlite', accountCount: accountService.usernames.length, userDailyLimit: env.userDailyLimit,
    globalDailyLimit: env.globalDailyLimit, cooldownSeconds: env.chatCooldownSeconds, globalConcurrency: env.globalConcurrency,
    draftUserDailyLimit: env.draftUserDailyLimit, draftGlobalDailyLimit: env.draftGlobalDailyLimit });
  logger('info', 'server.http_limits', { store: 'bounded-memory', windowSeconds: env.httpRateWindowSeconds,
    api: env.httpApiLimit, login: env.httpLoginLimit, ticket: env.httpTicketLimit, departments: env.httpDepartmentsLimit, query: env.httpQueryLimit, draft: env.httpDraftLimit,
    rateCapacityPerLimiter: env.httpRateMaxKeys, loginFailureLimit: env.loginFailureLimit,
    loginWindowSeconds: env.loginWindowSeconds, loginAccountFailureLimit: env.loginAccountFailureLimit,
    loginAccountWindowSeconds: env.loginAccountWindowSeconds });
  if (!env.authSecret) logger('warn', 'server.auth.local_secret', { hint: '未設定 AUTH_SECRET：本機改用保存在 SQLite（meta 表 local_auth_secret）的簽章金鑰，重新啟動後登入仍有效；正式環境必須設定 AUTH_SECRET。' });
  logger('debug', 'server.runtime', { pid: process.pid, tlsTermination: 'external-proxy', startupChecksGemini: false });
}

/**
 * 記錄啟動失敗並設定非零結束碼，不將原始 Error 物件輸出至終端機。
 * @param {NodeJS.ErrnoException} error 監聽時發生的錯誤。
 * @returns {void}
 */
function onServerError(error) {
  logger('error', 'server.failed', { port: env.port, ...diagnoseError(error),
    reason: error.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'LISTEN_FAILED' });
  process.exitCode = 1;
}

/**
 * 關閉需求單資料庫連線，讓 WAL 合併回主檔；關閉失敗只記錄，不阻擋程序結束。
 * @returns {void}
 */
function closeStorage() {
  try { dataStore.close(); } catch (error) { logger('error', 'storage.close_failed', { sqliteCode: error?.code }); }
}

// 以 process.on 持續監聽：第一次訊號優雅關機；1 秒內的重複訊號（npm 轉送 Ctrl+C 造成的雙重 SIGINT）只記錄、不強制結束；
// 之後的訊號才強制結束，但仍先關閉連線與資料庫，不會落回 Node 預設的直接終止。關機流程本身見 utils/shutdown.js 的 createShutdown。
installShutdown({ server, tasks: taskTracker, timeoutMs: env.shutdownTimeoutMs, closeStorage, log: logger });
