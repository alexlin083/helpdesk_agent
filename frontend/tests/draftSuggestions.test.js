import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createFakeWindow, buildDraftDialogDom } from './helpers/fakeDom.js';
import { createDraftDialog, DRAFT_TEXT } from '../src/components/propose/draftDialog.js';
import { normalizeDraftResponse } from '../src/services/draftService.js';
import { leaveResponse, tick, deferred } from './helpers/draftFixtures.js';

/**
 * 組出兩個建議選項（後端 JSON 形狀）：第一個會填請假期間，第二個只有文字
 * @returns {object[]} 建議選項
 */
function twoSuggestions() {
  return [
    { id: 's1', label: '12/1（二）整天', updates: [{ key: 'start_at', value: '2026-12-01T09:00' }, { key: 'end_at', value: '2026-12-01T18:00' }] },
    { id: 's2', label: '其他日期', updates: [] },
  ];
}

/**
 * 建立助理對話區與後端替身；替身的回應經過真實的 normalizeDraftResponse；dialog.begin 送出第一句話「我要請假」
 * @param {Function} responder (input, index) => 後端 JSON
 * @returns {object} doc、nodes、calls、dialog
 */
function mount(responder) {
  const doc = createFakeDocument();
  globalThis.document = doc;
  const win = createFakeWindow();
  const { draftNodes: nodes } = buildDraftDialogDom(doc, doc.body);
  const calls = [];
  /** 後端替身 @param {object} input 請求 @returns {Promise<object>} 整理後的回應 */
  async function requestDraft(input) {
    calls.push(structuredClone(input));
    return normalizeDraftResponse(await responder(input, calls.length - 1));
  }
  const dialog = createDraftDialog(nodes, { user: { username: 'tina.test' }, requestDraft,
    getContent: /** 內容 @returns {string} 內容 */ () => '', onApply: /** 不用 @returns {void} */ () => {}, onLoginRequired: /** 不用 @returns {void} */ () => {}, win, debounceMs: 0 });
  return { doc, nodes, calls, dialog: { ...dialog, begin: /** 送出第一句話 @returns {Promise<boolean>} 結果 */ () => dialog.start('我要請假') } };
}

/** 等計時器與請求都完成 @param {object} dialog 對話框 @returns {Promise<void>} 完成 */
async function flush(dialog) {
  for (let round = 0; round < 4; round += 1) {
    await tick();
    await dialog.settled();
  }
}

/** 送出一則訊息 @param {object} nodes 節點 @param {string} text 訊息 @returns {Promise<void>} 完成 */
function say(nodes, text) {
  nodes.message.value = text;
  return nodes.chatForm.dispatch('submit');
}

/** 對話區的建議選項按鈕 @param {object} nodes 節點 @returns {object[]} 按鈕 */
const chipsOf = (nodes) => nodes.log.querySelectorAll('.draft-suggestion');
/** 按鈕文字 @param {object} button 按鈕 @returns {string} 文字 */
const textOf = (button) => button.textContent;

test('整理建議選項：最多 3 個、沒有 id 或文字的略過、文字截到 20 字、欄位只留面板上的；舊版後端沒有這個欄位時是空陣列', () => {
  const many = [...twoSuggestions(), { id: 's3', label: '一二三四五六七八九十一二三四五六七八九十多出來', updates: [{ key: 'nope', value: 'x' }, { key: 'note', value: 3 }] },
    { id: 's4', label: '第四個' }, { label: '沒有 id' }];
  const result = normalizeDraftResponse(leaveResponse({ suggestions: [{ id: 'x', label: '   ' }, ...many] }));
  assert.deepEqual(result.suggestions.map(/** 取 id @param {{id: string}} item 選項 @returns {string} id */ (item) => item.id), ['s1', 's2', 's3']);
  assert.equal(Array.from(result.suggestions[2].label).length, 20);
  assert.deepEqual(result.suggestions[2].updates, [], '面板沒有的欄位與不是字串的值都不留');
  assert.deepEqual(result.suggestions[0].updates, twoSuggestions()[0].updates);
  assert.deepEqual(normalizeDraftResponse(leaveResponse()).suggestions, []);
});

