import { PAGE_URLS } from '../src/pageUrls.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createFakeWindow, buildLoginDom, buildProposeDom, fakeAuth, pageIds } from './helpers/fakeDom.js';
import { initAdminPage } from '../src/admin.js';
import { initLoginPage } from '../src/login.js';
import { initAccountMenu } from '../src/components/account.js';
import { resetClassroom, AdminServiceError } from '../src/services/adminService.js';
import { createAuthService } from '../src/services/authService.js';

const user = { username: 'alex.admin', userID: 'user-alex.admin', role: 'ADMIN', department: { id: 'dept-it-1', name: '測試資訊部門' } };

/** 建立管理頁的最小 DOM，與真實 HTML 的 id 相符。@returns {object} 文件、視窗與元素。 */
function setupAdmin() {
  const doc = createFakeDocument();
  const win = createFakeWindow();
  const nodes = {};
  for (const [id, tag] of [['account-name', 'span'], ['account-department', 'span'], ['logout-button', 'button'], ['reset-form', 'form'], ['reset-confirmation', 'input'], ['reset-button', 'button'], ['reset-status', 'p']]) {
    const node = doc.createElement(tag);
    node.setAttribute('id', id);
    doc.body.append(node);
    nodes[id] = node;
  }
  return { doc, win, nodes };
}

/** 驗證管理頁元素、登入後角色導頁、一般頁與管理頁互斥。@returns {Promise<void>} 完成導頁驗證。 */
async function adminNavigation() {
  const ids = pageIds(new URL('../admin/admin.html', import.meta.url));
  for (const id of ['reset-form', 'reset-confirmation', 'reset-button', 'reset-status']) assert.ok(ids.has(id));
  const doc = createFakeDocument();
  const win = createFakeWindow();
  buildLoginDom(doc);
  initLoginPage(doc, win, fakeAuth(user));
  assert.deepEqual(win.redirects, [PAGE_URLS.admin]);
  const normal = createFakeDocument();
  const normalWindow = createFakeWindow();
  buildProposeDom(normal);
  assert.equal(initAccountMenu(normal, normalWindow, fakeAuth(user)).user, null);
  assert.deepEqual(normalWindow.redirects, [PAGE_URLS.admin]);
  const setup = setupAdmin();
  assert.equal(initAdminPage(setup.doc, setup.win, { auth: fakeAuth({ ...user, role: 'USER' }) }), null);
  assert.deepEqual(setup.win.redirects, [PAGE_URLS.propose]);
}
test('管理員登入導頁與頁面權限隔離', adminNavigation);

/** 驗證確認文字、請求期間防重送、成功清除確認欄位，以及 401 登出。@returns {Promise<void>} 完成互動驗證。 */
async function resetInteraction() {
  const { doc, win, nodes } = setupAdmin();
  const auth = fakeAuth(user);
  let finish;
  let calls = 0;
  /** 捕捉重置完成時機。@param {Function} resolve 完成控制。@returns {void} */
  function deferred(resolve) { finish = resolve; }
  const pending = new Promise(deferred);
  /** 模擬後端等待既有工作。@param {string} confirmation 確認文字。@returns {Promise<object>} 重置摘要。 */
  async function reset(confirmation) { assert.equal(confirmation, 'RESET_HELPDESK'); calls += 1; return pending; }
  const page = initAdminPage(doc, win, { auth, resetClassroom: reset });
  assert.equal(nodes['reset-button'].disabled, true);
  nodes['reset-confirmation'].value = 'RESET_HELPDESK';
  page.updateButton();
  assert.equal(nodes['reset-button'].disabled, false);
  const request = nodes['reset-form'].dispatch('submit');
  assert.equal(nodes['reset-button'].disabled, true);
  await nodes['reset-form'].dispatch('submit');
  assert.equal(calls, 1);
  finish({ deletedTickets: 7, resetAt: '2026-10-28T00:00:00Z' });
  await request;
  assert.match(nodes['reset-status'].textContent, /7 筆/);
  assert.equal(nodes['reset-confirmation'].value, '');
  assert.equal(nodes['reset-button'].disabled, true);
  const other = setupAdmin();
  /** 模擬登入失效。@returns {Promise<never>} 拒絕登入。 */
  async function expired() { throw new AdminServiceError('請重新登入', 401); }
  initAdminPage(other.doc, other.win, { auth: fakeAuth(user), resetClassroom: expired });
  other.nodes['reset-confirmation'].value = 'RESET_HELPDESK';
  await other.nodes['reset-form'].dispatch('submit');
  assert.deepEqual(other.win.redirects, [PAGE_URLS.login]);
}
test('確認清除、防重送、重置摘要與登入失效', resetInteraction);

/** 驗證獨立管理 service 送出憑證、錯誤處理，以及登入服務會保存 ADMIN 角色。@returns {Promise<void>} 合約驗證完成。 */
async function adminServiceContract() {
  const original = globalThis.fetch;
  const records = new Map();
  const storage = {
    /** 讀取假儲存。@param {string} key 名稱。@returns {string|null} 值。 */
    getItem(key) { return records.get(key) ?? null; },
    /** 寫入假儲存。@param {string} key 名稱。@param {string} value 值。@returns {void} */
    setItem(key, value) { records.set(key, value); },
    /** 刪除假儲存。@param {string} key 名稱。@returns {void} */
    removeItem(key) { records.delete(key); },
  };
  /** 模擬登入與管理端點，不呼叫真正 API。@param {string} url 網址。@param {object} options 請求。@returns {Promise<Response>} 假回應。 */
  async function request(url, options) {
    if (url.endsWith('/api/auth/login')) return Response.json({ user, token: 'test-token', expiresAt: Date.now() + 60000 });
    assert.ok(url.endsWith('/api/admin/reset'));
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(options.body), { confirmation: 'RESET_HELPDESK' });
    return Response.json({ deletedTickets: 3, resetAt: '2026-10-28T00:00:00Z' });
  }
  try {
    globalThis.fetch = request;
    const auth = createAuthService({ storage });
    assert.equal((await auth.login('alex.admin', 'fake-password')).role, 'ADMIN');
    assert.equal(createAuthService({ storage }).getCurrentUser().role, 'ADMIN');
    assert.equal((await resetClassroom('RESET_HELPDESK', auth)).deletedTickets, 3);
    /** 模擬一般帳號被後端拒絕。@returns {Promise<Response>} 403。 */
    async function forbidden() { return Response.json({ error: { message: '只有管理員' } }, { status: 403 }); }
    globalThis.fetch = forbidden;
    await assert.rejects(resetClassroom('RESET_HELPDESK', auth), { status: 403 });
    /** 模擬無法確認重置結果的網路中斷。@returns {Promise<never>} 網路錯誤。 */
    async function disconnected() { throw new Error('network'); }
    globalThis.fetch = disconnected;
    await assert.rejects(resetClassroom('RESET_HELPDESK', auth), /尚未確認重置結果/);
  } finally { globalThis.fetch = original; }
}
test('管理 service 與管理角色的工作階段保存', adminServiceContract);
