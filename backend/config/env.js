import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const defaultEnvFile = fileURLToPath(new URL('../.env', import.meta.url));

/**
 * 僅接受 local 與 production；預設 local 讀取本機設定，正式環境只讀平台變數。
 * @param {object} [options={}] 載入選項。
 * @param {object} [options.environment=process.env] 環境變數來源。
 * @param {string} [options.envFile] 本機 .env 的絕對路徑。
 * @returns {Readonly<object>} 包含模型、日誌、HTTP 頻率、登入失敗視窗、獨立管理密碼、來源驗證、關機緩衝、記憶體限制儲存與需求單 JSON 路徑的設定。
 * @throws {Error} 模式不是 local／production、必要密碼缺少或共用、正式環境必要設定不足、限制無效或關機緩衝不足 25 秒。
 */
export function loadEnv({ environment = process.env, envFile = defaultEnvFile } = {}) {
  // 先依平台參數決定模式；production 完全不讀取本機 .env。
  const nodeEnv = environment.NODE_ENV || 'local';
  if (!['local', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV 只接受 local 或 production');
  if (nodeEnv !== 'production') {
    dotenv.config({
      path: envFile,
      processEnv: environment,
      override: false, // 已存在的環境參數優先，包含刻意設定的空值。
      quiet: true,
    });
  }

  const port = Number(environment.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT 必須是 1 到 65535 之間的整數');
  }

  const geminiApiKey = environment.GEMINI_API_KEY?.trim() || '';
  const corsOrigin = environment.CORS_ORIGIN?.trim() || '';
  if (nodeEnv === 'production') {
    // 只指出缺少哪個參數，不輸出參數值或金鑰。
    for (const [name, value] of [['GEMINI_API_KEY', geminiApiKey], ['CORS_ORIGIN', corsOrigin]]) {
      if (!value) throw new Error(`production 缺少必要環境參數：${name}`);
    }
  }

  const logLevel = environment.LOG_LEVEL?.trim().toLowerCase() || 'info';
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel)) {
    throw new Error('LOG_LEVEL 必須是 debug、info、warn、error 或 silent');
  }

  const originVerifySecret = environment.ORIGIN_VERIFY_SECRET?.trim() || '';
  if (originVerifySecret && Buffer.byteLength(originVerifySecret) < 32) throw new Error('ORIGIN_VERIFY_SECRET 至少需要 32 bytes');

  const authSecret = environment.AUTH_SECRET?.trim() || '';
  const limitStore = environment.LIMIT_STORE || 'memory';
  if (limitStore !== 'memory') throw new Error('LIMIT_STORE 只接受 memory；本專案不使用資料庫');
  if (authSecret && Buffer.byteLength(authSecret) < 32) throw new Error('AUTH_SECRET 至少需要 32 bytes');
  if (nodeEnv === 'production' && !authSecret) throw new Error('production 缺少 AUTH_SECRET');
  const adminPassword = environment.ADMIN_PASSWORD;
  if (typeof adminPassword !== 'string' || !adminPassword.trim()) throw new Error('缺少必要環境參數：ADMIN_PASSWORD');
  if (adminPassword === environment.DEMO_PASSWORD) throw new Error('ADMIN_PASSWORD 不得與 DEMO_PASSWORD 相同');
  // 需求單資料（含狀態與簽核紀錄）保存在單一 JSON 檔；可用 TICKETS_FILE 指定其他絕對路徑。
  const ticketsFile = environment.TICKETS_FILE?.trim() || fileURLToPath(new URL('../data/tickets.json', import.meta.url));
  const demoPassword = environment.DEMO_PASSWORD;
  if (typeof demoPassword !== 'string' || !demoPassword.trim()) throw new Error('缺少必要環境參數：DEMO_PASSWORD');

  /**
   * 讀取正整數限制參數，拒絕無效值以防啟動後保護失效。
   * @param {string} name 環境參數名稱。
   * @param {number} fallback 預設值。
   * @returns {number} 有效的正整數。
   * @throws {Error} 值不是正整數。
   */
  function positive(name, fallback) {
    const value = Number(environment[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必須為正整數`);
    return value;
  }

  // 需求單判斷的單次上游逾時為 15 秒；關機至少再保留 10 秒等待租約與記錄寫入完成。
  const shutdownTimeoutMs = positive('SHUTDOWN_TIMEOUT_MS', 75000);
  if (shutdownTimeoutMs < 25000) throw new Error('SHUTDOWN_TIMEOUT_MS 至少需要 25000 毫秒');

  return Object.freeze({
    authSecret, originVerifySecret, limitStore, adminPassword, shutdownTimeoutMs,
    demoPassword, ticketsFile,
    authTtlSeconds: positive('AUTH_TTL_SECONDS', 7200),
    chatCooldownSeconds: positive('CHAT_COOLDOWN_SECONDS', 10),
    userDailyLimit: positive('USER_DAILY_LIMIT', 30),
    globalDailyLimit: positive('GLOBAL_DAILY_LIMIT', 100),
    globalConcurrency: positive('GLOBAL_CONCURRENCY', 2),
    httpRateWindowSeconds: positive('HTTP_RATE_WINDOW_SECONDS', 60),
    httpRateMaxKeys: positive('HTTP_RATE_MAX_KEYS', 2048),
    httpApiLimit: positive('HTTP_API_LIMIT', 300),
    httpLoginLimit: positive('HTTP_LOGIN_LIMIT', 120),
    httpTicketLimit: positive('HTTP_TICKET_LIMIT', 12),
    httpDepartmentsLimit: positive('HTTP_DEPARTMENTS_LIMIT', 30),
    httpQueryLimit: positive('HTTP_QUERY_LIMIT', 60),
    loginFailureLimit: positive('LOGIN_FAILURE_LIMIT', 100),
    loginWindowSeconds: positive('LOGIN_WINDOW_SECONDS', 900),
    loginAccountFailureLimit: positive('LOGIN_ACCOUNT_FAILURE_LIMIT', 5),
    loginAccountWindowSeconds: positive('LOGIN_ACCOUNT_WINDOW_SECONDS', 300),
    trustProxy: /^\d+$/.test(environment.TRUST_PROXY || '') ? Number(environment.TRUST_PROXY) : environment.TRUST_PROXY?.trim() || false,
    logLevel,
    nodeEnv,
    port,
    corsOrigin: corsOrigin || 'http://localhost:5173',
    geminiApiKey,
    geminiModel: environment.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
  });
}

export const env = loadEnv();
