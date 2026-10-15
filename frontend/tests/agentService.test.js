import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentServiceError, sendChatMessage, validateAgentResponse, getUsage } from '../src/services/agentService.js';

const USER_ID = 'user-admin1';
const originalFetch = globalThis.fetch;
const originalStorage = globalThis.sessionStorage;
let session;
/** 建立有效前端登入狀態，不呼叫後端。@returns {void} */
function setupSession() {
  session = { user: { username: 'admin1', userID: USER_ID }, token: 'test-token', expiresAt: Date.now() + 60000 };
  globalThis.sessionStorage = {
    /** 讀取工作階段。@returns {string} 序列化登入資料。 */
    getItem() { return JSON.stringify(session); },
  };
}
test.beforeEach(setupSession);
const reply = {
  intent: 'IT_SUPPORT',
  retrieved_sources: [{ doc_name: 'VPN連線故障排查手冊.md', relevance: 0.89 }],
  confidence_score: 88,
  action_route: 'AUTO_REPLY',
  reply_text: '請確認帳號與憑證狀態。',
  ticket_payload: null,
};

/**
 * 還原測試替換的 fetch，避免影響其他測試或呼叫端。
 * @returns {void}
 */
function restoreFetch() {
  globalThis.fetch = originalFetch;
  globalThis.sessionStorage = originalStorage;
}
test.afterEach(restoreFetch);

/**
 * 驗證輸入去空白、請求 URL、JSON 標頭及無歷史紀錄的 payload，並接收有效回應。
 * @returns {Promise<void>} 完成一次替身請求的合約檢查。
 */
async function requestContract() {
  /**
   * 模擬成功的後端，同時檢查實際送出的請求設定。
   * @param {string} url 待呼叫的 API 網址。
   * @param {RequestInit} options HTTP 請求設定。
   * @returns {Promise<Response>} 有效的自動回答 JSON。
   */
  async function fakeFetch(url, options) {
    assert.equal(url, 'http://localhost:3000/api/agent/chat');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer test-token' });
    assert.deepEqual(JSON.parse(options.body), { message: 'VPN 連不上', userID: USER_ID });
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(reply);
  }
  globalThis.fetch = fakeFetch;
  assert.deepEqual(await sendChatMessage('  VPN 連不上  ', USER_ID), reply);
}
test('對話 service 使用正確的 API 合約並去除首尾空白', requestContract);

/**
 * 驗證空白與超長輸入不呼叫網路，並依 code points 接受 500 個 emoji。
 * @returns {Promise<void>} 完成輸入邊界驗證。
 */
