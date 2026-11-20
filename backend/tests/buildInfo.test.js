import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBuildInfo } from '../src/config/buildInfo.js';

/**
 * 驗證部署版本資訊：deploy/hd build 寫入的 tag、commit、branch 原樣保留（去除前後空白）；
 * 未設定、空字串或格式不符（含空白、引號、HTML、非十六進位的 commit）時一律為 null，避免任意文字進入日誌與管理頁。
 * @returns {void}
 */
function buildInfoParsing() {
  const commit = '5379ed0a1b2c3d4e5f60718293a4b5c6d7e8f901';
  assert.deepEqual(loadBuildInfo({ HELPDESK_VERSION: ' main-2026.11.20.1 ', HELPDESK_COMMIT: commit, HELPDESK_BRANCH: 'feature/cicd' }),
    { tag: 'main-2026.11.20.1', commit, branch: 'feature/cicd' });
  assert.deepEqual(loadBuildInfo({}), { tag: null, commit: null, branch: null }, '本機開發沒有版本資訊');
  assert.deepEqual(loadBuildInfo({ HELPDESK_VERSION: '', HELPDESK_COMMIT: '', HELPDESK_BRANCH: '' }), { tag: null, commit: null, branch: null }, 'Dockerfile 未傳入時是空字串');
  for (const tag of ['main 2026', '<script>', 'main-"1"', '-leading-dash']) assert.equal(loadBuildInfo({ HELPDESK_VERSION: tag }).tag, null, tag);
  for (const value of ['xyz1234', '5379ed', 'G379ed0']) assert.equal(loadBuildInfo({ HELPDESK_COMMIT: value }).commit, null, value);
  assert.ok(Object.isFrozen(loadBuildInfo({})));
}
test('部署版本資訊的讀取與格式檢查', buildInfoParsing);
