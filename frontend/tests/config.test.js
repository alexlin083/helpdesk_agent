import test from 'node:test';
import assert from 'node:assert/strict';
import { API_BASE_URL, resolveApiBaseUrl } from '../src/config.js';

/**
 * 驗證分開的本機服務、網站根目錄與子路徑部署的 API 網址。
 * 使用明確注入的模組位置，不改動全域 location，也不發送 HTTP 請求。
 * 特別確認深層頁面不影響基底路徑，避免登入後的管理／工作單 API 掉回根目錄。
 * @returns {void} 所有部署情境完成斷言。
 */
function apiOrigins() {
  assert.equal(API_BASE_URL, 'http://localhost:3000');
  const scenarios = [
    ['http://localhost:5173/', 'http://localhost:5173/src/config.js', 'http://localhost:3000'],
    ['http://localhost:8080/', 'http://localhost:8080/src/config.js', 'http://localhost:8080'],
    ['http://localhost:8080/helpdesk/', 'http://localhost:8080/helpdesk/src/config.js', 'http://localhost:8080/helpdesk'],
    ['http://127.0.0.1:8080/helpdesk/', 'http://127.0.0.1:8080/helpdesk/src/config.js', 'http://127.0.0.1:8080/helpdesk'],
    ['https://example.com/helpdesk/admin/admin.html', 'https://example.com/helpdesk/src/config.js', 'https://example.com/helpdesk'],
    ['https://example.com/helpdesk/tickets/tickets.html?status=PENDING', 'https://example.com/helpdesk/src/config.js', 'https://example.com/helpdesk'],
    ['https://example.com/nested/project/', 'https://example.com/nested/project/src/config.js', 'https://example.com/nested/project'],
  ];
  for (const [page, moduleUrl, expected] of scenarios) {
    const actual = resolveApiBaseUrl({ location: new URL(page), moduleUrl });
    assert.equal(actual, expected);
    assert.equal(new URL(`${actual}/api/auth/login`).pathname, `${new URL(expected).pathname.replace(/\/$/, '')}/api/auth/login`);
  }
}

test('分開的本機服務、根目錄及子路徑部署使用正確 API 基底', apiOrigins);
