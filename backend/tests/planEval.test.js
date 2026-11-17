import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestEnv, TEST_ENV } from './helpers/testEnv.js';

setupTestEnv();
const { env } = await import('../src/config/env.js');
const { getRequestTypes } = await import('../src/services/requestTypes/registry.js');
const { demoUsernames, expectAssistant, formatPlanReport, loadPlanCases, parsePlanCases, runPlanEval, signatureOf, stubCalendar, summarizePlanEval } = await import('../scripts/lib/planEval.js');

const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const CASES_FILE = fileURLToPath(new URL('../evals/plan-cases.json', import.meta.url));
const types = getRequestTypes();
const services = { types, usernames: demoUsernames() };

/**
 * 組出一份最小的題庫（後端 JSON 形狀）
 * @param {object} [overrides={}] 覆寫頂層
 * @param {object} [caseOverrides={}] 覆寫第一題
 * @returns {object} 題庫
 */
function rawPlan(overrides = {}, caseOverrides = {}) {
  return { version: 1, description: '測試', type_id: 'leave', today: '2026-11-02', compare: [{ key: 'leave_type' }, { key: 'start_at', part: 'date' }],
    cases: [{ id: 'one', username: 'emily.wu', subject: '請假', message: '下週二請特休', calendar: { status: 'ACTIVE', level: 'basic' }, ...caseOverrides }], ...overrides };
}

test('題庫格式：版本、類型、今天、比較欄位、帳號、行事曆、額度與預期都要正確，錯誤時指出位置', () => {
  const plan = parsePlanCases(rawPlan(), services);
  assert.deepEqual([plan.typeId, plan.today, plan.cases[0].calendar.busy, plan.cases[0].expect], ['leave', '2026-11-02', [], null]);
  const cases = [
    [rawPlan({ version: 2 }), /version 必須是 1/],
    [rawPlan({ type_id: 'nope' }), /type_id/],
    [rawPlan({ today: '2026/11/02' }), /today/],
    [rawPlan({ compare: [{ key: 'nope' }] }), /compare\[0\]/],
    [rawPlan({}, { id: 'Bad Id' }), /cases\[0\]\.id/],
    [rawPlan({}, { username: 'someone.else' }), /cases\[0\]\.username/],
    [rawPlan({}, { username: 'alex.admin' }), /cases\[0\]\.username/, '管理員不是一般帳號'],
    [rawPlan({}, { message: '' }), /cases\[0\]\.message/],
    [rawPlan({}, { calendar: { status: 'ACTIVE' } }), /cases\[0\]\.calendar\.level/],
    [rawPlan({}, { calendar: { status: 'WHATEVER' } }), /cases\[0\]\.calendar\.status/],
    [rawPlan({}, { calendar: { status: 'ACTIVE', level: 'basic', busy: [{ start: '2026-11-10T10:00:00+08:00', end: '2026-11-10T09:00:00+08:00' }] } }), /calendar\.busy\[0\]/],
    [rawPlan({}, { calendar: { status: 'ACTIVE', level: 'advanced', events: [{ start: '2026-11-10T09:00:00+08:00', end: '2026-11-10T10:00:00+08:00' }] } }), /calendar\.events\[0\]\.title/],
    [rawPlan({}, { entitlements: { 特休: -1 } }), /cases\[0\]\.entitlements/],
    [rawPlan({}, { expect: { updates: [{ key: 'applicant', value: 'x' }], valid: true } }), /expect\.updates\[0\]/, 'self 欄位不能預期'],
    [rawPlan({}, { expect: { updates: [{ key: 'leave_type', value: '特休' }] } }), /expect\.valid/],
  ];
  for (const [raw, pattern, message] of cases) assert.throws(() => parsePlanCases(raw, services), pattern, message);
  assert.throws(() => parsePlanCases({ ...rawPlan(), cases: [rawPlan().cases[0], rawPlan().cases[0]] }, services), /cases\[1\]\.id/, 'id 不重複');
  assert.throws(() => loadPlanCases(join(tmpdir(), 'no-such-plan-cases.json'), services), { code: 'CASES_INVALID' });
});