async function inputBoundaries() {
  let calls = 0;
  /**
   * 記錄請求次數並回傳有效資料，以區分前端拒絕與實際送出。
   * @returns {Promise<Response>} 有效回應。
   */
  async function fakeFetch() {
    calls += 1;
    return Response.json(reply);
  }
  globalThis.fetch = fakeFetch;
  await assert.rejects(sendChatMessage('   ', USER_ID), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(sendChatMessage('😀'.repeat(501), USER_ID), { code: 'INVALID_PAYLOAD' });
  assert.equal(calls, 0);
  await sendChatMessage('😀'.repeat(500), USER_ID);
  assert.equal(calls, 1);
}
test('輸入驗證與 Unicode 字元邊界符合後端', inputBoundaries);

/**
 * 驗證人工分流的完整工單可被接受，並拒絕缺少欄位與矛盾的分流資料。
 * @returns {void}
 */
function responseContract() {
  const escalation = { ...reply, confidence_score: 74, action_route: 'ESCALATE_TICKET', ticket_payload: {
    ticket_id: 'TK-example', level: 'P3_NORMAL', department: 'IT資訊服務台', action_required: '人工確認',
  } };
  assert.deepEqual(validateAgentResponse(escalation), escalation);
  const invalid = [null, {}, { ...reply, intent: 'INVALID' }, { ...reply, confidence_score: 74 },
    { ...reply, confidence_score: 101 }, { ...reply, retrieved_sources: [{ doc_name: '來源', relevance: 2 }] },
    { ...escalation, ticket_payload: null }, { ...escalation, ticket_payload: { level: 'P1_URGENT' } }];
  for (const data of invalid) {
    /**
     * 將一筆不合約資料交給驗證器，供斷言檢查拋出的錯誤。
     * @returns {object} 僅資料有效時回傳；本測試預期拋出錯誤。
     * @throws {AgentServiceError} 不合約資料被拒絕。
     */
    function validateInvalid() {
      return validateAgentResponse(data);
    }
    assert.throws(validateInvalid, { code: 'INVALID_RESPONSE' });
  }
}
test('接受完整工單並拒絕不完整或互相矛盾的回應', responseContract);

/**
 * 驗證後端 400、429、500 錯誤的代碼、狀態與訊息保留，不進行自動重送。
 * @returns {Promise<void>}
 */
async function httpErrors() {
  for (const [status, code] of [[400, 'INVALID_PAYLOAD'], [429, 'RATE_LIMIT_EXCEEDED'], [500, 'SERVER_ERROR']]) {
    let calls = 0;
    /**
     * 模擬目前迴圈指定的後端錯誤。
     * @returns {Promise<Response>} 統一格式的錯誤 JSON。
     */
    async function fakeFetch() {
      calls += 1;
      return Response.json({ error: { code, message: '測試錯誤提示' } }, { status });
    }
    globalThis.fetch = fakeFetch;
    await assert.rejects(sendChatMessage('測試', USER_ID), { name: 'AgentServiceError', status, code, message: '測試錯誤提示' });
    assert.equal(calls, 1);
  }
}
test('HTTP 錯誤可由介面辨識且不會自動重試', httpErrors);

/**
 * 驗證 HTML、缺少必要欄位、連線錯誤及逾時皆會轉成可顯示的服務錯誤。
 * @returns {Promise<void>}
 */
async function unexpectedFailures() {
  /**
   * 模擬反向代理回傳 HTML，確認不將其當成對話結果。
   * @returns {Promise<Response>} 非 JSON 回應。
   */
  async function htmlFetch() {
    return new Response('<html>proxy error</html>', { status: 502 });
  }
  globalThis.fetch = htmlFetch;
  await assert.rejects(sendChatMessage('測試', USER_ID), { code: 'INVALID_RESPONSE' });
  /**
   * 模擬 HTTP 成功但缺少欄位的 JSON。
   * @returns {Promise<Response>} 不符合合約的 JSON。
   */
  async function malformedFetch() {
    return Response.json({ reply_text: '不完整' });
  }
  globalThis.fetch = malformedFetch;
  await assert.rejects(sendChatMessage('測試', USER_ID), { code: 'INVALID_RESPONSE' });
  /**
   * 模擬瀏覽器無法連線的錯誤。
   * @returns {Promise<never>} 一律失敗。
   * @throws {TypeError} 模擬 fetch 網路錯誤。
   */
  async function offlineFetch() {
    throw new TypeError('Failed to fetch');
  }
  globalThis.fetch = offlineFetch;
  await assert.rejects(sendChatMessage('測試', USER_ID), { code: 'NETWORK_ERROR' });
  /**
   * 模擬請求逾時，不需要實際等待 100 秒。
   * @returns {Promise<never>} 一律失敗。
   * @throws {DOMException} 模擬 AbortSignal.timeout 的錯誤。
   */
  async function timeoutFetch() {
    throw new DOMException('Timed out', 'TimeoutError');
  }
  globalThis.fetch = timeoutFetch;
  await assert.rejects(sendChatMessage('測試', USER_ID), { code: 'TIMEOUT' });
  assert.ok(new AgentServiceError('測試') instanceof Error);
}
test('非 JSON、不合約回應、斷線與逾時都有明確錯誤', unexpectedFailures);

/**
 * 驗證缺少或未知識別碼時不呼叫網路，且十個帳號各自傳送固定的 userID。
 * @returns {Promise<void>}
 */
async function userIdentityContract() {
  const received = [];
  /**
   * 捕捉每一筆請求身分，確保本文僅包含單次問題及 userID，沒有密碼。
   * @param {string} url API 網址。
   * @param {RequestInit} options 請求設定。
   * @returns {Promise<Response>} 合約正確的回應。
   */
  async function fakeFetch(url, options) {
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ['message', 'userID']);
    received.push(body.userID);
    return Response.json(reply);
  }
  globalThis.fetch = fakeFetch;
  for (const userID of [undefined, '', 'admin1', 'user-admin11']) {
    await assert.rejects(sendChatMessage('測試', userID), { code: 'LOGIN_REQUIRED' });
  }
  assert.equal(received.length, 0);
  for (let index = 1; index <= 10; index += 1) {
    session.user = { username: `admin${index}`, userID: `user-admin${index}` };
    await sendChatMessage('測試', session.user.userID);
  }
  assert.deepEqual(received, ['user-admin1', 'user-admin2', 'user-admin3', 'user-admin4', 'user-admin5', 'user-admin6', 'user-admin7', 'user-admin8', 'user-admin9', 'user-admin10']);
}
test('每次對話必須附上十個帳號之一的固定 userID', userIdentityContract);

/**
 * 驗證用量查詢使用憑證與 GET、不扣額，並保留後端重試秒數供聊天倒數使用。
 * @returns {Promise<void>}
 */
async function usageAndRetry() {
  const expected = { userDailyLimit: 30, userRemaining: 29, globalDailyLimit: 100, globalRemaining: 99,
    resetAt: '2026-10-15T16:00:00Z', cooldownSeconds: 8 };
  /**
   * 模擬用量回應，同時確認正確的網址及憑證。
   * @param {string} url 請求網址。
   * @param {RequestInit} options 請求選項。
   * @returns {Promise<Response>} 用量回應。
   */
  async function usageFetch(url, options) {
    assert.equal(url, 'http://localhost:3000/api/agent/usage');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.body, undefined);
    return Response.json(expected);
  }
  globalThis.fetch = usageFetch;
  assert.deepEqual(await getUsage(), expected);
  /** 模擬後端要求延長等待。@returns {Promise<Response>} 限流回應。 */
  async function limitedFetch() {
    return Response.json({ error: { code: 'RATE_LIMIT_EXCEEDED', message: '等待', retry_after: 17 } }, { status: 429, headers: { 'Retry-After': '17' } });
  }
  globalThis.fetch = limitedFetch;
  await assert.rejects(sendChatMessage('測試', USER_ID), { status: 429, retryAfter: 17 });
  session.expiresAt = Date.now() - 1;
  await assert.rejects(getUsage(), { status: 401 });
  await assert.rejects(sendChatMessage('測試', USER_ID), { code: 'LOGIN_REQUIRED' });
}
test('查詢用量、後端等待秒數與過期登入保護', usageAndRetry);
