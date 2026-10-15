import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const defaultEnvFile = fileURLToPath(new URL('../.env', import.meta.url));

/**
 * 依啟動模式載入環境設定；平台變數優先，正式環境不讀取本機檔案。
 * @param {object} [options={}] 載入選項。
 * @param {object} [options.environment=process.env] 環境變數來源。
 * @param {string} [options.envFile] 本機 .env 的絕對路徑。
 * @returns {Readonly<object>} 包含模型、連線及日誌等級的設定。
 * @throws {Error} 連接埠、日誌等級無效或正式環境缺少必要設定。
 */
export function loadEnv({ environment = process.env, envFile = defaultEnvFile } = {}) {
  // 先依平台參數決定模式；production 完全不讀取本機 .env。
  const nodeEnv = environment.NODE_ENV || 'development';
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

  const authSecret = environment.AUTH_SECRET?.trim() || '';
  const limitStore = environment.LIMIT_STORE || (nodeEnv === 'production' ? 'dynamodb' : 'memory');
  if (!['memory', 'dynamodb'].includes(limitStore)) throw new Error('LIMIT_STORE 必須是 memory 或 dynamodb');
  if (authSecret && Buffer.byteLength(authSecret) < 32) throw new Error('AUTH_SECRET 至少需要 32 bytes');
  if (nodeEnv === 'production' && !authSecret) throw new Error('production 缺少 AUTH_SECRET');
  if (nodeEnv === 'production' && limitStore !== 'dynamodb') throw new Error('production 必須使用 dynamodb 限制儲存');
  const limitTable = environment.LIMIT_TABLE || '';
  const awsRegion = environment.AWS_REGION || environment.AWS_DEFAULT_REGION || '';
  if (limitStore === 'dynamodb' && (!limitTable || !awsRegion)) throw new Error('dynamodb 需要 LIMIT_TABLE 與 AWS_REGION');

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

  return Object.freeze({
    authSecret, limitStore, limitTable, awsRegion,
    demoPassword: environment.DEMO_PASSWORD || '123456',
    authTtlSeconds: positive('AUTH_TTL_SECONDS', 7200),
    chatCooldownSeconds: positive('CHAT_COOLDOWN_SECONDS', 10),
    userDailyLimit: positive('USER_DAILY_LIMIT', 30),
    globalDailyLimit: positive('GLOBAL_DAILY_LIMIT', 100),
    globalConcurrency: positive('GLOBAL_CONCURRENCY', 2),
    loginFailureLimit: positive('LOGIN_FAILURE_LIMIT', 10),
    loginWindowSeconds: positive('LOGIN_WINDOW_SECONDS', 900),
    trustProxy: /^\d+$/.test(environment.TRUST_PROXY || '') ? Number(environment.TRUST_PROXY) : environment.TRUST_PROXY?.trim() || false,
    logLevel,
    nodeEnv,
    port,
    corsOrigin: corsOrigin || 'http://localhost:5173',
    geminiApiKey,
    geminiModel: environment.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
    geminiEmbeddingModel: environment.GEMINI_EMBEDDING_MODEL?.trim() || 'gemini-embedding-001',
  });
}

export const env = loadEnv();