test('替身行事曆：依連接狀態與權限等級列工具，只回和期間重疊的時段；沒開放的工具回錯誤', async () => {
  const busy = [{ start: '2026-11-09T09:00:00+08:00', end: '2026-11-09T12:00:00+08:00' }, { start: '2026-11-20T09:00:00+08:00', end: '2026-11-20T10:00:00+08:00' }];
  const basic = stubCalendar({ status: 'ACTIVE', level: 'basic', busy, events: [] });
  assert.deepEqual(await basic.listAvailable(), ['calendar_busy']);
  const range = { start: '2026-11-09T00:00:00+08:00', end: '2026-11-10T00:00:00+08:00' };
  assert.deepEqual((await basic.call('emily.wu', 'calendar_busy', range)).result.busy, [busy[0]]);
  assert.match((await basic.call('emily.wu', 'calendar_events', range)).error, /權限不包含/);
  assert.deepEqual(await stubCalendar({ status: 'NOT_CONNECTED', level: null, busy: [], events: [] }).listAvailable(), []);
  assert.match((await stubCalendar({ status: 'NEEDS_RECONNECT', level: null, busy: [], events: [] }).call('emily.wu', 'calendar_busy', range)).error, /重新連接/);
  assert.equal(basic.calls.length, 2);
});

test('正式題庫：離線模式（題庫預期當方案）每題的能不能送都和後端驗證一致；每題用記憶體資料庫，不碰正式資料庫', async () => {
  const plan = loadPlanCases(CASES_FILE, services);
  assert.equal(plan.cases.length, 10);
  assert.match(JSON.parse(readFileSync(CASES_FILE, 'utf8')).description, /^初版，由佳妤確認與增修/);
  const results = await runPlanEval(plan, { providers: [{ name: 'offline', assistantFor: expectAssistant }], types, config: env, concurrency: 3 });
  const summary = summarizePlanEval(plan, results, ['offline']);
  assert.deepEqual(summary.expectMismatches, [], '題庫預期與後端規則一致');
  assert.equal(summary.providers.offline.answered, 10);
  assert.equal(summary.providers.offline.matchedExpect, 10);
  const byId = Object.fromEntries(summary.cases.map(/** 索引 @param {{id: string}} item 題目 @returns {[string, object]} [id, 題目] */ (item) => [item.id, item]));
  assert.deepEqual(byId['balance-short'].providers.offline.proposals[0].problems, ['假別剩餘時數不足'], '題目覆寫的額度只影響那一題');
  assert.equal(byId['notice-short'].providers.offline.proposals[0].valid, true, '提早提出只是建議：明天請事假可以送');
  assert.equal(byId['plain-day'].providers.offline.proposals[0].valid, true, '其他題目照示範額度');
  assert.deepEqual(byId['vague-goal'].providers.offline.proposals, []);
});

