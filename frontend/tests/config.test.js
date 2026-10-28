import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 以隔離的模組實例驗證 API 網址選擇：Python 本機前端使用 3000，其餘網站沿用目前 origin。
 * 模擬瀏覽器 location；測試結束後還原原值，不發出 HTTP 請求或改動其他測試的設定。
 * @returns {Promise<void>} 所有部署情境完成驗證。
 */
async function apiOrigins() {
  const previous = globalThis.location;
  const scenarios = [
    [undefined, 'http://localhost:3000'],
    ['http://localhost:5173/', 'http://localhost:3000'],
    ['http://localhost:8080/', 'http://localhost:8080'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
    ['https://helpdesk.example.com/admin/admin.html', 'https://helpdesk.example.com'],
  ];
  try {
    for (const [index, [href, expected]] of scenarios.entries()) {
      globalThis.location = href ? new URL(href) : undefined;
      const moduleUrl = new URL('../src/config.js', import.meta.url);
      moduleUrl.searchParams.set('scenario', index);
      assert.equal((await import(moduleUrl.href)).API_BASE_URL, expected);
    }
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
}

test('分開的本機服務及 Docker／HTTPS 同站點 API 網址', apiOrigins);
