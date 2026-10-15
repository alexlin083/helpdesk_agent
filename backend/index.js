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
    corsOrigin: env.corsOrigin, model: env.geminiModel, embeddingModel: env.geminiEmbeddingModel,
    credentialsConfigured: Boolean(env.geminiApiKey), logLevel: env.logLevel,
    localUrl: `http://localhost:${env.port}/api` });
  if (!env.geminiApiKey) logger('warn', 'server.credentials.missing', { hint: '請在後端設定 GEMINI_API_KEY 並重新啟動。' });
  logger('info', 'server.limits', { store: env.limitStore, accountCount: 10, userDailyLimit: env.userDailyLimit,
    globalDailyLimit: env.globalDailyLimit, cooldownSeconds: env.chatCooldownSeconds, globalConcurrency: env.globalConcurrency });
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

/**
 * 收到系統關閉訊號後停止接收請求，最多等待十秒後強制結束。
 * @returns {void}
 */
function shutdown() {
  logger('info', 'server.stopping');
  server.close(onClosed);
  setTimeout(onShutdownTimeout, 10000).unref();
}

/** 正常關閉後結束程序。@returns {never} */
function onClosed() { process.exit(0); }

/** 超過關閉期限時以非零代碼結束程序。@returns {never} */
function onShutdownTimeout() { process.exit(1); }

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
