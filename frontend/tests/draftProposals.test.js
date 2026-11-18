import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createFakeWindow, buildDraftDialogDom } from './helpers/fakeDom.js';
import { createDraftDialog, DRAFT_TEXT } from '../src/components/propose/draftDialog.js';
import { normalizeDraftResponse } from '../src/services/draftService.js';
import { normalizeStoredTicket, TicketServiceError } from '../src/services/ticketService.js';
import { describeHistory } from '../src/utils/ticketFormatters.js';
import { leaveResponse, tick, deferred, HR } from './helpers/draftFixtures.js';

const CONNECTIONS_URL = 'https://example.test/helpdesk/pages/connections/connections.html';

/**
 * 組出兩個方案（後端 JSON 形狀）：第一個可以送，第二個缺欄位
 * @returns {object[]} 方案
 */
function twoProposals() {
  return [
    { id: 'p1', title: '週二請一天', summary: '整天', reasons: ['當天沒有行程', '額度足夠'], basis: ['calendar_busy'], basis_labels: ['行事曆忙碌時段'],
      updates: [{ key: 'leave_type', value: '特休' }, { key: 'start_at', value: '2026-12-01T09:00' }, { key: 'end_at', value: '2026-12-01T18:00' }], valid: true, problems: [] },
    { id: 'p2', title: '只填假別', summary: '', reasons: [], basis: [], basis_labels: [], updates: [{ key: 'leave_type', value: '事假' }], valid: false,
      problems: [{ key: 'start_at', message: '缺少「請假起始時間」' }, { key: 'agent', message: '缺少「代理人」' }] },
  ];
}

/**
 * 建立助理對話區與後端替身；替身的回應經過真實的 normalizeDraftResponse；dialog.begin 送出第一句話「我要請假」
 * @param {Function} responder (input, index) => 後端 JSON
 * @returns {object} nodes、calls、dialog
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
    getContent: /** 內容 @returns {string} 內容 */ () => '', onApply: /** 不用 @returns {void} */ () => {}, onLoginRequired: /** 不用 @returns {void} */ () => {}, win, debounceMs: 0, connectionsUrl: CONNECTIONS_URL });
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

/** 對話區的方案卡片 @param {object} nodes 節點 @returns {object[]} 卡片 */
const cardsOf = (nodes) => nodes.log.querySelectorAll('.draft-proposal');
/** 卡片的按鈕 @param {object} card 卡片 @returns {object} 按鈕 */
const buttonOf = (card) => card.querySelector('.draft-proposal-choose');
/** 系統提示的文字 @param {object} nodes 節點 @returns {string[]} 文字 */
const systemTexts = (nodes) => nodes.log.querySelectorAll('.draft-bubble-system').map(/** 取文字 @param {object} bubble 泡泡 @returns {string} 文字 */ (bubble) => bubble.querySelector('.draft-bubble-text').textContent);

