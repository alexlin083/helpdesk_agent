import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setupTestEnv } from './helpers/testEnv.js';

setupTestEnv();

const { getRequestTypes } = await import('../src/services/requestTypes/registry.js');
const { departmentService } = await import('../src/services/departmentService.js');
const { classificationRequest } = await import('../src/services/requestTypes/draftEngine.js');
const { parseCases, loadCases, keywordResults, runClassification, scoreResults, formatReport } = await import('../scripts/lib/classificationEval.js');

const CASES_FILE = fileURLToPath(new URL('../evals/classification-cases.json', import.meta.url));
const types = getRequestTypes();
const services = { types, departments: departmentService };

/**
 * 驗證實際題庫：可通過格式檢查；每種需求類型至少 8 題；固定部門的類型預期部門即為固定部門；
 * 一般需求的題目都有指定部門，且涵蓋所有部門；至少 10 題標了 boundary（邊界題）。
 * @returns {void}
 */
function realCases() {
  const cases = loadCases(CASES_FILE, services);
  for (const id of types.ids()) {
    assert.ok(cases.filter(/** 該類型的題目。@param {{type: string}} item 題目。@returns {boolean} 相符時 true。 */ (item) => item.type === id).length >= 8, `${id} 至少 8 題`);
  }
  const vpnCase = cases.find(/** 找 VPN 申請題。@param {{type: string}} item 題目。@returns {boolean} 相符時 true。 */ (item) => item.type === 'vpn');
  assert.equal(vpnCase.department, 'dept-it-1', '固定部門的類型預期部門即為固定部門');
  const generalDepartments = new Set(cases.filter(/** 一般需求題。@param {{type: string}} item 題目。@returns {boolean} 一般需求時 true。 */ (item) => item.type === 'general')
    .map(/** 取部門。@param {{department: string}} item 題目。@returns {string} 部門。 */ (item) => item.department));
  for (const { id } of departmentService.list()) {
    if (id !== 'dept-pur-1') assert.ok(generalDepartments.has(id), `一般需求題涵蓋 ${id}`);
  }
  assert.ok(cases.filter(/** 邊界題。@param {{boundary: string|null}} item 題目。@returns {boolean} 有 boundary 時 true。 */ (item) => item.boundary).length >= 10);
}
test('實際評測題庫通過格式檢查並涵蓋所有類型', realCases);

/**
 * 驗證題庫格式錯誤時拋出 CASES_INVALID，訊息指出位置：版本、未知類型、一般需求缺部門、固定部門類型另指定部門、
 * 主題重複、boundary 與 type 相同；也驗證無法解析的檔案。
 * @returns {void}
 */
function invalidCases() {
  /** 斷言解析失敗。@param {unknown} raw 題庫。@param {RegExp} pattern 訊息。@returns {void} */
  const rejects = (raw, pattern) => assert.throws(() => parseCases(raw, services), (error) => error.code === 'CASES_INVALID' && pattern.test(error.message));
  rejects({ version: 2, cases: [] }, /version 必須是 1/);
  rejects({ version: 1, cases: [] }, /cases 必須是至少一題/);
  rejects({ version: 1, cases: [{ subject: '測試', type: 'nope' }] }, /cases\[0\]\.type 找不到需求類型「nope」/);
  rejects({ version: 1, cases: [{ subject: '測試', type: 'general' }] }, /cases\[0\]\.department 類型 general 由對話決定部門/);
  rejects({ version: 1, cases: [{ subject: '測試', type: 'vpn', department: 'dept-hr-1' }] }, /cases\[0\]\.department 類型 vpn 固定送達 dept-it-1/);
  rejects({ version: 1, cases: [{ subject: '測試', type: 'leave' }, { subject: ' 測試 ', type: 'leave' }] }, /cases\[1\]\.subject 與前面的題目重複/);
  rejects({ version: 1, cases: [{ subject: '測試', type: 'leave', boundary: 'leave' }] }, /cases\[0\]\.boundary/);
  rejects({ version: 1, cases: [{ subject: 'x'.repeat(101), type: 'leave' }] }, /cases\[0\]\.subject 必須是 1～100 字/);
  assert.throws(() => loadCases(fileURLToPath(new URL('./missing-cases.json', import.meta.url)), services), { code: 'CASES_INVALID' });
}
test('評測題庫格式錯誤時指出位置', invalidCases);

