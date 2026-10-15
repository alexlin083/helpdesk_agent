import test from 'node:test';
import assert from 'node:assert/strict';
import { authService } from '../src/services/authService.js';

/**
 * 以瀏覽器介面替身執行實際頁面腳本，驗證未登入導頁、錯誤提示與登入後導向。
 * 此測試不驗證瀏覽器版面或實際 HTTP，不會呼叫 Gemini。
 * @param {import('node:test').TestContext} context 測試清理工具。
 * @returns {Promise<void>}
 */
async function pageFlow(context) {
  const original = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, sessionStorage: globalThis.sessionStorage };
  const store = new Map();
  const redirects = [];
  const fields = { username: { value: 'unknown' }, password: { value: 'test-only-password' } };
  const error = { textContent: '' };
  const pageEvents = new Map();
  let submit;
  /** 恢復全域瀏覽器替身。@returns {void} */
  function cleanup() { Object.assign(globalThis, original); }
  context.after(cleanup);
  /** 模擬輸入焦點。@returns {void} */
  function focus() {}
  fields.password.focus = focus;
  const button = { disabled: false };
  const form = {
    /** 取得登入按鈕。@returns {object} 按鈕。 */
    querySelector() { return button; },
    elements: {
      /** 取得表單輸入。@param {string} name 欄位名稱。@returns {object} 輸入節點。 */
      namedItem(name) { return fields[name]; },
    },
    /** 保存表單提交處理器。@param {string} type 事件名。@param {Function} handler 處理器。@returns {void} */
    addEventListener(type, handler) { submit = handler; },
  };
  globalThis.sessionStorage = {
    /** 讀取模擬儲存值。@param {string} key 鍵。@returns {string|null} 值。 */
    getItem(key) { return store.get(key) ?? null; },
    /** 保存模擬儲存值。@param {string} key 鍵。@param {string} value 值。@returns {void} */
    setItem(key, value) { store.set(key, value); },
    /** 清除模擬儲存值。@param {string} key 鍵。@returns {void} */
    removeItem(key) { store.delete(key); },
  };
  globalThis.window = {
    location: {
      /** 記錄導向的相對網址。@param {string} path 路徑。@returns {void} */
      replace(path) { redirects.push(path); },
    },
    /** 記錄頁面事件。@param {string} type 事件名。@param {Function} handler 處理器。@returns {void} */
    addEventListener(type, handler) { pageEvents.set(type, handler); },
  };
  globalThis.document = {
    body: { hidden: true },
    /** 提供登入元件節點。@param {string} selector 選擇器。@returns {object} 表單或錯誤節點。 */
    querySelector(selector) { return selector === '#login-form' ? form : error; },
  };
  /** 模擬後端登入結果。@param {string} url 網址。@param {object} options 設定。@returns {Promise<Response>} 回應。 */
  async function loginFetch(url, options) {
    const { username, password } = JSON.parse(options.body);
    if (username !== 'admin2') return Response.json({ error: { message: '查無使用者' } }, { status: 401 });
    if (password !== 'test-only-password') return Response.json({ error: { message: '密碼錯誤' } }, { status: 401 });
    return Response.json({ user: { username, userID: 'user-admin2' }, token: 'test-token', expiresAt: Date.now() + 60000 });
  }
  globalThis.fetch = loginFetch;
  await import('../src/app.js');
  assert.equal(redirects.pop(), './index.html');
  const chatPageShow = pageEvents.get('pageshow');
  await import('../src/login.js');
  /** 模擬阻止表單原生送出。@returns {void} */
  function preventDefault() {}
  await submit({ preventDefault });
  assert.equal(error.textContent, '查無使用者');
  assert.equal(authService.getCurrentUser(), null);
  fields.username.value = 'admin2';
  fields.password.value = 'wrong';
  await submit({ preventDefault });
  assert.equal(error.textContent, '密碼錯誤');
  fields.password.value = 'test-only-password';
  await submit({ preventDefault });
  assert.equal(redirects.pop(), './chat.html');
  assert.equal(fields.password.value, '');
  assert.deepEqual(authService.getCurrentUser(), { username: 'admin2', userID: 'user-admin2' });
  authService.logout();
  chatPageShow();
  assert.equal(redirects.pop(), './index.html');
  assert.equal(document.body.hidden, true);
}
test('登入頁提示、成功導向與聊天頁未登入保護', pageFlow);
