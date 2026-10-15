import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = '';
const { loadEnv } = await import('../config/env.js');

function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'helpdesk-env-'));
  const envFile = join(directory, '.env');
  writeFileSync(envFile, 'GEMINI_API_KEY=fake-local-key\nPORT=3456\nCORS_ORIGIN=http://localhost:5173\n');
  try {
    run(envFile);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('本機讀取指定 .env，平台參數與空值不被覆寫', () => {
  withFixture((envFile) => {
    const local = loadEnv({ environment: {}, envFile });
    assert.equal(local.geminiApiKey, 'fake-local-key');
    assert.equal(local.port, 3456);
    const external = loadEnv({ environment: { GEMINI_API_KEY: 'fake-platform-key', PORT: '8080' }, envFile });
    assert.equal(external.geminiApiKey, 'fake-platform-key');
    assert.equal(external.port, 8080);
    assert.equal(loadEnv({ environment: { GEMINI_API_KEY: '' }, envFile }).geminiApiKey, '');
  });
});

test('production 忽略 .env，使用平台參數及 PORT', () => {
  withFixture((envFile) => {
    const config = loadEnv({
      environment: {
        NODE_ENV: 'production', GEMINI_API_KEY: 'fake-cloud-key', AUTH_SECRET: 'a'.repeat(32), LIMIT_TABLE: 'test', AWS_REGION: 'us-east-1',
        CORS_ORIGIN: 'https://example.github.io', PORT: '8080', GEMINI_MODEL: 'test-model',
      },
      envFile,
    });
    assert.equal(config.geminiApiKey, 'fake-cloud-key');
    assert.equal(config.port, 8080);
    assert.equal(config.corsOrigin, 'https://example.github.io');
    assert.equal(config.geminiModel, 'test-model');
    assert.throws(() => loadEnv({ environment: { NODE_ENV: 'production' }, envFile }), /GEMINI_API_KEY/);
    assert.throws(() => loadEnv({
      environment: { NODE_ENV: 'production', GEMINI_API_KEY: 'fake-cloud-key' }, envFile,
    }), /CORS_ORIGIN/);
  });
});

test('沒有 .env 時仍可使用平台參數；非法 PORT 被拒絕', () => {
  const config = loadEnv({ environment: { GEMINI_API_KEY: 'fake-key' }, envFile: '/nonexistent/helpdesk/.env' });
  assert.equal(config.geminiApiKey, 'fake-key');
  assert.equal(config.port, 3000);
  for (const port of ['abc', '0', '65536', '1.5']) {
    assert.throws(() => loadEnv({ environment: { NODE_ENV: 'production', PORT: port } }), /PORT/);
  }
});