test('兩家比較：用後端規則判定能不能送、比較建議的假別與日期、找出誤用沒連接的工具；報告與 JSON 都列出差異', async () => {
  const plan = loadPlanCases(CASES_FILE, services);
  /**
   * 第二家的替身：大多照題庫預期；basic-half-day 呼叫沒開放的 calendar_events 並改提隔天；vague-goal 不先問就給了能送的方案
   * @param {object} item 題目
   * @returns {object} 助手
   */
  const other = (item) => {
    if (item.id === 'vague-goal') return expectAssistant({ expect: { updates: [{ key: 'leave_type', value: '特休' }, { key: 'start_at', value: '2026-11-10T09:00' }, { key: 'end_at', value: '2026-11-10T18:00' }, { key: 'agent', value: 'frank.liu' }] } });
    if (item.id !== 'basic-half-day') return expectAssistant(item);
    return {
      /** 不走分類 @returns {never} @throws {Error} 意外呼叫 */
      classify() { throw new Error('x'); },
      /** 呼叫沒開放的工具後提出隔天 @param {object} request 請求 @returns {Promise<object>} 結果 */
      async fill(request) {
        const output = await request.runTool('calendar_events', { start_at: '2026-11-09T09:00', end_at: '2026-11-09T18:00' });
        return { intent: '', typeId: 'leave', departmentId: null, confidence: 0, updates: [], handlerId: null, reply: null, model: 'fake', toolsUsed: ['calendar_events'], toolsSucceeded: output.error ? [] : ['calendar_events'],
          proposals: [{ title: '隔天', summary: '', reasons: [], basis: ['calendar_events'], updates: [{ key: 'leave_type', value: '特休' }, { key: 'start_at', value: '2026-11-10T09:00' }, { key: 'end_at', value: '2026-11-10T12:00' }, { key: 'agent', value: 'frank.liu' }] }] };
      },
    };
  };
  let clock = 0;
  const results = await runPlanEval(plan, { providers: [{ name: 'gemini', assistantFor: expectAssistant }, { name: 'anthropic', assistantFor: other }], types, config: env, concurrency: 1,
    now: /** 每次加 1.5 秒 @returns {number} 毫秒 */ () => { clock += 1500; return clock; } });
  const summary = summarizePlanEval(plan, results, ['gemini', 'anthropic']);
  assert.deepEqual(summary.agreement, { compared: 10, same: 8 });
  assert.equal(summary.providers.anthropic.misuse, 1);
  assert.equal(summary.providers.gemini.misuse, 0);
  assert.equal(summary.providers.anthropic.matchedExpect, 8);
  const vague = summary.cases.find(/** 找題目 @param {{id: string}} item 題目 @returns {boolean} 是時 true */ (item) => item.id === 'vague-goal');
  assert.deepEqual([vague.providers.gemini.matchesExpect, vague.providers.anthropic.matchesExpect], [true, false], '預期不該直接提出方案時，給了能送的方案就和預期不同');
  assert.equal(summary.providers.gemini.averageMs, 1500);
  const half = summary.cases.find(/** 找題目 @param {{id: string}} item 題目 @returns {boolean} 是時 true */ (item) => item.id === 'basic-half-day');
  assert.equal(half.sameSuggestions, false);
  assert.deepEqual(half.providers.anthropic.misuse, ['calendar_events']);
  assert.deepEqual(half.providers.anthropic.proposals.map(/** 比較字串 @param {{signature: string}} item 方案 @returns {string} 文字 */ (item) => item.signature), ['leave_type=特休|start_at=2026-11-10']);
  const report = formatPlanReport(summary, { mode: 'ai', models: { gemini: 'g-model', anthropic: 'a-model' }, cases: 10, repeat: 1, today: plan.today });
  assert.match(report, /gemini\/g-model 對 anthropic\/a-model/);
  assert.match(report, /兩家建議相同（比較欄位）：8／10 題/);
  assert.match(report, /誤用 calendar_events/);
  assert.match(report, /資料只有示範名冊與替身行事曆/);
  assert.equal(signatureOf([{ key: 'start_at', value: '2026-11-10T09:00' }], [{ key: 'start_at', part: 'date' }, { key: 'leave_type', part: null }]), 'start_at=2026-11-10|leave_type=');
});

