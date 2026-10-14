import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// 必須在匯入設定前覆寫，測試不讀取真實金鑰，也不呼叫 Gemini。
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = '';
process.env.PORT = '3000';
process.env.CORS_ORIGIN = 'http://localhost:5173';
const { app } = await import('../server.js');
const { createChatHandler } = await import('../controllers/agentController.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const { createHelpdeskAgent } = await import('../services/geminiAgent.js');
const decision = {
  intent: 'IT_SUPPORT', retrieved_sources: [{ doc_name: 'VPN.md', relevance: 0.9 }],
  confidence_score: 88, action_route: 'AUTO_REPLY', reply_text: '請檢查 VPN 憑證。', ticket_payload: null,
};

async function withServer(application, run) {
  const server = application.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('API 健康檢查、路由與錯誤回應', async () => {
  await withServer(app, async (base) => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).data.status, 'ok');
    assert.equal(health.headers.get('access-control-allow-origin'), 'http://localhost:5173');

    assert.equal((await fetch(`${base}/api/missing`)).status, 404);
    const preflight = await fetch(`${base}/api/agent/chat`, {
      method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET,POST,OPTIONS');
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type,Accept');
    const otherOrigin = await fetch(`${base}/api/health`, { headers: { Origin: 'https://untrusted.example' } });
    assert.notEqual(otherOrigin.headers.get('access-control-allow-origin'), 'https://untrusted.example');

    for (const body of [{}, { message: '   ' }, { message: 123 }, { message: 'a'.repeat(501) }]) {
      const response = await fetch(`${base}/api/agent/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: {
        code: 'INVALID_PAYLOAD', message: 'message 必須是 1 到 500 字元的非空白字串',
      } });
    }

    const malformed = await fetch(`${base}/api/agent/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'INVALID_PAYLOAD');

    const oversized = await fetch(`${base}/api/agent/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'a'.repeat(20000) }),
    });
    assert.equal(oversized.status, 413);

    const unconfigured = await fetch(`${base}/api/agent/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '你好' }),
    });
    assert.equal(unconfigured.status, 500);
    assert.equal((await unconfigured.json()).error.code, 'SERVER_ERROR');
  });
});

test('對話成功回應，使用替身驗證輸入與輸出而不呼叫付費 API', async () => {
  const application = express();
  application.use(express.json());
  application.post('/chat', createChatHandler(async (message) => {
    assert.ok(message === '你好' || Array.from(message).length === 500);
    return decision;
  }));
  application.use(errorHandler);

  await withServer(application, async (base) => {
    const response = await fetch(`${base}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: ' 你好 ' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), decision);
    const boundary = await fetch(`${base}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '🙂'.repeat(500) }),
    });
    assert.equal(boundary.status, 200);
  });
});

test('Gemini 限流與錯誤輸出符合 API 合約且不洩漏原始錯誤', async () => {
  for (const status of [429, 503]) {
    const application = express();
    application.use(express.json());
    application.post('/api/agent/chat', createChatHandler(createHelpdeskAgent({
      getAI: () => ({ models: { generateContent: async () => { throw { status, message: 'secret-upstream-details' }; } } }),
      retrieve: async () => [],
    })));
    application.use(errorHandler);
    await withServer(application, async (base) => {
      const response = await fetch(`${base}/api/agent/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '你好' }),
      });
      assert.equal(response.status, status === 429 ? 429 : 500);
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ['error']);
      assert.equal(body.error.code, status === 429 ? 'RATE_LIMIT_EXCEEDED' : 'SERVER_ERROR');
      assert.ok(!JSON.stringify(body).includes('secret-upstream-details'));
      if (status === 429) assert.equal(response.headers.get('retry-after'), '10');
    });
  }
});
