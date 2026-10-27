import test from 'node:test';
import assert from 'node:assert/strict';
const originalFetch = globalThis.fetch;

// 測試用帳號與部門；與後端 data/accounts.json 的實際內容無關。
const ACCOUNTS = ['racky.huang', 'amy.chen', 'brian.lin', 'cindy.wang', 'david.lee', 'emily.wu', 'frank.liu', 'grace.tsai', 'henry.yang', 'ivy.chang'];
const DEPARTMENT = { id: 'dept-it-1', name: '資訊管理一部' };

/** 模擬後端帳密驗證。@param {string} url 網址。@param {object} options 請求。@returns {Promise<Response>} 登入結果。 */
async function loginFetch(url, options) {
  const { username, password } = JSON.parse(options.body);
  if (!ACCOUNTS.includes(username)) return Response.json({ error: { message: '查無使用者' } }, { status: 401 });
  if (password !== 'test-only-password') return Response.json({ error: { message: '密碼錯誤' } }, { status: 401 });
  return Response.json({ user: { username, userID: `user-${username}`, department: DEPARTMENT }, token: 'signed-test-token', expiresAt: Date.now() + 60000 });
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
 * 驗證十個帳號登入後有唯一且固定的 userID 與所屬部門，重新建立服務仍能還原身分，不保存密碼。
 * @returns {void}
 */
async function validAccounts() {
  const ids = new Set();
  for (let index = 1; index <= 10; index += 1) {
    const storage = memoryStorage();
    const auth = createAuthService({ storage });
    const username = ACCOUNTS[index - 1];
    const expected = { username, userID: `user-${username}`, department: DEPARTMENT };
    assert.deepEqual(await auth.login(username, 'test-only-password'), expected);
    assert.deepEqual(createAuthService({ storage }).getCurrentUser(), expected);
    assert.ok(isKnownUserID(expected.userID));
    assert.ok(!JSON.stringify([...storage.data.values()]).includes('test-only-password'));
    ids.add(expected.userID);
    auth.logout();
    assert.equal(auth.getCurrentUser(), null);
  }
  assert.equal(ids.size, 10);
  for (const id of ['user-admin1', 'user-racky', 'user-Racky.Huang', 'racky.huang', 'user-', null]) assert.equal(isKnownUserID(id), false);
}
test('十組帳號的登入、固定身分、所屬部門、工作階段還原與登出', validAccounts);

/**
 * 驗證未知帳號（含原型屬性名稱）一律顯示指定提示，已知帳號的密碼必須完全正確。
 * @returns {void}
 */
async function invalidCredentials() {
  const auth = createAuthService({ storage: memoryStorage() });
  for (const name of ['racky', 'racky.huang.jr', 'Racky.Huang', 'admin1', 'constructor', '__proto__', '']) {
    /** 嘗試不存在的帳號。@returns {object} 成功身分。@throws {Error} 查無使用者。 */
    function unknownLogin() { return auth.login(name, 'test-only-password'); }
    await assert.rejects(unknownLogin, { message: '查無使用者' });
    assert.equal(auth.getCurrentUser(), null);
  }
  for (const password of ['wrong', '', 'test-only-password ']) {
    /** 嘗試不正確密碼。@returns {object} 成功身分。@throws {Error} 密碼錯誤。 */
    function wrongPassword() { return auth.login('racky.huang', password); }
    await assert.rejects(wrongPassword, { message: '密碼錯誤' });
  }
  assert.equal((await auth.login(' racky.huang ', 'test-only-password')).userID, 'user-racky.huang');
}
test('其他帳號顯示查無使用者，密碼錯誤不建立登入', invalidCredentials);

/**
 * 驗證不存在、損壞、帳號與 ID 不一致或缺少部門的工作階段無法還原為有效身分；後端回應缺少部門時視為格式異常。
 * @returns {void}
 */
async function invalidSessions() {
  const storage = memoryStorage();
  const auth = createAuthService({ storage });
  assert.equal(auth.getCurrentUser(), null);
  await auth.login('racky.huang', 'test-only-password');
  const key = [...storage.data.keys()][0];
  const valid = JSON.parse(storage.getItem(key));
  const broken = [
    'bad-json', 'null', '{}',
    JSON.stringify({ ...valid, user: { ...valid.user, userID: 'user-amy.chen' } }),
    JSON.stringify({ ...valid, user: { username: 'emily.wu', userID: 'user-emily.wu' } }),
    JSON.stringify({ ...valid, user: { ...valid.user, department: { id: '', name: '' } } }),
    JSON.stringify({ ...valid, expiresAt: Date.now() - 1 }),
  ];
  for (const value of broken) {
    storage.setItem(key, value);
    assert.equal(auth.getCurrentUser(), null);
  }
  /** 模擬缺少部門的後端回應。@returns {Promise<Response>} 回應。 */
  async function noDepartment() { return Response.json({ user: { username: 'racky.huang', userID: 'user-racky.huang' }, token: 't', expiresAt: Date.now() + 60000 }); }
  globalThis.fetch = noDepartment;
  await assert.rejects(auth.login('racky.huang', 'test-only-password'), { message: '登入服務回應格式異常，請稍後再試' });
}
test('拒絕損壞、不一致或缺少部門的登入資料', invalidSessions);