test('離線模式：題庫預期能不能送和後端驗證不一致時列出那一題與原因', async () => {
  const wrong = { updates: [{ key: 'leave_type', value: '特休' }, { key: 'start_at', value: '2026-11-03T09:00' }, { key: 'end_at', value: '2026-11-03T18:00' }, { key: 'agent', value: 'frank.liu' }], valid: true };
  const plan = parsePlanCases(rawPlan({}, { id: 'wrong-expect', entitlements: { 特休: 240 }, expect: wrong }), services);
  const results = await runPlanEval(plan, { providers: [{ name: 'offline', assistantFor: expectAssistant }], types, config: env });
  const summary = summarizePlanEval(plan, results, ['offline']);
  assert.deepEqual(summary.expectMismatches, [{ caseId: 'wrong-expect', expected: true, actual: false, problems: ['假別剩餘時數不足'] }]);
  assert.match(formatPlanReport(summary, { mode: 'offline', models: {}, cases: 1, repeat: 1, today: plan.today }), /題庫預期能不能送和後端驗證不一致/);
  const edge = { updates: [{ key: 'leave_type', value: '事假' }, { key: 'start_at', value: '2026-11-03T09:00' }, { key: 'end_at', value: '2026-11-03T18:00' }, { key: 'agent', value: 'frank.liu' }], valid: true };
  const edgePlan = parsePlanCases(rawPlan({}, { id: 'just-enough', expect: edge }), services);
  const edgeSummary = summarizePlanEval(edgePlan, await runPlanEval(edgePlan, { providers: [{ name: 'offline', assistantFor: expectAssistant }], types, config: env }), ['offline']);
  assert.deepEqual(edgeSummary.expectMismatches, [], '題庫的今天（11/2 週一）當現在時間：提早提出只是建議，隔天 11/3 請事假也可以送');
});

test('開頭連續失敗時停止：最先完成的 3 件都失敗就不再開始新的，其餘記為 SKIPPED', async () => {
  const plan = loadPlanCases(CASES_FILE, services);
  const broken = { /** 不走分類 @returns {never} @throws {Error} 意外呼叫 */ classify() { throw new Error('x'); }, /** 一律失敗 @returns {Promise<never>} @throws {Error} 金鑰錯誤 */ async fill() { throw Object.assign(new Error('金鑰錯誤'), { code: 'BAD_KEY' }); } };
  const results = await runPlanEval(plan, { providers: [{ name: 'gemini', assistantFor: /** 壞掉的助手 @returns {object} 助手 */ () => broken }], types, config: env, concurrency: 1 });
  assert.equal(results.filter(/** 失敗 @param {{ok: boolean, error: object}} item 結果 @returns {boolean} 是時 true */ (item) => !item.ok && item.error.reason !== 'SKIPPED').length, 3);
  assert.equal(results.filter(/** 略過 @param {{error: object|null}} item 結果 @returns {boolean} 是時 true */ (item) => item.error?.reason === 'SKIPPED').length, 7);
});

/**
 * 以子程序執行評測腳本（測試用的環境參數、不帶任何 AI 金鑰）
 * @param {string[]} args 參數
 * @param {object} [extra={}] 另外的環境參數
 * @returns {{status: number, stdout: string, stderr: string}} 結果
 */
function runScript(args, extra = {}) {
  return spawnSync(process.execPath, ['scripts/eval-plan.js', ...args], { cwd: BACKEND, env: { ...process.env, ...TEST_ENV, ...extra }, encoding: 'utf8', timeout: 120000 });
}

test('命令列：離線模式輸出 JSON 與結果檔（已存在就不覆蓋）；就算環境指向資料庫檔也不建立；參數錯誤與沒有金鑰時結束碼 2', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'helpdesk-plan-eval-'));
  try {
    const databaseFile = join(scratch, 'should-not-exist.db');
    const out = join(scratch, 'plan-result.json');
    const first = runScript(['--offline', '--json', '--out', out], { DATABASE_FILE: databaseFile });
    assert.equal(first.status, 0, first.stderr);
    const json = JSON.parse(first.stdout);
    assert.deepEqual([json.meta.mode, json.meta.cases, json.meta.data], ['offline', 10, '示範名冊與替身行事曆']);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).meta, json.meta, '結果檔和畫面輸出相同');
    assert.equal(existsSync(databaseFile), false, '評測一律用記憶體資料庫');
    const again = runScript(['--offline', '--out', out]);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /已存在，不覆蓋/);
    const bad = runScript(['--provider', 'other']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--provider 只接受 gemini 或 anthropic/);
    const noKey = runScript([]);
    assert.equal(noKey.status, 2);
    assert.match(noKey.stderr, /沒有設定 GEMINI_API_KEY、ANTHROPIC_API_KEY/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
