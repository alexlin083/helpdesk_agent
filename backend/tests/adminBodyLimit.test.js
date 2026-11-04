import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupTestEnv } from './helpers/testEnv.js';

// 獨立測試檔（獨立程序）：管理限流器在模組載入時建立，需以小額度的假設定載入，且不與 admin.test.js 共用計數。
setupTestEnv({
  DEMO_PASSWORD: 'test-only-user-password',
  ADMIN_PASSWORD: 'test-only-admin-password',
  ORIGIN_VERIFY_SECRET: '',
  HTTP_API_LIMIT: '5',
});
const { app } = await import('../src/server.js');

/**
 * 啟動只監聽本機的測試 server，回傳基底網址與關閉函式。
 * @returns {Promise<{base: string, stop: Function}>} 測試網址與關閉函式（stop 回傳 Promise<void>）。
 */
async function startLocal() {
  const server = app.listen(0, '127.0.0.1');
  /** 等待測試埠就緒。@param {Function} resolve 完成。@param {Function} reject 失敗。@returns {void} */
  function listening(resolve, reject) { server.once('listening', resolve); server.once('error', reject); }
  await new Promise(listening);
  /**
   * 強制關閉所有連線並等待 server 結束。
   * @returns {Promise<void>} 關閉完成。
   */
  async function stop() {
    server.closeAllConnections();
    /** 關閉 server。@param {Function} resolve 完成。@returns {void} */
    function close(resolve) { server.close(resolve); }
    await new Promise(close);
  }
  return { base: `http://127.0.0.1:${server.address().port}`, stop };
}

/**
 * 以 node:http 送出帶原始字串本文的請求（fetch 不允許 GET 帶本文），用來模擬格式錯誤或過大的 JSON；不帶任何憑證。
 * @param {string} url 完整網址。
 * @param {string} body 原始本文。
 * @param {string} [method='POST'] HTTP 方法。
 * @returns {Promise<{status: number, headers: object, json: Function}>} 狀態碼、回應標頭與解析本文的 json()。
 */
function sendRaw(url, body, method = 'POST') {
  /** 發出請求並收集回應本文。@param {Function} resolve 成功。@param {Function} reject 失敗。@returns {void} */
  function send(resolve, reject) {
    /** 讀完回應本文後回傳摘要。@param {http.IncomingMessage} response 回應。@returns {void} */
    function onResponse(response) {
      let text = '';
      /** 累加本文片段。@param {Buffer} chunk 片段。@returns {void} */
      function onData(chunk) { text += chunk; }
      /** 本文讀完後回傳狀態與標頭。@returns {void} */
      function onEnd() {
        /** 解析 JSON 本文，與 fetch Response.json 用法一致。@returns {Promise<object>} 回應物件。 */
        async function json() { return JSON.parse(text); }
        /** 以小寫標頭名稱讀取回應標頭，與 fetch Headers.get 用法一致。@param {string} name 小寫標頭名稱。@returns {string|undefined} 標頭值。 */
        function get(name) { return response.headers[name]; }
        resolve({ status: response.statusCode, headers: { get }, json });
      }
      response.on('data', onData);
      response.on('end', onEnd);
    }
    const request = http.request(url, { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, onResponse);
    request.on('error', reject);
    request.end(body);
  }
  return new Promise(send);
}

/**
 * 驗證管理路徑先計入 IP 限流再解析本文：格式錯誤（400）與過大（413）的本文都會計數，超過 HTTP_API_LIMIT 後回 429；
 * 未對應任何管理路由的 /api/admin/* 也由一般入口限流先計數。修正前 express.json 掛在管理限流之前，解析失敗永遠回 400，不會得到 429。
 * @returns {Promise<void>} 驗證完成。
 */
async function malformedAdminBodiesAreRateLimited() {
  const { base, stop } = await startLocal();
  try {
    const statuses = [];
    for (let index = 0; index < 4; index += 1) statuses.push((await sendRaw(`${base}/api/admin/reset`, '{"confirmation":')).status);
    statuses.push((await sendRaw(`${base}/api/admin/reset`, JSON.stringify({ padding: 'x'.repeat(20 * 1024) }))).status);
    assert.deepEqual(statuses, [400, 400, 400, 400, 413], '額度內仍回傳本文錯誤');
    const blocked = await sendRaw(`${base}/api/admin/reset`, '{"confirmation":');
    assert.equal(blocked.status, 429, '格式錯誤的管理本文超量後被限流');
    assert.equal((await blocked.json()).error.code, 'RATE_LIMIT_EXCEEDED');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    const metrics = await sendRaw(`${base}/api/admin/metrics`, '{"bad":', 'GET');
    assert.equal(metrics.status, 400, '監測路徑在自己的 IP 限流後仍拒絕格式錯誤的本文');
    const unknown = [];
    for (let index = 0; index < 6; index += 1) unknown.push((await sendRaw(`${base}/api/admin/unknown`, '{"bad":')).status);
    assert.deepEqual(unknown, [400, 400, 400, 400, 400, 429], '未對應的管理路徑由一般入口限流先計數');
  } finally { await stop(); }
}
test('管理路徑的格式錯誤本文先計入 IP 限流，超量回 429', malformedAdminBodiesAreRateLimited);
