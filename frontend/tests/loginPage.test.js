import { PAGE_URLS } from '../src/pageUrls.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createFakeWindow, buildLoginDom, pageIds, fakeAuth } from './helpers/fakeDom.js';
import { initLoginPage, LOGIN_TEXT } from '../src/login.js';

/**
 * 驗證 index.html 具備登入腳本依賴的所有節點 id。
 * @returns {void}
 */
function pageStructure() {
  const ids = pageIds(new URL('../index.html', import.meta.url));
  for (const id of ['login-form', 'username', 'password', 'password-toggle', 'login-error', 'login-button']) {
    assert.ok(ids.has(id), `index.html 缺少 #${id}`);
  }
}
test('登入頁具備腳本需要的節點', pageStructure);

/**
 * 驗證已登入時直接前往提出需求單頁，包含從快取恢復時的 pageshow。
 * @returns {void}
 */
function alreadyLoggedIn() {
  const doc = createFakeDocument();
  const win = createFakeWindow();
  buildLoginDom(doc);
  initLoginPage(doc, win, fakeAuth({ username: 'racky.huang', userID: 'user-racky.huang', department: { id: 'dept-it-1', name: '資訊管理一部' } }));
  assert.deepEqual(win.redirects, [PAGE_URLS.propose]);
  win.events.get('pageshow')();
  assert.equal(win.redirects.length, 2);
}
test('已登入時直接進入提出需求單頁', alreadyLoggedIn);

/**
 * 驗證必填檢查（只有空白也算空白）、不清空密碼、焦點移到空欄位，且不呼叫登入服務。
 * @returns {Promise<void>}
 */
async function requiredFields() {
  const doc = createFakeDocument();
  const win = createFakeWindow();
  const nodes = buildLoginDom(doc);
  const auth = fakeAuth(null);
  let logins = 0;
  /** 不應被呼叫。@returns {Promise<object>} 身分。 */
  auth.login = async () => { logins += 1; return {}; };
  initLoginPage(doc, win, auth);
  nodes.username.value = '   ';
  nodes.password.value = 'secret';
  await nodes.form.dispatch('submit');
  assert.equal(nodes.error.textContent, LOGIN_TEXT.required);
  assert.equal(nodes.password.value, 'secret');
  assert.equal(doc.activeElement, nodes.username);
  nodes.username.value = 'racky.huang';
  nodes.password.value = ' ';
  await nodes.form.dispatch('submit');
  assert.equal(nodes.error.textContent, LOGIN_TEXT.required);
  assert.equal(nodes.password.value, ' ');
  assert.equal(doc.activeElement, nodes.password);
  assert.equal(logins, 0);
  assert.deepEqual(win.redirects, []);
}
test('帳號與密碼必填檢查不清空密碼', requiredFields);

/**
 * 驗證登入失敗顯示後端訊息並清空密碼、成功後清空密碼並導頁；按鈕在請求期間鎖定後恢復。
 * @returns {Promise<void>}
 */
async function loginFlow() {
  const doc = createFakeDocument();
  const win = createFakeWindow();
  const nodes = buildLoginDom(doc);
  const auth = fakeAuth(null);
  const attempts = [];
  let buttonTextDuring = '';
  /**
   * 模擬後端登入：記錄送出的帳密並依密碼決定成功或失敗。
   * @param {string} username 帳號。
   * @param {string} password 密碼。
   * @returns {Promise<object>} 身分。
   * @throws {Error} 密碼錯誤。
   */
  auth.login = async (username, password) => {
    attempts.push([username, password]);
    buttonTextDuring = nodes.button.textContent;
    if (password !== 'test-only-password') throw new Error('密碼錯誤');
    auth.user = { username, userID: `user-${username}` };
    return auth.user;
  };
  initLoginPage(doc, win, auth);
  nodes.username.value = 'racky.huang';
  nodes.password.value = 'wrong';
  await nodes.form.dispatch('submit');
  assert.equal(buttonTextDuring, LOGIN_TEXT.submitting);
  assert.equal(nodes.error.textContent, '密碼錯誤');
  assert.equal(nodes.password.value, '');
  assert.equal(doc.activeElement, nodes.password);
  assert.equal(nodes.button.disabled, false);
  assert.equal(nodes.button.textContent, LOGIN_TEXT.submit);
  nodes.password.value = 'test-only-password';
  await nodes.form.dispatch('submit');
  assert.deepEqual(attempts, [['racky.huang', 'wrong'], ['racky.huang', 'test-only-password']]);
  assert.equal(nodes.password.value, '');
  assert.equal(nodes.error.textContent, '');
  assert.deepEqual(win.redirects, [PAGE_URLS.propose]);
  /** 模擬連線失敗。@returns {Promise<never>} @throws {Error} 連線失敗提示。 */
  auth.login = async () => { throw new Error('無法連線登入服務，請確認後端已啟動並稍後再試'); };
  auth.user = null;
  nodes.password.value = 'anything';
  await nodes.form.dispatch('submit');
  assert.equal(nodes.error.textContent, '無法連線登入服務，請確認後端已啟動並稍後再試');
  assert.equal(nodes.password.value, '');
}
test('登入失敗與成功後都清空密碼', loginFlow);

/**
 * 驗證密碼顯示切換。
 * @returns {Promise<void>}
 */
async function toggles() {
  const doc = createFakeDocument();
  const win = createFakeWindow();
  const nodes = buildLoginDom(doc);
  initLoginPage(doc, win, fakeAuth(null));
  assert.equal(nodes.password.type, 'password');
  await nodes.toggle.click();
  assert.equal(nodes.password.type, 'text');
  assert.equal(nodes.toggle.textContent, LOGIN_TEXT.hide);
  assert.equal(nodes.toggle.getAttribute('aria-pressed'), 'true');
  await nodes.toggle.click();
  assert.equal(nodes.password.type, 'password');
  assert.equal(nodes.toggle.textContent, LOGIN_TEXT.show);
  assert.equal(nodes.toggle.getAttribute('aria-pressed'), 'false');
}
test('密碼顯示切換', toggles);
