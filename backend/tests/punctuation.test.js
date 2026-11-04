import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/testEnv.js';

setupTestEnv();
const { removeFullStops } = await import('../src/utils/punctuation.js');
const { buildClassification, buildFill } = await import('../src/services/requestTypes/aiAssistant.js');
const { buildTicketDecision } = await import('../src/services/ai/ticketJudge.js');
const { createDepartmentService } = await import('../src/services/departmentService.js');

/**
 * 驗證共用標點規範：句中的「。」改成「；」、句尾與標點、收尾引號前的「。」刪除，其他文字不變。
 * @returns {void}
 */
function fullStops() {
  const cases = [
    ['申請開通 Claude Code 使用權限，因工作需要。希望於 2026-11-05 前完成開通。', '申請開通 Claude Code 使用權限，因工作需要；希望於 2026-11-05 前完成開通'],
    ['沒有句號', '沒有句號'],
    ['連續句號。。接著', '連續句號；接著'],
    ['第一行。\n第二行。', '第一行\n第二行'],
    ['他說「好。」然後離開。', '他說「好」然後離開'],
    ['真的嗎？。接著', '真的嗎？接著'],
    ['句號後有空白。 下一句', '句號後有空白； 下一句'],
    ['。開頭', '開頭'],
    ['English. Keep it.', 'English. Keep it.'],
  ];
  for (const [input, expected] of cases) assert.equal(removeFullStops(input), expected, input);
}
test('共用標點規範不使用「。」', fullStops);

/**
 * 驗證 Gemini 與 Claude 共用的輸出整理：reply、intent 與欄位值都套用標點規範，處理後再截斷。
 * @returns {void}
 */
function assistantOutput() {
  const lists = { typeIds: ['general'], departmentIds: ['dept-it-3'], keys: ['description'] };
  const classified = buildClassification({ intent: 'AI 權限申請。', type_id: 'general', department_id: 'dept-it-3', confidence_score: 90, reply: '您好。請補充用途。' }, lists);
  assert.equal(classified.reply, '您好；請補充用途');
  assert.equal(classified.intent, 'AI 權限申請');
  const filled = buildFill({ intent: '', type_id: 'general', department_id: 'dept-it-3', confidence_score: 90, handler_id: null, reply: '已更新。',
    updates: [{ key: 'description', value: ' 申請開通 Claude Code。希望於 2026-11-05 前完成開通。 ' }] }, lists);
  assert.deepEqual(filled.updates, [{ key: 'description', value: '申請開通 Claude Code；希望於 2026-11-05 前完成開通' }]);
  assert.equal(filled.reply, '已更新');
}
test('自動生成的 AI 輸出套用共用標點規範', assistantOutput);

/**
 * 驗證 AI 判斷部門的依據文字同樣套用共用標點規範。
 * @returns {void}
 */
function judgeBasis() {
  const departments = createDepartmentService();
  const decision = buildTicketDecision({ department_id: 'dept-it-2', confidence_score: 90, basis: '提到 ERP 報表。屬於資訊管理二部業務。' }, departments);
  assert.equal(decision.basis, '提到 ERP 報表；屬於資訊管理二部業務');
}
test('AI 判斷部門的依據套用共用標點規範', judgeBasis);
