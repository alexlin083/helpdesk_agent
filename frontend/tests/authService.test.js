import test from 'node:test';
import assert from 'node:assert/strict';
const originalFetch = globalThis.fetch;

/** 模擬後端帳密驗證。@param {string} url 網址。@param {object} options 請求。@returns {Promise<Response>} 登入結果。 */
async function loginFetch(url, options) {
  const { username, password } = JSON.parse(options.body);
  if (!/^admin(?:[1-9]|10)$/.test(username)) return Response.json({ error: { message: '查無使用者' } }, { status: 401 });
  if (password !== 'test-only-password') return Response.json({ error: { message: '密碼錯誤' } }, { status: 401 });
  return Response.json({ user: { username, userID: `user-${username}` }, token: 'signed-test-token', expiresAt: Date.now() + 60000 });
}
/** 安裝登入端點替身。@returns {void} */
function setupFetch() { globalThis.fetch = loginFetch; }
/** 還原網路函式。@returns {void} */
function restoreFetch() { globalThis.fetch = originalFetch; }
test.beforeEach(setupFetch);
test.afterEach(restoreFetch);

import { createAuthService, isKnownUserID } from '../src/services/authService.js';

/**
 * 建立隔離的記憶體儲存體，供登入測試使用，不需要瀏覽器或真實帳號服務。
 * @returns {object} 具有 Storage 介面與供測試檢查的 Map。
 */
function memoryStorage() {
  const data = new Map();
  return {
    data,
    /** 讀取儲存值。@param {string} key 名稱。@returns {string|null} 儲存值。 */
    getItem(key) { return data.get(key) ?? null; },
    /** 保存字串。@param {string} key 名稱。@param {string} value 值。@returns {void} */
    setItem(key, value) { data.set(key, value); },
    /** 刪除儲存值。@param {string} key 名稱。@returns {void} */
    removeItem(key) { data.delete(key); },
  };
}

/**
 * 驗證十個帳號登入後有唯一且固定的 userID，重新建立服務仍能還原身分，不保存密碼。
 * @returns {void}
 */
async function validAccounts() {
  const ids = new Set();
  for (let index = 1; index <= 10; index += 1) {
    const storage = memoryStorage();
    const auth = createAuthService({ storage });
    const expected = { username: `admin${index}`, userID: `user-admin${index}` };
    assert.deepEqual(await auth.login(`admin${index}`, 'test-only-password'), expected);
    assert.deepEqual(createAuthService({ storage }).getCurrentUser(), expected);
    assert.ok(isKnownUserID(expected.userID));
    assert.ok(!JSON.stringify([...storage.data.values()]).includes('test-only-password'));
    ids.add(expected.userID);
    auth.logout();
    assert.equal(auth.getCurrentUser(), null);
  }
  assert.equal(ids.size, 10);
}
test('十組帳號的登入、固定身分、工作階段還原與登出', validAccounts);

/**
 * 驗證未知帳號（含原型屬性名稱）一律顯示指定提示，已知帳號的密碼必須完全正確。
 * @returns {void}
 */
async function invalidCredentials() {
  const auth = createAuthService({ storage: memoryStorage() });
  for (const name of ['admin', 'admin0', 'admin11', 'Admin1', 'constructor', '__proto__', '']) {
    /** 嘗試不存在的帳號。@returns {object} 成功身分。@throws {Error} 查無使用者。 */
    function unknownLogin() { return auth.login(name, 'test-only-password'); }
    await assert.rejects(unknownLogin, { message: '查無使用者' });
    assert.equal(auth.getCurrentUser(), null);
  }
  for (const password of ['wrong', '', 'test-only-password ']) {
    /** 嘗試不正確密碼。@returns {object} 成功身分。@throws {Error} 密碼錯誤。 */
    function wrongPassword() { return auth.login('admin1', password); }
    await assert.rejects(wrongPassword, { message: '密碼錯誤' });
  }
  assert.equal((await auth.login(' admin1 ', 'test-only-password')).userID, 'user-admin1');
}
test('其他帳號顯示查無使用者，密碼錯誤不建立登入', invalidCredentials);

/**
 * 驗證不存在、損壞或帳號與 ID 不一致的工作階段無法還原為有效身分。
 * @returns {void}
 */
async function invalidSessions() {
  const storage = memoryStorage();
  const auth = createAuthService({ storage });
  assert.equal(auth.getCurrentUser(), null);
  await auth.login('admin1', 'test-only-password');
  const key = [...storage.data.keys()][0];
  for (const value of ['bad-json', 'null', '{}', '{"username":"admin1","userID":"user-admin2"}', '{"username":"admin6","userID":"user-admin6"}']) {
    storage.setItem(key, value);
    assert.equal(auth.getCurrentUser(), null);
  }
}
test('拒絕損壞與不一致的前端登入資料', invalidSessions);
