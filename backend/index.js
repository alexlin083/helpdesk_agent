import { accountService } from './services/accountService.js';
import { chatTasks } from './services/chatTasks.js';
import { drainServer } from './utils/shutdown.js';
import { app } from './server.js';
import { env } from './config/env.js';
import { logger, diagnoseError } from './utils/logger.js';

const server = app.listen(env.port, onListening);

/**
 * 監聽成功後記錄可公開的啟動設定；金鑰只顯示是否設定，不測試外部連線。
 * @returns {void}
 */
function onListening() {
  logger('info', 'server.started', { port: env.port, nodeEnv: env.nodeEnv, nodeVersion: process.version,
    corsOrigin: env.corsOrigin, model: env.geminiModel,
    credentialsConfigured: Boolean(env.geminiApiKey), logLevel: env.logLevel,
    localUrl: `http://localhost:${env.port}/api` });
  if (!env.geminiApiKey) logger('warn', 'server.credentials.missing', { hint: '請在後端設定 GEMINI_API_KEY 並重新啟動。' });
  logger('info', 'server.limits', { store: env.limitStore, ticketStore: 'file', accountCount: accountService.usernames.length, userDailyLimit: env.userDailyLimit,
    globalDailyLimit: env.globalDailyLimit, cooldownSeconds: env.chatCooldownSeconds, globalConcurrency: env.globalConcurrency });
  logger('info', 'server.http_limits', { store: 'bounded-memory', windowSeconds: env.httpRateWindowSeconds,
    api: env.httpApiLimit, login: env.httpLoginLimit, ticket: env.httpTicketLimit, departments: env.httpDepartmentsLimit, query: env.httpQueryLimit,
    maxKeysPerLimiter: env.httpRateMaxKeys, loginFailureLimit: env.loginFailureLimit,
    loginWindowSeconds: env.loginWindowSeconds, loginAccountFailureLimit: env.loginAccountFailureLimit,
    loginAccountWindowSeconds: env.loginAccountWindowSeconds });
  if (!env.authSecret) logger('warn', 'server.auth.ephemeral', { hint: '本機暫用隨機簽章金鑰，重啟後需重新登入；正式環境必須設定 AUTH_SECRET。' });
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
server.on('error', onServerError);

let stopping = false;
/**
 * 停止接受新需求單與連線，等待既有工作及租約清理完成後才結束程序。
 * 重複訊號不啟動第二次關機；超過設定期限才強制關閉連線並以非零碼結束。
 * @returns {Promise<void>} 正常或強制關閉程序。
 */
async function shutdown() {
  if (stopping) return;
  stopping = true;
  logger('info', 'server.stopping', { timeoutMs: env.shutdownTimeoutMs });
  try {
    await drainServer(server, chatTasks, env.shutdownTimeoutMs);
    logger('info', 'server.stopped');
    process.exit(0);
  } catch {
    logger('error', 'server.shutdown.failed', { reason: 'DRAIN_FAILED_OR_TIMEOUT' });
    server.closeAllConnections();
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