/**
 * 驗證評測使用的分類請求就是自動生成第一回合送出的內容：系統指示含目錄的共通指示、允許的類型與部門 id 為全部清單、
 * context 帶主題、預設類型、全部類型摘要與部門名錄，提問者只帶帳號與部門。
 * @returns {void}
 */
function sharedRequest() {
  const user = { username: 'eval.user', department: { id: 'dept-legal-1', name: '法務部' }, role: 'USER' };
  const request = classificationRequest({ types, departments: departmentService, user, subject: '螢幕壞了', today: { date: '2026-11-02', weekday: '週一' } });
  assert.ok(request.instructions.startsWith(types.catalog.assistant.instructions[0]));
  assert.deepEqual(request.lists, { typeIds: types.ids(), departmentIds: departmentService.list().map(/** 取 id。@param {{id: string}} item 部門。@returns {string} id。 */ (item) => item.id) });
  assert.deepEqual(Object.keys(request.context), ['today', 'user', 'subject', 'default_type', 'types', 'departments']);
  assert.deepEqual(request.context.user, { username: 'eval.user', department: { id: 'dept-legal-1', name: '法務部' } });
  assert.equal(request.context.types.length, types.ids().length);
}
test('評測與自動生成共用同一份分類請求', sharedRequest);

/**
 * 驗證逐題執行：限流（RATE_LIMIT_EXCEEDED）時依 retryAfter 等待後重試並成功；重試用盡記錄 error；
 * 不可重試的失敗（AI_INVALID_RESPONSE）不重試；同時執行的題數不超過 concurrency；結果與題目同順序；每完成一題回報進度。
 * @returns {Promise<void>}
 */
async function runnerRetries() {
  const cases = parseCases({ version: 1, cases: [
    { subject: '限流一次', type: 'leave' }, { subject: '一直限流', type: 'leave' }, { subject: '格式異常', type: 'leave' }, { subject: '正常', type: 'repair' },
  ] }, services);
  const calls = new Map();
  const waits = [];
  const progress = [];
  let running = 0;
  let peak = 0;
  /**
   * 分類替身：依主題決定成功或失敗，並記錄同時執行數。
   * @param {{subject: string}} request 請求（只帶主題）。
   * @returns {Promise<object>} 分類結果。
   * @throws {Error} 帶 draftReason 的錯誤。
   */
  async function classify({ subject }) {
    running += 1;
    peak = Math.max(peak, running);
    calls.set(subject, (calls.get(subject) ?? 0) + 1);
    await new Promise(/** 讓出執行權。@param {Function} resolve 完成。@returns {void} */ (resolve) => { setImmediate(resolve); });
    running -= 1;
    if (subject === '限流一次' && calls.get(subject) === 1) throw Object.assign(new Error('busy'), { draftReason: 'RATE_LIMIT_EXCEEDED', retryAfter: 10 });
    if (subject === '一直限流') throw Object.assign(new Error('busy'), { draftReason: 'RATE_LIMIT_EXCEEDED', retryAfter: 10 });
    if (subject === '格式異常') throw Object.assign(new Error('bad'), { draftReason: 'AI_INVALID_RESPONSE' });
    return { typeId: subject === '正常' ? 'repair' : 'leave', departmentId: null, confidence: 90 };
  }
  const results = await runClassification(cases, {
    buildRequest: /** 只帶主題。@param {string} subject 主題。@returns {object} 請求。 */ (subject) => ({ subject }),
    classify, concurrency: 2, retries: 2,
    sleep: /** 記錄等待時間。@param {number} ms 毫秒。@returns {Promise<void>} 立即完成。 */ async (ms) => { waits.push(ms); },
    onProgress: /** 記錄進度。@param {number} done 已完成。@param {number} total 總數。@returns {void} */ (done, total) => { progress.push(`${done}/${total}`); },
  });
  assert.deepEqual(results.map(/** 取主題。@param {object} item 結果。@returns {string} 主題。 */ (item) => item.case.subject), ['限流一次', '一直限流', '格式異常', '正常']);
  assert.deepEqual([results[0].prediction.typeId, results[0].attempts], ['leave', 2]);
  assert.deepEqual([results[1].error.reason, results[1].attempts], ['RATE_LIMIT_EXCEEDED', 3]);
  assert.deepEqual([results[2].error.reason, results[2].attempts], ['AI_INVALID_RESPONSE', 1]);
  assert.equal(calls.get('格式異常'), 1, '不可重試的失敗只呼叫一次');
  assert.deepEqual(waits.sort(/** 數字排序。@param {number} a 值。@param {number} b 值。@returns {number} 排序值。 */ (a, b) => a - b), [10000, 10000, 20000], '等待時間依 retryAfter 與重試次數遞增');
  assert.ok(peak <= 2, '同時執行不超過 concurrency');
  assert.deepEqual(progress, ['1/4', '2/4', '3/4', '4/4']);
}
test('逐題執行時重試可恢復的失敗並限制同時執行數', runnerRetries);

