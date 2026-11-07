import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePath } from '../scripts/dev-server.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 驗證開發伺服器的路徑解析：一般檔案對應到 frontend 目錄內、去掉查詢字串、目錄補 index.html、可解碼中文；
 * 網址中的 ../ 會先被正規化而留在 frontend 目錄內；編碼過的 ..%2f 跑出 frontend 目錄時拒絕（null），無法解碼的網址也拒絕。
 * @returns {void}
 */
function paths() {
  assert.equal(resolvePath('/pages/propose/propose.css?v=2'), join(ROOT, 'pages', 'propose', 'propose.css'));
  assert.equal(resolvePath('/'), join(ROOT, 'index.html'));
  assert.equal(resolvePath('/pages/'), join(ROOT, 'pages', 'index.html'));
  assert.equal(resolvePath('/%E4%B8%AD.txt'), join(ROOT, '中.txt'));
  assert.equal(resolvePath('/../backend/.env'), join(ROOT, 'backend', '.env'), '網址的 ../ 先被正規化，仍留在 frontend 目錄內');
  for (const url of ['/..%2f..%2fbackend/.env', '/pages/..%2f..%2f..%2fbackend/.env']) assert.equal(resolvePath(url), null, url);
  assert.equal(resolvePath('/%E0%A4%A'), null, '無法解碼');
}
test('開發伺服器只提供 frontend 目錄內的檔案', paths);
