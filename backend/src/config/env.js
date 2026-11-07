import dotenv from 'dotenv';
import proxyaddr from 'proxy-addr';
import { fileURLToPath } from 'node:url';

const defaultEnvFile = fileURLToPath(new URL('../../.env', import.meta.url));
// 支援的 AI 供應商：金鑰的環境參數名稱與未設定模型時的預設模型。
export const AI_PROVIDERS = Object.freeze({
  gemini: Object.freeze({ keyName: 'GEMINI_API_KEY', defaultModel: 'gemini-3.5-flash' }),
  anthropic: Object.freeze({ keyName: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-5-5' }),
});
const TRUST_PROXY_ERROR = 'TRUST_PROXY 格式無效：請填信任的代理跳數整數、loopback／linklocal／uniquelocal，或以逗號分隔的 IP／CIDR；未設定時不信任代理';

/**
 * 解析 Express 的 trust proxy 設定，在啟動前拒絕 Express 無法編譯的值，避免匯入 server.js 時才拋出原始 TypeError。
 * 規則：未設定或空白 → false（不信任代理）；純十進位整數 → 信任的跳數；'true'／'false' 一律拒絕（環境變數無法安全表示布林，且 true 會信任所有來源）；
 * 其他字串以逗號分隔後交給 Express 依賴的 proxy-addr 編譯驗證（接受 loopback、linklocal、uniquelocal、IP 與 CIDR）。
 * 錯誤訊息不回顯原始值。
 * @param {string|undefined} raw TRUST_PROXY 環境參數原值。
 * @returns {number|string|false} 可直接傳給 app.set('trust proxy') 的值。
 * @throws {Error} 值為 true／false 或無法被 proxy-addr 編譯。
 */
function parseTrustProxy(raw) {
  const value = raw?.trim() || '';
  if (!value) return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (/^(true|false)$/i.test(value)) throw new Error(TRUST_PROXY_ERROR);
  /** 去除單一代理項目的首尾空白，與 Express 拆解逗號清單的方式一致。@param {string} entry 代理項目。@returns {string} 去除空白後的項目。 */
  function trimEntry(entry) { return entry.trim(); }
  try { proxyaddr.compile(value.split(',').map(trimEntry)); } catch { throw new Error(TRUST_PROXY_ERROR); }
  return value;
}

/**
 * 僅接受 local 與 production；預設 local 讀取本機設定，正式環境只讀平台變數。
 * @param {object} [options={}] 載入選項。
 * @param {object} [options.environment=process.env] 環境變數來源。
 * @param {string} [options.envFile] 本機 .env 的絕對路徑。
 * AI 設定：AI_PROVIDER 是主要供應商，gemini（預設）或 anthropic；aiApiKey、aiModel、aiKeyName 是主要供應商的金鑰、模型與金鑰參數名稱
 * （Gemini 預設模型 gemini-3.5-flash，Claude 預設 claude-sonnet-5-5，可用 GEMINI_MODEL、ANTHROPIC_MODEL 覆寫）；
 * aiFallbackProvider 是另一家有設定金鑰時的備援供應商（沒有金鑰時為 null）；兩家的原始設定也一併保留。production 只要求主要供應商的金鑰。
 * @returns {Readonly<object>} 包含 AI 供應商與模型、日誌、HTTP 頻率（含自動生成 httpDraftLimit）、自動生成每日額度（draftUserDailyLimit、draftGlobalDailyLimit）、登入失敗視窗、獨立管理密碼、來源驗證、關機緩衝、記憶體限制儲存、需求單 SQLite 檔（databaseFile）與舊版 JSON 匯入來源（ticketsFile）路徑的設定。
 * @throws {Error} 模式不是 local／production、AI_PROVIDER 不是 gemini／anthropic、必要密碼缺少或共用、正式環境缺少主要供應商的金鑰或其他必要設定、限制無效、TRUST_PROXY 格式無效（含 true／false）或關機緩衝不足 70 秒。
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

  // AI 供應商：主要供應商預設 gemini；另一家有設定金鑰時作為備援（主要供應商回 429 額度或流量已滿時才改用，見 ai/providers.js）。
  const aiProvider = environment.AI_PROVIDER?.trim().toLowerCase() || 'gemini';
  if (!Object.hasOwn(AI_PROVIDERS, aiProvider)) throw new Error(`AI_PROVIDER 只接受 ${Object.keys(AI_PROVIDERS).join(' 或 ')}`);
  const geminiApiKey = environment.GEMINI_API_KEY?.trim() || '';
  const anthropicApiKey = environment.ANTHROPIC_API_KEY?.trim() || '';
  const aiApiKey = aiProvider === 'anthropic' ? anthropicApiKey : geminiApiKey;
  const otherProvider = aiProvider === 'anthropic' ? 'gemini' : 'anthropic';
  const aiFallbackProvider = (otherProvider === 'anthropic' ? anthropicApiKey : geminiApiKey) ? otherProvider : null;
  const corsOrigin = environment.CORS_ORIGIN?.trim() || '';
  if (nodeEnv === 'production') {
    // 只指出缺少哪個參數，不輸出參數值或金鑰。
    for (const [name, value] of [[AI_PROVIDERS[aiProvider].keyName, aiApiKey], ['CORS_ORIGIN', corsOrigin]]) {
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
  if (limitStore !== 'memory') throw new Error('LIMIT_STORE 只接受 memory；配額、冷卻與登入保護只存在單程序記憶體');
  if (authSecret && Buffer.byteLength(authSecret) < 32) throw new Error('AUTH_SECRET 至少需要 32 bytes');
  if (nodeEnv === 'production' && !authSecret) throw new Error('production 缺少 AUTH_SECRET');
  const adminPassword = environment.ADMIN_PASSWORD;
  if (typeof adminPassword !== 'string' || !adminPassword.trim()) throw new Error('缺少必要環境參數：ADMIN_PASSWORD');
  if (adminPassword === environment.DEMO_PASSWORD) throw new Error('ADMIN_PASSWORD 不得與 DEMO_PASSWORD 相同');
  // 需求單資料（含狀態與簽核紀錄）保存在 SQLite 檔，預設在 backend/storage（與容器的 /app/storage 同名）；可用 DATABASE_FILE 指定其他絕對路徑
  const databaseFile = environment.DATABASE_FILE?.trim() || fileURLToPath(new URL('../../storage/helpdesk.db', import.meta.url));
  // 舊版 JSON 需求單檔，只作為一次性匯入與回滾匯出的來源；執行中的服務不再寫入。
  const ticketsFile = environment.TICKETS_FILE?.trim() || fileURLToPath(new URL('../../storage/tickets.json', import.meta.url));
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

  // 需求單判斷的單次上游逾時為 15 秒、自動生成一回合（含工具呼叫）的總期限為 60 秒；關機至少再保留 10 秒等待租約與記錄寫入完成。
  const shutdownTimeoutMs = positive('SHUTDOWN_TIMEOUT_MS', 75000);
  if (shutdownTimeoutMs < 70000) throw new Error('SHUTDOWN_TIMEOUT_MS 至少需要 70000 毫秒');
  const geminiModel = environment.GEMINI_MODEL?.trim() || AI_PROVIDERS.gemini.defaultModel;
  const anthropicModel = environment.ANTHROPIC_MODEL?.trim() || AI_PROVIDERS.anthropic.defaultModel;

  return Object.freeze({
    authSecret, originVerifySecret, limitStore, adminPassword, shutdownTimeoutMs,
    demoPassword, databaseFile, ticketsFile,
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
    // 「自動生成」草稿：HTTP 每帳號視窗上限，以及與需求單判斷分開計算的每日 AI 額度（不設冷卻）。
    httpDraftLimit: positive('HTTP_DRAFT_LIMIT', 30),
    draftUserDailyLimit: positive('DRAFT_USER_DAILY_LIMIT', 60),
    draftGlobalDailyLimit: positive('DRAFT_GLOBAL_DAILY_LIMIT', 300),
    loginFailureLimit: positive('LOGIN_FAILURE_LIMIT', 100),
    loginWindowSeconds: positive('LOGIN_WINDOW_SECONDS', 900),
    loginAccountFailureLimit: positive('LOGIN_ACCOUNT_FAILURE_LIMIT', 5),
    loginAccountWindowSeconds: positive('LOGIN_ACCOUNT_WINDOW_SECONDS', 300),
    trustProxy: parseTrustProxy(environment.TRUST_PROXY),
    logLevel,
    nodeEnv,
    port,
    corsOrigin: corsOrigin || 'http://localhost:5173',
    aiProvider,
    aiApiKey,
    aiFallbackProvider,
    aiModel: aiProvider === 'anthropic' ? anthropicModel : geminiModel,
    aiKeyName: AI_PROVIDERS[aiProvider].keyName,
    geminiApiKey,
    geminiModel,
    anthropicApiKey,
    anthropicModel,
  });
}

export const env = loadEnv();