test('建議選項按鈕：列在回覆下方；點了把欄位填進面板（不鎖定），再把選項文字當成回覆送給 AI；點過的標示已選、其他停用；新的回覆另列一組', async () => {
  /** 後端替身 @param {object} input 請求 @returns {object} 後端 JSON */
  function responder(input) {
    if (!input.state) return leaveResponse();
    if (input.message === '12/1（二）整天') return leaveResponse({ values: { applicant: 'tina.test', ...input.state.fields }, reply: '好的，假別要選哪一種？', suggestions: [{ id: 's1', label: '特休', updates: [{ key: 'leave_type', value: '特休' }] }] });
    return leaveResponse({ reply: '想請哪一天？', suggestions: twoSuggestions() });
  }
  const { doc, nodes, calls, dialog } = mount(responder);
  await dialog.begin();
  await say(nodes, '下週想請一天');
  await flush(dialog);
  const group = nodes.log.querySelector('.draft-suggestions');
  assert.deepEqual([group.getAttribute('role'), group.getAttribute('aria-label')], ['group', DRAFT_TEXT.suggestions.group], '整組有名稱');
  const chips = chipsOf(nodes);
  assert.deepEqual(chips.map(textOf), ['12/1（二）整天', '其他日期']);
  assert.deepEqual(calls[1].state.fields, { leave_type: '', start_at: '', end_at: '', agent: '', note: '' }, '列出選項時還沒填欄位');

  await chips[0].click();
  await flush(dialog);
  const asked = calls[2];
  assert.equal(asked.message, '12/1（二）整天', '選項文字就是使用者這次的回覆');
  assert.deepEqual(asked.history.at(-1), { role: 'assistant', text: '想請哪一天？' }, '帶的是點之前的對話');
  assert.equal(calls.length, 3, '沒有另外送驗證');
  assert.deepEqual([asked.state.fields.start_at, asked.state.fields.end_at], ['2026-12-01T09:00', '2026-12-01T18:00']);
  assert.deepEqual(asked.state.locked, [], '選項填的欄位不鎖定，使用者之後在對話裡要改，AI 還能改');
  assert.equal(dialog.state.controls.get('start_at').control.value, '2026-12-01T09:00', '右側欄位顯示選項填的值');
  assert.ok(chips[0].classList.contains('is-chosen'));
  assert.deepEqual(chips.map(/** 是否停用 @param {object} chip 按鈕 @returns {boolean} 停用時 true */ (chip) => chip.disabled), [true, true], '點了一個之後這組都停用');
  assert.equal(doc.activeElement, dialog.state.controls.get('start_at').control, '焦點移到第一個被填入的欄位');
  const userBubbles = nodes.log.querySelectorAll('.draft-bubble-user').map(/** 取文字 @param {object} bubble 泡泡 @returns {string} 文字 */ (bubble) => bubble.querySelector('.draft-bubble-text').textContent);
  assert.equal(userBubbles.at(-1), '12/1（二）整天', '對話區照樣出現使用者這則回覆');
  const fresh = chipsOf(nodes).slice(2);
  assert.deepEqual(fresh.map(textOf), ['特休'], 'AI 接著問時帶新的選項');
  assert.equal(fresh[0].disabled, false);
});

test('只有文字的選項：不動欄位，只把文字送給 AI，焦點回到輸入框；下一則回覆沒有選項時，沒點的舊按鈕停用', async () => {
  /** 後端替身 @param {object} input 請求 @returns {object} 後端 JSON */
  function responder(input) {
    if (!input.state) return leaveResponse();
    if (input.message === '其他日期') return leaveResponse({ reply: '好的，請告訴我想請的日期' });
    return leaveResponse({ reply: '想請哪一天？', suggestions: twoSuggestions() });
  }
  const { doc, nodes, calls, dialog } = mount(responder);
  await dialog.begin();
  await say(nodes, '下週想請一天');
  await flush(dialog);
  await chipsOf(nodes)[1].click();
  await flush(dialog);
  assert.equal(calls[2].message, '其他日期');
  assert.deepEqual(calls[2].state.locked, [], '沒有欄位被鎖定');
  assert.equal(doc.activeElement, nodes.message, '焦點回到訊息輸入框');

  await say(nodes, '下週想請一天');
  await flush(dialog);
  const third = chipsOf(nodes).slice(2);
  assert.equal(third.length, 2);
  await say(nodes, '其他日期');
  await flush(dialog);
  assert.deepEqual(third.map(/** 是否停用 @param {object} chip 按鈕 @returns {boolean} 停用時 true */ (chip) => chip.disabled), [true, true], '有新的回覆時沒點的選項停用');
});

test('方案與建議選項同時出現：選了方案，建議選項一起停用；點了選項，方案也一起停用（AI 還沒回覆前就停用）', async () => {
  const proposal = { id: 'p1', title: '週二請一天', summary: '', reasons: [], basis: [], basis_labels: [], updates: [{ key: 'leave_type', value: '特休' }], valid: false, problems: [] };
  const pending = [];
  /** 後端替身：第一則對話直接回方案與選項，之後的回覆等測試放行 @param {object} input 請求 @param {number} index 第幾次呼叫 @returns {object|Promise<object>} 後端 JSON */
  function responder(input, index) {
    if (!input.state) return leaveResponse();
    const body = leaveResponse({ reply: '整理了方案', proposals: [proposal], suggestions: twoSuggestions() });
    if (index <= 1) return body;
    const gate = deferred();
    pending.push(() => gate.resolve(body));
    return gate.promise;
  }
  const { nodes, dialog } = mount(responder);
  await dialog.begin();
  await say(nodes, '下週想請一天');
  await flush(dialog);
  /** 是否停用 @param {object} chip 按鈕 @returns {boolean} 停用時 true */
  const disabled = (chip) => chip.disabled;
  const picking = nodes.log.querySelector('.draft-proposal-choose').click();
  await tick();
  assert.deepEqual(chipsOf(nodes).map(disabled), [true, true], '選了方案，AI 還沒回覆前建議選項就停用');
  pending.shift()();
  await picking;
  await flush(dialog);
  const cards = nodes.log.querySelectorAll('.draft-proposal-choose');
  assert.equal(cards.at(-1).disabled, false, 'AI 回覆後列出新的方案');
  const clicking = chipsOf(nodes).at(-1).click();
  await tick();
  assert.equal(cards.at(-1).disabled, true, '點了選項，AI 還沒回覆前方案就停用');
  pending.shift()();
  await clicking;
  await flush(dialog);
});
