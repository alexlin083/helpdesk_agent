import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DEMO_PASSWORD = 'test-only-password';
process.env.GEMINI_API_KEY = '';
const { buildAgentDecision, createHelpdeskAgent } = await import('../services/geminiAgent.js');
const { createKnowledgeRetriever, cosineSimilarity } = await import('../services/knowledgeService.js');
const docs = [{ doc_name: 'VPN.md', content: '檢查 VPN 憑證', relevance: 0.9 }];
const auto = { intent: 'IT_SUPPORT', confidence_score: 88, action_route: 'AUTO_REPLY', reply_text: '檢查憑證', ticket_payload: null };
const ticket = { ticket_id: 'model-id', level: 'P3_NORMAL', department: 'IT資訊服務台', action_required: '人工檢查' };

test('75 分邊界、自動回覆、低信心工單與唯一編號', () => {
  for (const confidence of [75, 100]) {
    const result = buildAgentDecision({ ...auto, confidence_score: confidence }, docs, 'VPN');
    assert.equal(result.action_route, 'AUTO_REPLY');
    assert.equal(result.ticket_payload, null);
    assert.deepEqual(result.retrieved_sources, [{ doc_name: 'VPN.md', relevance: 0.9 }]);
    assert.deepEqual(Object.keys(result), ['intent', 'retrieved_sources', 'confidence_score', 'action_route', 'reply_text', 'ticket_payload']);
  }
  const input = { ...auto, confidence_score: 74, action_route: 'ESCALATE_TICKET', ticket_payload: ticket };
  const result = buildAgentDecision(input, docs, 'VPN');
  assert.equal(result.action_route, 'ESCALATE_TICKET');
  assert.equal(result.ticket_payload.level, 'P3_NORMAL');
  assert.deepEqual(Object.keys(result.ticket_payload), ['ticket_id', 'level', 'department', 'action_required']);
  assert.match(result.ticket_payload.ticket_id, /^TK-[0-9a-f-]{36}$/);
  assert.notEqual(result.ticket_payload.ticket_id, buildAgentDecision(input, docs, 'VPN').ticket_payload.ticket_id);
});

test('無引據、緊急事件、分流矛盾採保守轉派', () => {
  assert.equal(buildAgentDecision(auto, [], '沒有規章的問題').action_route, 'ESCALATE_TICKET');
  const danger = buildAgentDecision(auto, docs, '辦公室螢幕冒煙了');
  assert.equal(danger.intent, 'HARDWARE_FACILITY');
  assert.ok(danger.confidence_score < 75);
  assert.equal(danger.ticket_payload.level, 'P1_URGENT');
  assert.equal(danger.ticket_payload.department, '總務與硬體組');
  assert.ok(!danger.reply_text.includes('檢查憑證'));
  assert.equal(buildAgentDecision({ ...auto, confidence_score: 20 }, docs, 'VPN').action_route, 'ESCALATE_TICKET');
  assert.equal(buildAgentDecision({ ...auto, action_route: 'ESCALATE_TICKET', ticket_payload: ticket }, docs, 'VPN').confidence_score, 74);
});

test('拒絕非法分類、分數、工單結構及缺少欄位', () => {
  for (const input of [null, { ...auto, intent: 'FACILITY_REPORT' }, { ...auto, confidence_score: 101 },
    { ...auto, confidence_score: 75.5 }, { ...auto, reply_text: '' }, { ...auto, action_route: 'OTHER' },
    { ...auto, ticket_payload: undefined }, { ...auto, ticket_payload: { priority: 'P1_URGENT' } }]) {
    assert.throws(() => buildAgentDecision(input, docs, 'VPN'), (error) => error.status === 500 && error.code === 'SERVER_ERROR');
  }
});

test('結構化輸出與檢索內容傳入 SDK，模型捏造引據不會被回傳', async () => {
  const run = createHelpdeskAgent({
    getAI: () => ({ models: { generateContent: async (request) => {
      assert.equal(request.config.responseMimeType, 'application/json');
      assert.ok(request.config.responseSchema.properties.ticket_payload.nullable);
      assert.deepEqual(JSON.parse(request.contents).retrieved_contexts, docs);
      return { text: JSON.stringify({ ...auto, retrieved_sources: [{ doc_name: 'fake.md', relevance: 1 }] }) };
    } } }), retrieve: async () => docs,
  });
  assert.deepEqual((await run('VPN')).retrieved_sources, [{ doc_name: 'VPN.md', relevance: 0.9 }]);
});

test('無效 JSON、空白回覆、embedding 限流與一般錯誤', async () => {
  for (const text of ['', '```json {} ```', '{}']) {
    const run = createHelpdeskAgent({ getAI: () => ({ models: { generateContent: async () => ({ text }) } }), retrieve: async () => docs });
    await assert.rejects(run('VPN'), (error) => error.status === 500 && error.code === 'SERVER_ERROR');
  }
  for (const status of [429, 400]) {
    const run = createHelpdeskAgent({ getAI: () => ({}), retrieve: async () => { throw { status }; } });
    await assert.rejects(run('VPN'), (error) => error.status === (status === 429 ? 429 : 500));
  }
});

test('Cosine Top-3 排序，索引快取、並行建立與 query embedding', async () => {
  const documents = ['A', 'B', 'C', 'D'].map((name) => ({ doc_name: `${name}.md`, content: name }));
  const calls = [];
  const ai = { models: { embedContent: async (request) => {
    calls.push(request.config.taskType);
    const values = request.config.taskType === 'RETRIEVAL_DOCUMENT' ? [[0, 1], [1, 0], [-1, 0], [1, 1]] : [[1, 0]];
    return { embeddings: values.map((vector) => ({ values: vector })) };
  } } };
  const retrieve = createKnowledgeRetriever({ documents, model: 'test-embedding' });
  const [first, second] = await Promise.all([retrieve('query', ai), retrieve('query', ai)]);
  assert.deepEqual(first.map((doc) => doc.doc_name), ['B.md', 'D.md', 'A.md']);
  assert.deepEqual(first.map((doc) => doc.relevance), [1, 0.7071, 0]);
  assert.deepEqual(first, second);
  assert.equal(calls.filter((task) => task === 'RETRIEVAL_DOCUMENT').length, 1);
  assert.equal(calls.filter((task) => task === 'RETRIEVAL_QUERY').length, 2);
});

test('embedding 索引失敗可重試、無文件不呼叫 API、非法向量拒絕', async () => {
  let calls = 0;
  const ai = { models: { embedContent: async () => {
    if (++calls === 1) throw new Error('temporary failure');
    return { embeddings: [{ values: [1, 0] }] };
  } } };
  const retrieve = createKnowledgeRetriever({ documents: [{ doc_name: 'test.md', content: 'test' }] });
  await assert.rejects(retrieve('query', ai));
  assert.equal((await retrieve('query', ai))[0].relevance, 1);
  assert.deepEqual(await createKnowledgeRetriever({ documents: [] })('query', {}), []);
  for (const [left, right] of [[[], [1]], [[0], [1]], [[NaN], [1]], [[1], [1, 2]]]) {
    assert.throws(() => cosineSimilarity(left, right));
  }
});