test('整理方案與連接狀態：方案最多 3 個、欄位只留面板上的、valid 只認 true；連接狀態只留認得的代碼，沒有名稱時用 id', () => {
  const many = [...twoProposals(), { id: 'p3', title: '三', updates: [{ key: 'nope', value: 'x' }, { key: 'note', value: 3 }], valid: 'yes' }, { id: 'p4', title: '四' }, { title: '沒有 id' }];
  const result = normalizeDraftResponse(leaveResponse({ proposals: many, connections: [
    { id: 'google_calendar', name: 'Google 行事曆', status: 'NOT_CONNECTED', tools: [] }, { id: 'other', status: 'NEEDS_RECONNECT' }, { id: 'bad', status: 'WHATEVER' }] }));
  assert.deepEqual(result.proposals.map(/** 取 id @param {{id: string}} item 方案 @returns {string} id */ (item) => item.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(result.proposals[0].basisLabels, ['行事曆忙碌時段']);
  assert.deepEqual(result.proposals[2].updates, [], '面板沒有的欄位與不是字串的值都不留');
  assert.equal(result.proposals[2].valid, false);
  assert.deepEqual(result.connections, [{ id: 'google_calendar', name: 'Google 行事曆', status: 'NOT_CONNECTED', tools: [] }, { id: 'other', name: 'other', status: 'NEEDS_RECONNECT', tools: [] }]);
  assert.deepEqual([normalizeDraftResponse(leaveResponse()).proposals, normalizeDraftResponse(leaveResponse()).connections], [[], []], '舊版後端沒有這兩個欄位時是空陣列');
});

test('方案卡片：列出標題、理由、查過的資料與能不能送；按「用這個方案」才把欄位填進面板並鎖定，再把選擇送給 AI 接著問；有新的方案時舊卡片停用', async () => {
  /** 後端替身 @param {object} input 請求 @returns {object} 後端 JSON */
  function responder(input) {
    if (!input.state) return leaveResponse();
    if (input.message?.startsWith('我選擇方案')) return leaveResponse({ values: { applicant: 'tina.test', ...input.state.fields }, reply: '好的，請問代理人是誰' });
    if (input.message) return leaveResponse({ reply: '整理了兩個方案', proposals: twoProposals() });
    return leaveResponse({ values: { applicant: 'tina.test', ...input.state.fields }, reply: '' });
  }
  const { doc, nodes, calls, dialog } = mount(responder);
  await dialog.begin();
  await say(nodes, '下週二想請一天');
  await flush(dialog);
  const cards = cardsOf(nodes);
  assert.equal(cards.length, 2);
  const group = nodes.log.querySelector('.draft-bubble-proposals');
  assert.deepEqual([group.getAttribute('role'), group.getAttribute('aria-label')], ['group', '有 2 個方案可以選'], '整組有名稱，報讀器不用整段重讀');
  assert.equal(cards[0].querySelector('.draft-proposal-title').textContent, '週二請一天');
  assert.deepEqual(cards[0].querySelectorAll('li').map(/** 取文字 @param {object} item 項目 @returns {string} 文字 */ (item) => item.textContent), ['當天沒有行程', '額度足夠']);
  assert.equal(cards[0].querySelector('.draft-proposal-basis').textContent, `${DRAFT_TEXT.proposals.basis}行事曆忙碌時段`);
  assert.equal(cards[0].querySelector('.draft-proposal-status').textContent, DRAFT_TEXT.proposals.valid);
  assert.equal(cards[1].querySelector('.draft-proposal-status').textContent, `${DRAFT_TEXT.proposals.invalid}缺少「請假起始時間」；缺少「代理人」`);
  assert.equal(buttonOf(cards[0]).getAttribute('aria-label'), `${DRAFT_TEXT.proposals.choose}：週二請一天`);
  assert.equal(calls.length, 2, '列出方案時還沒填欄位，也沒有送驗證');
  assert.deepEqual(calls[1].state.fields, { leave_type: '', start_at: '', end_at: '', agent: '', note: '' });

  await buttonOf(cards[0]).click();
  await flush(dialog);
  const validate = calls[2];
  assert.equal(validate.message, '我選擇方案「週二請一天」', '選方案後把選擇當一則對話送給 AI');
  assert.deepEqual(validate.history.at(-1), { role: 'assistant', text: '整理了兩個方案' }, '帶的是選之前的對話，這則不重複');
  assert.equal(calls.length, 3, '沒有另外送驗證');
  assert.deepEqual(validate.state.fields, { leave_type: '特休', start_at: '2026-12-01T09:00', end_at: '2026-12-01T18:00', agent: '', note: '' });
  assert.deepEqual([...validate.state.locked].sort(), ['end_at', 'leave_type', 'start_at'], '方案填的欄位鎖定，AI 之後不會改寫');
  const shown = ['leave_type', 'start_at', 'end_at'].map(/** 控制項顯示的值 @param {string} key 欄位 @returns {string} 值 */ (key) => dialog.state.controls.get(key).control.value);
  assert.deepEqual(shown, ['特休', '2026-12-01T09:00', '2026-12-01T18:00'], '右側欄位也顯示方案填的值');
  assert.equal(dialog.state.controls.get('start_at').control.classList.contains('is-empty'), false, '期間選擇器不再顯示「選擇開始」');
  assert.equal(buttonOf(cards[0]).textContent, DRAFT_TEXT.proposals.chosen);
  assert.ok(cards[0].classList.contains('is-chosen'));
  assert.equal(buttonOf(cards[1]).disabled, true, '選了一個之後其他方案停用');
  assert.equal(doc.activeElement, dialog.state.controls.get('leave_type').control, '焦點移到第一個被填入的欄位');
  const userBubbles = nodes.log.querySelectorAll('.draft-bubble-user').map(/** 取文字 @param {object} bubble 泡泡 @returns {string} 文字 */ (bubble) => bubble.querySelector('.draft-bubble-text').textContent);
  assert.equal(userBubbles.at(-1), '我選擇方案「週二請一天」');
  assert.equal(nodes.log.querySelectorAll('.draft-bubble-assistant').at(-1).querySelector('.draft-bubble-text').textContent, '好的，請問代理人是誰', 'AI 接著回答');

  await say(nodes, '還有別的嗎');
  await flush(dialog);
  assert.deepEqual(calls[3].history.slice(-2), [{ role: 'user', text: '我選擇方案「週二請一天」' }, { role: 'assistant', text: '好的，請問代理人是誰' }], '選了哪個方案與 AI 的回答都在之後的對話紀錄');
  const fresh = cardsOf(nodes).slice(2);
  assert.equal(fresh.length, 2, '新的方案另列一組');
  assert.equal(buttonOf(fresh[0]).disabled, false);
});

test('方案填到沒有控制項的欄位時不出錯：其他欄位照樣顯示，送給 AI 與焦點照常', async () => {
  /** 後端替身 @param {object} input 請求 @returns {object} 後端 JSON */
  function responder(input) {
    if (!input.state) return leaveResponse();
    if (input.message) return leaveResponse({ reply: '整理了兩個方案', proposals: twoProposals() });
    return leaveResponse({ values: { applicant: 'tina.test', ...input.state.fields }, reply: '' });
  }
  const { doc, nodes, calls, dialog } = mount(responder);
  await dialog.begin();
  await say(nodes, '下週二想請一天');
  await flush(dialog);
  dialog.state.controls.delete('end_at');
  await buttonOf(cardsOf(nodes)[0]).click();
  await flush(dialog);
  assert.equal(calls.at(-1).state.fields.end_at, '2026-12-01T18:00', '沒有控制項的欄位仍記下方案的值並送給 AI');
  assert.deepEqual(['leave_type', 'start_at'].map(/** 控制項顯示的值 @param {string} key 欄位 @returns {string} 值 */ (key) => dialog.state.controls.get(key).control.value), ['特休', '2026-12-01T09:00']);
  assert.equal(doc.activeElement, dialog.state.controls.get('leave_type').control, '焦點照樣移到第一個被填入的欄位');
});

test('AI 整理中時選方案：只記在對話區並驗證，不另外送給 AI；選擇仍留在對話紀錄', async () => {
  const pending = deferred();
  /** 後端替身：「再幫我想想」等測試放行 @param {object} input 請求 @returns {object|Promise<object>} 後端 JSON */
  function responder(input) {
    if (!input.state) return leaveResponse();
    if (input.message === '再幫我想想') return pending.promise;
    if (input.message) return leaveResponse({ reply: '整理了兩個方案', proposals: twoProposals() });
    return leaveResponse({ values: { applicant: 'tina.test', ...input.state.fields }, reply: '' });
  }
  const { nodes, calls, dialog } = mount(responder);
  await dialog.begin();
  await say(nodes, '下週二想請一天');
  await flush(dialog);
  const asking = say(nodes, '再幫我想想');
  await tick();
  assert.equal(nodes.send.disabled, true, 'AI 整理中');
  await buttonOf(cardsOf(nodes)[0]).click();
  await tick();
  assert.equal(calls.some(/** 是選擇的對話 @param {{message?: string}} item 請求 @returns {boolean} 是時 true */ (item) => item.message?.startsWith('我選擇方案')), false, 'AI 整理中不另外送');
  assert.equal(calls.at(-1).message, undefined, '改成只驗證');
  assert.deepEqual([...calls.at(-1).state.locked].sort(), ['end_at', 'leave_type', 'start_at']);
  pending.resolve(leaveResponse({ reply: '還在想' }));
  await asking;
  await flush(dialog);
  assert.ok(dialog.state.history.some(/** 是選擇 @param {{text: string}} turn 對話 @returns {boolean} 是時 true */ (turn) => turn.text === '我選擇方案「週二請一天」'), '選擇記在對話紀錄，之後的對話會帶給 AI');
});

test('選方案送給 AI 時不另外送驗證：等待中的驗證取消，AI 回答前也不再排；剛改的欄位一起帶給 AI', async () => {
  const answer = deferred();
  /** 後端替身：選擇的對話等測試放行 @param {object} input 請求 @returns {object|Promise<object>} 後端 JSON */
  function responder(input) {
    if (!input.state) return leaveResponse();
    if (input.message?.startsWith('我選擇方案')) return answer.promise;
    if (input.message) return leaveResponse({ reply: '整理了兩個方案', proposals: twoProposals() });
    return leaveResponse({ values: { applicant: 'tina.test', ...input.state.fields }, reply: '' });
  }
  const { nodes, calls, dialog } = mount(responder);
  await dialog.begin();
  await say(nodes, '下週二想請一天');
  await flush(dialog);
  const note = dialog.state.controls.get('note').control;
  note.value = '補充';
  await note.dispatch('input');
  const before = calls.length;
  const choosing = buttonOf(cardsOf(nodes)[0]).click();
  await tick();
  await tick();
  assert.deepEqual(calls.slice(before).map(/** 請求種類 @param {{message?: string}} item 請求 @returns {string} 訊息或驗證 */ (item) => item.message ?? '驗證'), ['我選擇方案「週二請一天」'], 'AI 回答前只有這一個請求');
  assert.equal(calls.at(-1).state.fields.note, '補充');
  answer.resolve(leaveResponse({ reply: '好的，請問代理人是誰' }));
  await choosing;
  await flush(dialog);
});

test('選擇送給 AI 失敗時：這則標示未送達、不留在對話紀錄；面板的值保留並重新驗證', async () => {
  /** 後端替身：選擇的對話失敗 @param {object} input 請求 @returns {object} 後端 JSON @throws {TicketServiceError} 選擇的對話 */
  function responder(input) {
    if (!input.state) return leaveResponse();
    if (input.message?.startsWith('我選擇方案')) throw new TicketServiceError('系統暫時忙碌，請稍後再試', { status: 503, code: 'AI_UNAVAILABLE' });
    if (input.message) return leaveResponse({ reply: '整理了兩個方案', proposals: twoProposals() });
    return leaveResponse({ values: { applicant: 'tina.test', ...input.state.fields }, reply: '' });
  }
  const { nodes, calls, dialog } = mount(responder);
  await dialog.begin();
  await say(nodes, '下週二想請一天');
  await flush(dialog);
  await buttonOf(cardsOf(nodes)[0]).click();
  await flush(dialog);
  const chosen = nodes.log.querySelectorAll('.draft-bubble-user').at(-1);
  assert.ok(chosen.classList.contains('is-undelivered'), '標示未送達');
  assert.equal(dialog.state.history.some(/** 是選擇 @param {{text: string}} turn 對話 @returns {boolean} 是時 true */ (turn) => turn.text === '我選擇方案「週二請一天」'), false, '未送達的不留在對話紀錄');
  assert.equal(calls.at(-1).message, undefined, '失敗後重新驗證面板');
  assert.deepEqual(calls.at(-1).state.fields, { leave_type: '特休', start_at: '2026-12-01T09:00', end_at: '2026-12-01T18:00', agent: '', note: '' }, '面板的值保留');
  assert.equal(dialog.state.controls.get('start_at').control.value, '2026-12-01T09:00');
});

test('AI 這次沒有給新方案時，沒選的舊卡片停用並標示「這個方案已過期」', async () => {
  /** 後端替身：第一次聊天給方案，第二次沒有 @param {object} input 請求 @param {number} index 第幾次 @returns {object} 後端 JSON */
  function responder(input, index) { return input.message && index === 1 ? leaveResponse({ reply: '方案', proposals: twoProposals() }) : leaveResponse({ reply: input.message ? '請問代理人是誰' : leaveResponse().reply }); }
  const { nodes, dialog } = mount(responder);
  await dialog.begin();
  await say(nodes, '想請假');
  await flush(dialog);
  await say(nodes, '還沒想好');
  await flush(dialog);
  const [old] = cardsOf(nodes);
  assert.equal(buttonOf(old).disabled, true);
  assert.equal(buttonOf(old).textContent, DRAFT_TEXT.proposals.expired);
});

test('標題與連接器名稱裡的「$&」照原樣顯示，不會被展開', async () => {
  const tricky = [{ ...twoProposals()[0], title: 'A$&B$1' }];
  /** 後端替身 @param {object} input 請求 @returns {object} 後端 JSON */
  function responder(input) {
    return input.message ? leaveResponse({ reply: '方案', proposals: tricky, connections: [{ id: 'x', name: '$&服務', status: 'NOT_CONNECTED', tools: [] }] }) : leaveResponse();
  }
  const { nodes, dialog } = mount(responder);
  await dialog.begin();
  await say(nodes, '想請假');
  await flush(dialog);
  assert.deepEqual(systemTexts(nodes), [DRAFT_TEXT.connections.NOT_CONNECTED.split('{name}').join('$&服務')]);
  await buttonOf(cardsOf(nodes)[0]).click();
  await flush(dialog);
  const userBubbles = nodes.log.querySelectorAll('.draft-bubble-user').map(/** 取文字 @param {object} bubble 泡泡 @returns {string} 文字 */ (bubble) => bubble.querySelector('.draft-bubble-text').textContent);
  assert.equal(userBubbles.at(-1), '我選擇方案「A$&B$1」');
});

test('新的方案出現時，沒選的舊卡片停用並標示「已有新的方案」', async () => {
  /** 後端替身 @param {object} input 請求 @returns {object} 後端 JSON */
  function responder(input) { return input.message ? leaveResponse({ reply: '方案', proposals: twoProposals() }) : leaveResponse(); }
  const { nodes, dialog } = mount(responder);
  await dialog.begin();
  await say(nodes, '想請假');
  await flush(dialog);
  await say(nodes, '換一個');
  await flush(dialog);
  const [old] = cardsOf(nodes);
  assert.equal(buttonOf(old).disabled, true);
  assert.equal(buttonOf(old).textContent, DRAFT_TEXT.proposals.stale);
});

test('連接提示：沒連接或需要重新連接時提示一次並附「連接帳號」頁連結（另開分頁）；同一種狀態不重複，已連接與不能連接不提示', async () => {
  const states = [
    [{ id: 'google_calendar', name: 'Google 行事曆', status: 'NOT_CONNECTED', tools: [] }, { id: 'other', name: '其他服務', status: 'UNAVAILABLE', tools: [] }],
    [{ id: 'google_calendar', name: 'Google 行事曆', status: 'NOT_CONNECTED', tools: [] }],
    [{ id: 'google_calendar', name: 'Google 行事曆', status: 'NEEDS_RECONNECT', tools: [] }],
    [{ id: 'google_calendar', name: 'Google 行事曆', status: 'ACTIVE', tools: ['calendar_busy'] }],
  ];
  /** 後端替身 @param {object} input 請求 @param {number} index 第幾次 @returns {object} 後端 JSON */
  function responder(input, index) { return leaveResponse({ reply: input.message ? '好' : leaveResponse().reply, connections: states[Math.min(index, states.length - 1)] }); }
  const { nodes, dialog } = mount(responder);
  await dialog.begin();
  for (const text of ['一', '二', '三']) {
    await say(nodes, text);
    await flush(dialog);
  }
  assert.deepEqual(systemTexts(nodes), [
    DRAFT_TEXT.connections.NOT_CONNECTED.replace('{name}', 'Google 行事曆'),
    DRAFT_TEXT.connections.NEEDS_RECONNECT.replace('{name}', 'Google 行事曆'),
  ]);
  const links = nodes.log.querySelectorAll('.draft-bubble-link');
  assert.equal(links.length, 2);
  assert.deepEqual([links[0].href, links[0].target, links[0].rel, links[0].textContent], [CONNECTIONS_URL, '_blank', 'noopener', DRAFT_TEXT.connections.link]);
});

test('歷程的模擬通知：保留通知對象與模擬標記，顯示成「通知薪資系統（模擬）」，不顯示記錄者', () => {
  const ticket = normalizeStoredTicket({
    ticket_id: 'TK-N', created_at: '2026-11-01T01:00:00.000Z', subject: '請事假', content: '內容', status: 'APPROVED', route: 'FORM', department_id: HR.id, department_name: HR.name,
    requester: { user_id: 'user-tina.test', username: 'tina.test' },
    history: [{ at: '2026-11-01T01:00:00.000Z', event: 'SUBMITTED', by_username: 'tina.test' }, { at: '2026-11-02T01:00:00.000Z', event: 'APPROVED', by_username: 'hr.test' },
      { at: '2026-11-02T01:00:00.000Z', event: 'NOTIFIED', by_user_id: 'system', by_username: 'system', target: '薪資系統', comment: '已通知薪資系統（模擬）', simulated: true }],
  });
  const notice = ticket.history.at(-1);
  assert.deepEqual([notice.event, notice.target, notice.simulated], ['NOTIFIED', '薪資系統', true]);
  assert.equal(describeHistory(notice), '通知薪資系統（模擬）');
  assert.equal(describeHistory({ event: 'NOTIFIED', target: '', simulated: false }), '通知');
  assert.equal(describeHistory(ticket.history[1]), '簽核・hr.test', '其他事件照舊');
});