/**
 * 驗證開頭連續失敗時提早停止：每題都回上游錯誤（模擬模型名稱錯誤的 404）時，最先完成的 3 題失敗後不再開始新題目，
 * 其餘題目記錄為 SKIPPED（attempts 0），分類函式只被呼叫 3 次；abortAfter 為 0 時全部題目都會執行。
 * @returns {Promise<void>}
 */
async function abortWhenAllFail() {
  const cases = parseCases({ version: 1, cases: ['一', '二', '三', '四', '五', '六'].map(/** 建立題目。@param {string} subject 主題。@returns {object} 題目。 */ (subject) => ({ subject, type: 'leave' })) }, services);
  let calls = 0;
  /** 一律失敗的分類替身。@returns {Promise<never>} 一律拒絕。 */
  const classify = async () => { calls += 1; throw Object.assign(new Error('upstream'), { draftReason: 'AI_UPSTREAM_ERROR' }); };
  /** 只帶主題。@param {string} subject 主題。@returns {object} 請求。 */
  const buildRequest = (subject) => ({ subject });
  const results = await runClassification(cases, { buildRequest, classify, concurrency: 1, retries: 0 });
  assert.equal(calls, 3);
  assert.deepEqual(results.map(/** 取原因。@param {object} item 結果。@returns {string} 原因。 */ (item) => item.error.reason), ['AI_UPSTREAM_ERROR', 'AI_UPSTREAM_ERROR', 'AI_UPSTREAM_ERROR', 'SKIPPED', 'SKIPPED', 'SKIPPED']);
  assert.equal(results[5].attempts, 0);
  calls = 0;
  await runClassification(cases, { buildRequest, classify, concurrency: 2, retries: 0, abortAfter: 0 });
  assert.equal(calls, 6, 'abortAfter 為 0 時不停止');
}
test('開頭連續失敗時停止評測，不再逐題等待重試', abortWhenAllFail);

/**
 * 驗證計分規則：
 * - 類型正確才算答對，失敗另計不算答錯；
 * - 固定部門的類型一律採用固定部門（即使 AI 給了別的部門）；
 * - 一般需求信心分數低於 min_confidence 時部門未決定（不算答對，計入 pendingDepartment），達到時採用 AI 的部門；
 * - 召回率、精確率、混淆排序、邊界題與多輪不一致；文字報告列出這些項目。
 * @returns {void}
 */
