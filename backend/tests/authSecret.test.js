import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestEnv } from './helpers/testEnv.js';

const scratch = mkdtempSync(join(tmpdir(), 'helpdesk-auth-secret-'));
setupTestEnv();

const { env } = await import('../src/config/env.js');
const { createSqliteDataStore } = await import('../src/services/storage/dataStore.js');
const { createAccountService } = await import('../src/services/personnel/accountService.js');
const { createAuthService } = await import('../src/services/authService.js');

/**
 * 以同一個資料庫檔建立「啟動一次」需要的儲存、帳號與登入服務（不設定 AUTH_SECRET，金鑰來自 meta 表）。
 * @param {string} file 資料庫檔路徑。
 * @returns {Promise<{store: object, auth: object}>} 已開啟的儲存與登入服務。
 */
async function boot(file) {
  const store = createSqliteDataStore({ file });
  await store.prepare({ legacyFile: join(scratch, 'none.json') });
  const accounts = createAccountService({ store });
  const auth = createAuthService({ ...env, authSecret: '' }, accounts, {
    localSecret: /** 取本次啟動資料庫中的本機金鑰。@returns {string} 金鑰。 */ () => store.localAuthSecret(),
  });
  return { store, auth };
}

/**
 * 驗證未設定 AUTH_SECRET 時，簽章金鑰保存在 SQLite meta 表：同一個資料庫檔重新啟動後沿用同一把金鑰，先前簽發的憑證仍有效；
 * 換成另一個資料庫檔時金鑰不同，舊憑證驗證失敗（401）。
 * 副作用：在暫存資料夾建立 restart.db 與 other.db，測試結束時關閉。
 * @returns {Promise<void>} 全部斷言通過時完成。
 */
async function localSecretSurvivesRestart() {
  const file = join(scratch, 'restart.db');
  const first = await boot(file);
  const issued = await first.auth.issue(first.auth.credentials('racky.huang', 'test-only-password'));
  const secret = first.store.localAuthSecret();
  assert.match(secret, /^[0-9a-f]{64}$/);
  first.store.close();

  const second = await boot(file);
  assert.equal(second.store.localAuthSecret(), secret, '重新開啟同一個資料庫應沿用同一把金鑰');
  const user = await second.auth.verify(issued.token);
  assert.equal(user.username, 'racky.huang');
  second.store.close();

  const other = await boot(join(scratch, 'other.db'));
  await assert.rejects(other.auth.verify(issued.token), { status: 401 }, '不同資料庫的金鑰不同，憑證不可通用');
  other.store.close();
}

test('本機未設定 AUTH_SECRET：金鑰保存在 SQLite，重新啟動後既有憑證仍有效', localSecretSurvivesRestart);

/**
 * 驗證有設定 AUTH_SECRET 時不呼叫 localSecret（呼叫次數為 0）且能正常簽發與驗證；
 * 未設定且 localSecret 拋出錯誤（模擬資料庫無法使用）時，退回記憶體隨機金鑰，仍能簽發與驗證同一次啟動的憑證。
 * @returns {Promise<void>} 全部斷言通過時完成。
 */
async function configuredSecretSkipsLocal() {
  const store = createSqliteDataStore({ file: ':memory:' });
  await store.prepare({ legacyFile: join(scratch, 'none.json') });
  const accounts = createAccountService({ store });
  let calls = 0;
  const configured = createAuthService({ ...env, authSecret: 'test-only-secret-value-that-is-long-enough' }, accounts, {
    localSecret: /** 記錄呼叫次數。@returns {string} 不應被使用的值。 */ () => { calls += 1; return 'unused'; },
  });
  const user = configured.credentials('racky.huang', 'test-only-password');
  assert.equal((await configured.verify((await configured.issue(user)).token)).username, 'racky.huang');
  assert.equal(calls, 0);

  const fallback = createAuthService({ ...env, authSecret: '' }, accounts, {
    localSecret: /** 模擬資料庫無法使用。@returns {never} 一律拋出。 */ () => { throw new Error('unavailable'); },
  });
  assert.equal((await fallback.verify((await fallback.issue(user)).token)).username, 'racky.huang');
  store.close();
}

test('有設定 AUTH_SECRET 時不讀取本機金鑰；本機金鑰無法取得時退回記憶體隨機金鑰', configuredSecretSkipsLocal);

test.after(/** 刪除本測試建立的暫存資料夾與其中的資料庫檔。@returns {void} */ () => rmSync(scratch, { recursive: true, force: true }));
