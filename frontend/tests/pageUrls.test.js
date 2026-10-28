import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createPageUrls } from '../src/pageUrls.js';

/** 驗證根站點與 GitHub Pages repo 子路徑都保留正確的站點根目錄及頁面資料夾。@returns {void} */
function hostedPaths() {
  const local = createPageUrls('http://localhost:5173/src/pageUrls.js');
  assert.equal(local.login, 'http://localhost:5173/index.html');
  assert.equal(local.admin, 'http://localhost:5173/admin/admin.html');
  assert.equal(local.tickets, 'http://localhost:5173/tickets/tickets.html');
  const pages = createPageUrls('https://example.github.io/classroom/helpdesk_agent/src/pageUrls.js');
  assert.deepEqual(pages, {
    login: 'https://example.github.io/classroom/helpdesk_agent/index.html',
    propose: 'https://example.github.io/classroom/helpdesk_agent/propose.html',
    tickets: 'https://example.github.io/classroom/helpdesk_agent/tickets/tickets.html',
    admin: 'https://example.github.io/classroom/helpdesk_agent/admin/admin.html',
  });
}
test('頁面網址支援本機與多層託管子路徑', hostedPaths);

/** 驗證搬移後 HTML 的本機樣式、腳本與導覽連結都指向存在的檔案。@returns {void} */
function htmlResources() {
  for (const path of ['index.html', 'propose.html', 'admin/admin.html', 'tickets/tickets.html']) {
    const url = new URL(`../${path}`, import.meta.url);
    const html = readFileSync(url, 'utf8');
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const value = match[1];
      if (value.startsWith('#') || /^(?:https?:|data:|mailto:)/.test(value)) continue;
      assert.ok(existsSync(new URL(value, url)), `${path} 引用不存在的檔案 ${value}`);
    }
  }
}
test('搬移後頁面的 CSS、腳本與靜態導覽路徑有效', htmlResources);