function scoring() {
  const cases = parseCases({ version: 1, cases: [
    { subject: '螢幕壞了', type: 'repair', boundary: 'equipment' },
    { subject: 'VPN 連不上', type: 'general', department: 'dept-it-1', boundary: 'vpn' },
    { subject: 'Outlook 收不到信', type: 'general', department: 'dept-it-1' },
    { subject: '想申請螢幕', type: 'equipment' },
  ] }, services);
  const [broken, vpnDown, mail, monitor] = cases;
  const results = [
    { case: broken, prediction: { typeId: 'repair', departmentId: 'dept-it-1', confidence: 40 }, error: null, attempts: 1 },
    { case: vpnDown, prediction: { typeId: 'vpn', departmentId: 'dept-it-1', confidence: 95 }, error: null, attempts: 1 },
    { case: mail, prediction: { typeId: 'general', departmentId: 'dept-it-1', confidence: 60 }, error: null, attempts: 1 },
    { case: monitor, prediction: null, error: { reason: 'AI_TIMEOUT', message: 'timeout' }, attempts: 3 },
    { case: broken, prediction: { typeId: 'equipment', departmentId: null, confidence: 80 }, error: null, attempts: 1 },
    { case: mail, prediction: { typeId: 'general', departmentId: 'dept-it-1', confidence: 75 }, error: null, attempts: 1 },
  ];
  const score = scoreResults(results, types);
  assert.deepEqual([score.total, score.answered, score.errors, score.typeCorrect], [6, 5, 1, 3]);
  assert.equal(score.typeAccuracy, 3 / 5);
  assert.equal(score.departmentCorrect, 4, '報修採用固定部門 dept-ga-1（忽略 AI 的 dept-it-1）；判斷錯成 VPN 申請或設備申請時，固定部門碰巧與預期相同；信心 75 的一般需求採用 AI 部門');
  assert.equal(score.pendingDepartment, 1, '信心 60 低於 75，部門未決定');
  assert.deepEqual(score.perType.repair, { expected: 2, correct: 1, predicted: 1, recall: 0.5, precision: 1 });
  assert.deepEqual(score.perType.general, { expected: 3, correct: 2, predicted: 2, recall: 2 / 3, precision: 1 });
  assert.equal(score.perType.equipment.recall, null, '題目都失敗時沒有分母');
  assert.deepEqual(score.confusions, [{ expected: 'general', actual: 'vpn', count: 1 }, { expected: 'repair', actual: 'equipment', count: 1 }]);
  assert.deepEqual(score.boundary, { total: 3, correct: 1, accuracy: 1 / 3 });
  assert.deepEqual(score.unstable, [{ subject: '螢幕壞了', types: ['repair', 'equipment'] }]);
  assert.equal(score.failures.length, 4, '類型錯 2 題、部門未決定 1 題、失敗 1 題');
  const report = formatReport(score, { mode: 'ai', model: 'test-model', cases: 4, repeat: 1 }, types);
  for (const text of ['類型準確度：60.0%（3/5）', '部門準確度：80.0%（4/5；類型正確但信心不足、要由使用者選部門：1）', '一般需求（general） → VPN 申請（vpn）：1 次',
    '「螢幕壞了」：報修（repair）、設備申請（equipment）', '「想申請螢幕」：呼叫失敗（AI_TIMEOUT）', '「Outlook 收不到信」：類型正確（general），部門 dept-it-1 → 未決定（信心 60）']) {
    assert.ok(report.includes(text), `報告包含：${text}`);
  }
}
test('計分依正式畫面的部門採用規則計算準確度與混淆', scoring);

/**
 * 驗證關鍵字備援模式：每題以 types.match 判斷，沒有信心分數；固定部門的類型部門正確、一般需求部門未決定；報告不顯示信心分數。
 * @returns {void}
 */
function keywordMode() {
  const cases = parseCases({ version: 1, cases: [
    { subject: '螢幕壞了', type: 'repair' }, { subject: 'Outlook 收不到信', type: 'general', department: 'dept-it-1' },
  ] }, services);
  const score = scoreResults(keywordResults(cases, types), types);
  assert.deepEqual([score.typeCorrect, score.departmentCorrect, score.pendingDepartment], [2, 1, 1]);
  const report = formatReport(score, { mode: 'keywords', cases: 2, repeat: 1 }, types);
  assert.ok(report.startsWith('分類評測：關鍵字備援（不呼叫 AI），2 題 × 1 輪'));
  assert.ok(report.includes('「Outlook 收不到信」：類型正確（general），部門 dept-it-1 → 未決定') && !report.includes('（信心'));
}
test('關鍵字備援模式的評測', keywordMode);
