import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/testEnv.js';

setupTestEnv();
const { executeTool, summarizeDepartmentQueue, QUEUE_LIST_MAX, TOOL_CAPABILITIES } = await import('../src/services/requestTypes/capabilities.js');
const { getRequestTypes } = await import('../src/services/requestTypes/registry.js');

const types = getRequestTypes();
// 測試的「現在」：2026-11-19 12:00（台北）
const NOW = Date.parse('2026-11-19T04:00:00Z');
const USER = { username: 'one.ga', department: { id: 'dept-ga-1', name: '總務與硬體組' } };

/**
 * 組出一張需求單（只放這個工具會讀的欄位，其餘欄位用假資料）。
 * @param {object} overrides 要覆寫的欄位。
 * @returns {object} 需求單。
 */
function ticket(overrides) {
  return { ticket_id: `TK-${Math.random()}`, subject: '測試主旨', content: '機密內容：不應交給 AI', status: 'PENDING', department_id: 'dept-ga-1', department_name: '總務與硬體組',
    requester: { user_id: 'user-two.it', username: 'two.it', department_id: 'dept-it-1', department_name: '資訊部' }, handler: null, created_at: '2026-11-18T01:00:00.000Z',
    updated_at: '2026-11-18T01:00:00.000Z', history: [], decision: null, ...overrides };
}

test('待辦需求單：只算本人部門、待簽核、不是本人提出的單；由舊到新；標示指定給本人；不含內容、提單人與單號', () => {
  const tickets = [
    ticket({ subject: '3 樓會議室冷氣不冷', form: { id: 'repair', name: '報修', fields: {}, computed: {} }, created_at: '2026-11-13T02:00:00.000Z' }),
    ticket({ subject: '指定給我的單', handler: { id: 'one.ga', name: 'one.ga' }, created_at: '2026-11-17T02:00:00.000Z' }),
    ticket({ subject: '一般需求', request_type: { id: 'general', version: 2 }, created_at: '2026-11-19T03:00:00.000Z' }),
    ticket({ subject: '已簽核', status: 'APPROVED' }),
    ticket({ subject: '已取消', status: 'CANCELLED' }),
    ticket({ subject: '別的部門', department_id: 'dept-it-1' }),
    ticket({ subject: '自己提的單', requester: { user_id: 'user-one.ga', username: 'one.ga', department_id: 'dept-ga-1', department_name: '總務與硬體組' } }),
  ];
  const result = summarizeDepartmentQueue({ tickets, user: USER, registry: types, now: NOW, timezoneOffset: '+08:00' });
  assert.equal(result.department, '總務與硬體組');
  assert.equal(result.total_pending, 3);
  assert.equal(result.assigned_to_me, 1);
  assert.equal(result.oldest_waiting_days, 6);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.tickets, [
    { subject: '3 樓會議室冷氣不冷', type: '報修', submitted_on: '2026-11-13', waiting_days: 6, assigned_to_me: false },
    { subject: '指定給我的單', type: null, submitted_on: '2026-11-17', waiting_days: 2, assigned_to_me: true },
    { subject: '一般需求', type: types.find('general').name, submitted_on: '2026-11-19', waiting_days: 0, assigned_to_me: false },
  ], '一般需求從目錄查類型名稱；直接送單的沒有類型');
  const text = JSON.stringify(result);
  for (const secret of ['機密內容', 'two.it', 'TK-']) assert.ok(!text.includes(secret), `不含 ${secret}`);
  assert.match(result.note, /沒有截止日/);
  assert.match(result.note, /跟日期無關/, '提醒 AI 不要把待辦說成某一天的工作');
});

test('待辦需求單：最多列 20 張但總數照實計算；主旨截到 60 字；沒有待辦時天數為 null', () => {
  const many = Array.from({ length: QUEUE_LIST_MAX + 5 }, /** 建立一張。@param {unknown} _ 未使用。@param {number} index 序號。@returns {object} 需求單。 */ (_, index) => ticket({
    subject: index === 0 ? '長'.repeat(80) : `單 ${index}`, created_at: new Date(Date.parse('2026-11-01T00:00:00Z') + index * 3600000).toISOString() }));
  const result = summarizeDepartmentQueue({ tickets: many, user: USER, registry: types, now: NOW, timezoneOffset: '+08:00' });
  assert.equal(result.total_pending, QUEUE_LIST_MAX + 5);
  assert.equal(result.tickets.length, QUEUE_LIST_MAX);
  assert.equal(result.truncated, true);
  assert.equal(Array.from(result.tickets[0].subject).length, 60);
  const empty = summarizeDepartmentQueue({ tickets: [], user: USER, registry: types, now: NOW, timezoneOffset: '+08:00' });
  assert.deepEqual([empty.total_pending, empty.assigned_to_me, empty.oldest_waiting_days, empty.tickets], [0, 0, null, []]);
});

test('my_pending_tickets 工具：目錄宣告符合能力合約；請假可用；執行時固定查本人部門、忽略模型帶的參數', async () => {
  const tool = types.tool('my_pending_tickets');
  assert.equal(tool.capability, 'department_queue');
  assert.equal(tool.access, 'same_department');
  assert.equal(tool.label, '我的待辦需求單');
  assert.deepEqual(TOOL_CAPABILITIES.department_queue.params, {});
  assert.ok(types.find('leave').ai.tools.includes('my_pending_tickets'));
  const tickets = [ticket({ subject: '本部門' }), ticket({ subject: '別的部門', department_id: 'dept-it-1' })];
  const store = { /** 全部需求單。@returns {Promise<object[]>} 需求單。 */ async all() { return tickets; } };
  const outcome = await executeTool(tool, { department_id: 'dept-it-1', username: 'two.it' }, { user: USER, type: types.find('leave'), registry: types, store, clock: () => NOW });
  assert.equal(outcome.result.total_pending, 1, '模型帶別的部門或帳號也只查本人部門');
  assert.equal(outcome.result.tickets[0].subject, '本部門');
});
