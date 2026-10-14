import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const defaultEnvFile = fileURLToPath(new URL('../.env', import.meta.url));

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

  return Object.freeze({
    nodeEnv,
    port,
    corsOrigin: corsOrigin || 'http://localhost:5173',
    geminiApiKey,
    geminiModel: environment.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
    geminiEmbeddingModel: environment.GEMINI_EMBEDDING_MODEL?.trim() || 'gemini-embedding-001',
  });
}

export const env = loadEnv();
