import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createFakeWindow, buildDraftDialogDom } from './helpers/fakeDom.js';
import { createDraftDialog, DRAFT_TEXT, describeOverLimit, describeAiUnavailable, normalizeControlValue } from '../src/components/propose/draftDialog.js';
import { normalizeDraftResponse } from '../src/services/draftService.js';
import { TicketServiceError } from '../src/services/ticketService.js';
import { leaveResponse, completeLeaveResponse, generalResponse, equipmentResponse, deferred, tick, GREETING, PROMPT, RENDERED, HR, IT, GA, FILLED_LEAVE_VALUES, LEAVE_SUMMARY } from './helpers/draftFixtures.js';

/**
 * 建立「自動生成」視窗與草稿服務替身。responder 依請求回傳後端 JSON（或 Promise），替身會經過真實的 normalizeDraftResponse 整理。
 * @param {object} [options={}] 設定。
 * @param {Function} [options.responder] (input, callIndex) => 回應 JSON、Promise 或拋出錯誤。
 * @param {string} [options.subject='我要請假'] 頁面主題。
 * @param {string} [options.content=''] 頁面需求內容。
 * @returns {object} doc、win、nodes、page（主題、內容、套用紀錄）、calls（請求紀錄）與 dialog 控制器。
 */
function mount({ responder = defaultResponder, subject = '我要請假', content = '' } = {}) {
  const doc = createFakeDocument();
  globalThis.document = doc;
  const win = createFakeWindow();
  const { draftNodes: nodes } = buildDraftDialogDom(doc, doc.body);
  const trigger = doc.createElement('button');
  doc.body.append(trigger);
  const page = { subject, content, applied: [], logins: 0 };
  const calls = [];
  /**
   * 草稿服務替身：記錄請求的複本並整理回應。
   * @param {object} input 對話框送出的請求。
   * @returns {Promise<object>} 整理後的回應。
   */
  async function requestDraft(input) {
    calls.push(structuredClone(input));
    return normalizeDraftResponse(await responder(input, calls.length - 1));
  }
  /** 取得頁面主題。@returns {string} 主題。 */
  function getSubject() { return page.subject; }
  /** 取得頁面需求內容。@returns {string} 需求內容。 */
  function getContent() { return page.content; }
  /** 記錄套用結果。@param {object} applied 套用結果。@returns {void} */
  function onApply(applied) { page.applied.push(applied); page.content = applied.content; }
  /** 記錄需要重新登入。@returns {void} */
  function onLoginRequired() { page.logins += 1; }
  const dialog = createDraftDialog({ ...nodes, trigger }, { user: { username: 'tina.test' }, requestDraft, getSubject, getContent, onApply, onLoginRequired, win, debounceMs: 0 });
  return { doc, win, nodes, trigger, page, calls, dialog };
}

/**
 * 預設的後端替身：第一次呼叫回問候，之後回目前面板的驗證結果（沿用送出的欄位值）。
 * @param {object} input 請求。
 * @returns {object} 後端 JSON。
 */
function defaultResponder(input) {
  if (!input.state) return leaveResponse();
  return leaveResponse({ values: { applicant: 'tina.test', ...input.state.fields }, reply: input.message ? '收到' : '' });
}

/**
 * 等待驗證計時器與所有進行中的請求完成（多跑幾輪，涵蓋結果觸發的再驗證）。
 * @param {object} dialog 對話框控制器。
 * @returns {Promise<void>}
 */
async function flush(dialog) {
  for (let round = 0; round < 4; round += 1) {
    await tick();
    await dialog.settled();
  }
}

/**
 * 取出對話區每則泡泡的角色類別與文字。
 * @param {object} nodes 對話框節點。
 * @returns {Array<[string, string]>} [角色, 文字]。
 */
function bubbles(nodes) {
  /**
   * 整理一則泡泡。
   * @param {object} bubble 泡泡元素。
   * @returns {[string, string]} 角色與文字。
   */
  function toPair(bubble) { return [bubble.className.split(' ')[1].replace('draft-bubble-', ''), bubble.querySelector('.draft-bubble-text').textContent]; }
  return nodes.log.children.map(toPair);
}

/**
 * 取得欄位的控制項與狀態節點。
 * @param {object} nodes 對話框節點。
 * @param {string} key 欄位代號。
 * @returns {{control: object, status: object, source: object, wrapper: object}} 節點。
 */
function field(nodes, key) {
  const wrapper = nodes.fieldList.children[nodes.fieldList.children.map(dataKeyOf).indexOf(key)];
  return { wrapper, control: wrapper.querySelector(`#draft-field-${key}`), status: wrapper.querySelector('.draft-status'), source: wrapper.querySelector('.draft-source') };
}

/**
 * 修改欄位控制項並觸發 change 事件。
 * @param {object} nodes 對話框節點。
 * @param {string} key 欄位代號。
 * @param {string} value 新值。
 * @returns {Promise<void>}
 */
async function edit(nodes, key, value) {
  const { wrapper, control } = field(nodes, key);
  const group = wrapper.querySelector('.datetime-control');
  if (group) {
    // 日期＋時間欄位：寫入外層群組的組合值，再觸發日期輸入的 change（與使用者選日期相同）
    group.value = value;
    await control.dispatch('change');
    return;
  }
  control.value = value;
  await control.dispatch('change');
}

/**
 * 在對話區輸入訊息並送出。
 * @param {object} nodes 對話框節點。
 * @param {string} text 訊息。
 * @returns {Promise<void>} 送出事件處理完成。
 */
function say(nodes, text) {
  nodes.message.value = text;
  return nodes.chatForm.dispatch('submit');
}

/**
 * 取出節點文字。
 * @param {object} node 元素。
 * @returns {string} 文字。
 */
function textOf(node) { return node.textContent; }
/**
 * 取出欄位外框的 data-key。
 * @param {object} node 欄位外框。
 * @returns {string|null} 欄位代號。
 */
function dataKeyOf(node) { return node.getAttribute('data-key'); }
/**
 * 取出選項是否停用。
 * @param {object} option 下拉選項。
 * @returns {boolean} 是否停用。
 */
function disabledOf(option) { return option.disabled; }
/**
 * 取出對話紀錄的角色。
 * @param {{role: string}} turn 對話紀錄。
 * @returns {string} 角色。
 */
function roleOf(turn) { return turn.role; }
/**
 * 取出陣列第一項。
 * @param {Array<unknown>} pair 陣列。
 * @returns {unknown} 第一項。
 */
function firstOf(pair) { return pair[0]; }
/**
 * 建立 Enter 按鍵事件替身。
 * @param {object} [extra={}] 額外欄位（shiftKey、isComposing）。
 * @returns {object} 事件替身。
 */
function keyEvent(extra = {}) {
  return {
    key: 'Enter', ...extra,
    /** 空的預設行為攔截。@returns {void} */
    preventDefault() {},
  };
}

/** 清除全域文件替身。@returns {void} */
function cleanup() { delete globalThis.document; }
test.afterEach(cleanup);

/**
 * 驗證開啟時立即只帶主題請助理判斷：等待中顯示「整理中…」並停用送出；回來後問候語是第一則助理訊息、接著是待補清單，
 * 面板依類型定義顯示欄位（self 唯讀）與帳號候選（不可選的停用並附原因）；部門由類型固定時不顯示處理部門欄位；不顯示判斷結果、預覽與指定處理人，Apply 停用。
 * @returns {Promise<void>}
 */
async function openGreets() {
  const gate = deferred();
  /** 第一次呼叫等待測試放行。@returns {Promise<object>} 回應。 */
  function responder() { return gate.promise; }
  const { doc, nodes, calls, dialog } = mount({ responder });
  assert.equal(nodes.departmentField.hidden, true, '判斷中不顯示處理部門');
  const opening = dialog.open();
  assert.equal(nodes.dialog.open, true);
  assert.equal(doc.activeElement, nodes.message, '開啟後焦點在訊息輸入框');
  assert.deepEqual(calls, [{ subject: '我要請假' }]);
  assert.equal(nodes.typing.hidden, false);
  assert.equal(nodes.typing.textContent, '整理中…');
  assert.equal(nodes.send.disabled, true);
  assert.equal(nodes.chatForm.getAttribute('aria-busy'), 'true');
  gate.resolve(leaveResponse());
  await opening;
  await flush(dialog);
  assert.equal(nodes.typing.hidden, true);
  assert.equal(nodes.send.disabled, false);
  assert.deepEqual(bubbles(nodes), [['assistant', GREETING], ['checklist', PROMPT]]);
  assert.equal(nodes.departmentField.hidden, true, '部門由類型固定時不顯示處理部門欄位');
  assert.equal(dialog.state.departmentId, HR.id, '送達部門仍依類型記錄');
  assert.deepEqual(nodes.fieldList.children.map(dataKeyOf), ['applicant', 'leave_type', 'start_at', 'end_at', 'agent', 'note']);
  const applicant = field(nodes, 'applicant');
  assert.equal(applicant.control.readOnly, true);
  assert.equal(applicant.control.value, 'tina.test');
  assert.equal(applicant.source.textContent, '系統');
  const startAt = field(nodes, 'start_at');
  assert.equal(startAt.control.type, 'date', '日期時間欄位的 label 指向原生日期輸入');
  const startTime = startAt.wrapper.querySelector('.datetime-time');
  assert.equal(startTime.type, 'text', '時間改為 24 小時制文字輸入，不使用原生上午／下午選擇器');
  assert.equal(startTime.getAttribute('list'), 'draft-field-start_at-times');
  assert.equal(startAt.wrapper.querySelector('datalist').children.length, 48, '每 30 分鐘一筆建議');
  assert.deepEqual(field(nodes, 'leave_type').control.children.map(textOf), ['請選擇', '事假', '病假', '特休']);
  const agentOptions = field(nodes, 'agent').control.children;
  assert.deepEqual(agentOptions.map(textOf), ['請選擇', 'kevin.test', 'lisa.test（此期間也有請假）']);
  assert.deepEqual(agentOptions.map(disabledOf), [false, false, true]);
  assert.equal(field(nodes, 'leave_type').status.textContent, DRAFT_TEXT.status.missing);
  assert.equal(field(nodes, 'note').status.textContent, DRAFT_TEXT.status.optional);
  assert.equal(nodes.prompt.textContent, PROMPT);
  assert.equal(field(nodes, 'note').control.tagName, 'TEXTAREA', 'max_length 超過 100 的文字欄位為多行');
  assert.equal(nodes.computed.hidden, true);
  assert.equal(nodes.summaries.hidden, true);
  assert.equal(nodes.apply.disabled, true);
}
test('開啟時只帶主題取得問候、待補清單與類型欄位', openGreets);

/**
 * 驗證對話送出：本文帶訊息、先前的對話紀錄與面板狀態（type_id）；AI 填好的欄位標示 AI；完成後以通用清單顯示後端的計算結果與摘要、整理好的內容，Apply 套用並關閉視窗。
 * @returns {Promise<void>}
 */
async function chatCompletes() {
  /**
   * 第一次回問候，聊天回完成的請假內容。
   * @param {object} input 請求。
   * @returns {object} 後端 JSON。
   */
  function responder(input) { return input.message ? completeLeaveResponse() : leaveResponse(); }
  const { doc, nodes, trigger, page, calls, dialog } = mount({ responder });
  await dialog.open();
  await say(nodes, ' 12/1 九點半到五點半請事假，代理人 kevin.test ');
  await flush(dialog);
  assert.deepEqual(calls[1], {
    subject: '我要請假', message: '12/1 九點半到五點半請事假，代理人 kevin.test', history: [{ role: 'assistant', text: GREETING }],
    state: { type_id: 'leave', department_id: HR.id, handler_id: null, intent: '請假申請', fields: { leave_type: '', start_at: '', end_at: '', agent: '', note: '' }, locked: [] },
  });
  assert.equal(nodes.message.value, '');
  assert.deepEqual(bubbles(nodes).slice(2), [['user', '12/1 九點半到五點半請事假，代理人 kevin.test'], ['assistant', '已整理好請假內容，請確認右側欄位']]);
  assert.equal(field(nodes, 'leave_type').control.value, '事假');
  assert.equal(field(nodes, 'agent').control.value, 'kevin.test');
  assert.equal(field(nodes, 'agent').source.textContent, 'AI');
  assert.equal(field(nodes, 'agent').status.textContent, DRAFT_TEXT.status.done);
  assert.equal(nodes.computed.hidden, false);
  assert.deepEqual(nodes.computed.children.map(textOf), ['請假時數：7 小時 0 分鐘']);
  assert.equal(nodes.summaries.hidden, false);
  assert.deepEqual(nodes.summaries.children.map(textOf), [LEAVE_SUMMARY]);
  assert.equal(nodes.apply.disabled, false);
  await nodes.apply.click();
  assert.deepEqual(page.applied, [{ content: RENDERED, draft: {
    form: { id: 'leave', version: 2, fields: { leave_type: '事假', start_at: '2026-12-01T09:30', end_at: '2026-12-01T17:30', agent: 'kevin.test', note: '' } },
    formName: '請假申請', department: HR, departmentFixed: true, handler: null, rendered: RENDERED,
  } }]);
  assert.equal(nodes.dialog.open, false);
  assert.equal(doc.activeElement, trigger, '關閉後焦點回到「自動生成」');
  await say(nodes, '再問一次');
  assert.deepEqual(calls[2].history.map(roleOf), ['assistant', 'user', 'assistant'], '對話紀錄依序累積');
}
test('對話送出後由 AI 整理欄位並套用', chatCompletes);

/**
 * 驗證手動修改欄位：標示手動並鎖定、約 400 毫秒（測試為 0）後只送面板狀態驗證（不帶訊息）；日期時間只保留到分鐘；之後 AI 不會覆寫鎖定的欄位。
 * @returns {Promise<void>}
 */
async function manualEditLocks() {
  /**
   * 驗證時沿用送出的值，聊天時 AI 想把代理人改成 lisa.test。
   * @param {object} input 請求。
   * @returns {object} 後端 JSON。
   */
  function responder(input) {
    if (!input.state) return leaveResponse();
    if (input.message) return leaveResponse({ values: { applicant: 'tina.test', ...input.state.fields, agent: 'lisa.test', leave_type: '病假' }, sources: { agent: 'ai', leave_type: 'ai' }, reply: '已更新' });
    return leaveResponse({ values: { applicant: 'tina.test', ...input.state.fields }, sources: { agent: 'user', start_at: 'user' }, missing: ['leave_type', 'end_at'], reply: '' });
  }
  const { nodes, calls, dialog } = mount({ responder });
  await dialog.open();
  await edit(nodes, 'agent', 'kevin.test');
  assert.equal(field(nodes, 'agent').status.textContent, DRAFT_TEXT.status.checking);
  assert.equal(field(nodes, 'agent').source.textContent, '手動');
  assert.equal(nodes.apply.disabled, true);
  await edit(nodes, 'start_at', '2026-12-01T09:30:00');
  await flush(dialog);
  assert.equal(calls.length, 2, '連續修改只送最後一次驗證');
  assert.deepEqual(calls[1], { subject: '我要請假', state: { type_id: 'leave', department_id: HR.id, handler_id: null, intent: '請假申請',
    fields: { leave_type: '', start_at: '2026-12-01T09:30', end_at: '', agent: 'kevin.test', note: '' }, locked: ['agent', 'start_at'] } });
  assert.equal(field(nodes, 'agent').status.textContent, DRAFT_TEXT.status.done);
  assert.equal(field(nodes, 'end_at').status.textContent, DRAFT_TEXT.status.missing);
  assert.equal(bubbles(nodes).length, 2, '驗證不在對話區加訊息');
  await say(nodes, '改成病假');
  await flush(dialog);
  assert.equal(field(nodes, 'agent').control.value, 'kevin.test', 'AI 不覆寫手動修改的代理人');
  assert.equal(dialog.state.values.agent, 'kevin.test');
  assert.equal(field(nodes, 'leave_type').control.value, '病假', '沒有鎖定的欄位由 AI 更新');
  assert.equal(field(nodes, 'leave_type').source.textContent, 'AI');
  assert.equal(normalizeControlValue({ type: 'datetime' }, '2026-12-01T09:30:59.000'), '2026-12-01T09:30');
  assert.equal(normalizeControlValue({ type: 'text' }, 5), '');
}
test('手動修改欄位會鎖定並只做驗證', manualEditLocks);

/**
 * 驗證過期的結果：較早送出的驗證在較新的修改之後才回來時被捨棄；AI 回覆晚於使用者修改時只更新未鎖定的欄位，並立即再驗證一次才能套用。
 * @returns {Promise<void>}
 */
async function staleResults() {
  const gates = [];
  /**
   * 第一次回問候，其餘請求等待測試放行。
   * @param {object} input 請求。
   * @returns {object|Promise<object>} 後端 JSON。
   */
  function responder(input) {
    if (!input.state) return leaveResponse();
    const gate = deferred();
    gates.push({ input, gate });
    return gate.promise;
  }
  const { nodes, calls, dialog } = mount({ responder });
  await dialog.open();
  await edit(nodes, 'leave_type', '事假');
  await tick();
  assert.equal(gates.length, 1);
  await edit(nodes, 'note', '看診');
  await tick();
  assert.equal(gates.length, 2);
  gates[1].gate.resolve(leaveResponse({ values: { ...FILLED_LEAVE_VALUES, agent: '', note: '看診' }, missing: ['agent'], reply: '' }));
  await tick();
  gates[0].gate.resolve(leaveResponse({ values: { applicant: 'tina.test', leave_type: '事假' }, missing: ['start_at', 'end_at', 'agent'], reply: '' }));
  await tick();
  assert.deepEqual(dialog.state.missing, ['agent'], '過期的驗證結果被捨棄');
  const chat = say(nodes, '代理人 kevin.test，十二月一日請整天');
  await tick();
  assert.equal(gates.length, 3);
  await edit(nodes, 'note', '看牙醫');
  gates[2].gate.resolve(completeLeaveResponse({ values: { ...FILLED_LEAVE_VALUES, note: '看診' } }));
  await chat;
  assert.equal(field(nodes, 'agent').control.value, 'kevin.test', 'AI 的代理人仍然採用');
  assert.equal(field(nodes, 'note').control.value, '看牙醫', '使用者較新的修改保留');
  assert.equal(nodes.apply.disabled, true, '尚未驗證最新內容前不能套用');
  await tick();
  await tick();
  const last = gates.at(-1);
  assert.equal(last.input.message, undefined);
  assert.deepEqual(last.input.state.fields, { leave_type: '事假', start_at: '2026-12-01T09:30', end_at: '2026-12-01T17:30', agent: 'kevin.test', note: '看牙醫' });
  last.gate.resolve(completeLeaveResponse({ values: { ...FILLED_LEAVE_VALUES, note: '看牙醫' }, rendered_content: RENDERED.replace('[備註]: 無', '[備註]: 看牙醫') }));
  await flush(dialog);
  assert.equal(nodes.apply.disabled, false);
  assert.ok(dialog.state.rendered.endsWith('[備註]: 看牙醫'), '採用最新內容整理好的文字');
  assert.ok(calls.length >= 5);
}
test('過期的驗證與較晚回來的 AI 回覆', staleResults);

/**
 * 驗證沒有固定部門的類型（模擬一般需求）：只有「需求說明」欄位、處理部門欄位顯示且由使用者從下拉選單選擇（沒有部門時提示），改部門後驗證；
 * 送出的 handler_id 一律為 null；完成後套用時帶類型表單、departmentFixed 為 false、部門，處理人為 null。
 * @returns {Promise<void>}
 */
async function generalRequest() {
  /**
   * 依面板狀態回應：說明與部門都有時完成。
   * @param {object} input 請求。
   * @returns {object} 後端 JSON。
   */
  function responder(input) {
    if (!input.state) return generalResponse();
    const department = input.state.department_id === IT.id ? IT : null;
    const description = input.state.fields.description ?? '';
    const complete = Boolean(department && description);
    return generalResponse({ department, values: { description },
      missing: [...(description ? [] : ['description']), ...(department ? [] : ['department_id'])], complete, reply: '',
      rendered_content: complete ? `[需求說明]: ${description}\n[處理部門]: ${department.name}` : null });
  }
  const { nodes, page, calls, dialog } = mount({ responder, subject: '電腦很慢' });
  await dialog.open();
  await flush(dialog);
  assert.equal(nodes.departmentField.hidden, false, '沒有固定部門時顯示處理部門欄位');
  assert.deepEqual(nodes.departmentSelect.children.map(textOf), ['請選擇處理部門', '測試人資部', '測試資訊部', '測試總務組']);
  assert.equal(nodes.departmentStatus.textContent, `${DRAFT_TEXT.status.missing}：${DRAFT_TEXT.departmentMissing}`);
  assert.deepEqual(nodes.fieldList.children.map(dataKeyOf), ['description']);
  assert.equal(field(nodes, 'description').control.tagName, 'TEXTAREA');
  nodes.departmentSelect.value = IT.id;
  await nodes.departmentSelect.dispatch('change');
  assert.equal(nodes.departmentSource.textContent, '手動');
  await flush(dialog);
  assert.equal(calls[1].state.department_id, IT.id);
  assert.equal(calls[1].state.type_id, 'general');
  assert.equal(nodes.departmentSource.textContent, '手動', '後端沿用使用者選的部門時保留手動標示');
  await edit(nodes, 'description', '筆電開機要五分鐘');
  await flush(dialog);
  assert.deepEqual(calls.at(-1).state, { type_id: 'general', department_id: IT.id, handler_id: null, intent: '一般需求', fields: { description: '筆電開機要五分鐘' },
    locked: ['description', 'department_id'] }, '手動選過的部門一併鎖定，AI 不得改寫；不送指定處理人');
  assert.equal(nodes.apply.disabled, false);
  await nodes.apply.click();
  assert.deepEqual(page.applied[0].draft, { form: { id: 'general', version: 1, fields: { description: '筆電開機要五分鐘' } }, formName: '一般需求', department: IT, departmentFixed: false, handler: null,
    rendered: '[需求說明]: 筆電開機要五分鐘\n[處理部門]: 測試資訊部' });
  dialog.open();
  nodes.departmentSelect.value = HR.id;
  await nodes.departmentSelect.dispatch('change');
  assert.equal(dialog.state.departmentId, HR.id);
  assert.equal(nodes.apply.disabled, true, '改部門後要重新驗證才能套用');
}
test('沒有固定部門的類型選擇處理部門', generalRequest);

/**
 * 驗證 AI 無法使用的回應：顯示後端產生的回覆與一次說明（額度用盡有專用文字），連續發生時不重複說明；欄位仍可手動填寫。
 * @returns {Promise<void>}
 */
async function aiUnavailable() {
  /**
   * 一律回 AI 無法使用的結果。
   * @param {object} input 請求。
   * @returns {object} 後端 JSON。
   */
  function responder(input) {
    return leaveResponse({ ai_available: false, ai_error: { code: 'DAILY_QUOTA_EXCEEDED', message: '今日額度已用完（測試）' }, reply: input.message ? '已收到，請直接填寫右側欄位' : GREETING });
  }
  const { nodes, dialog } = mount({ responder });
  await dialog.open();
  await say(nodes, '請假');
  await flush(dialog);
  const roles = bubbles(nodes).map(firstOf);
  assert.deepEqual(roles, ['assistant', 'system', 'checklist', 'user', 'assistant']);
  assert.equal(bubbles(nodes)[1][1], DRAFT_TEXT.aiErrors.DAILY_QUOTA_EXCEEDED);
  assert.equal(describeAiUnavailable('AI_NOT_CONFIGURED'), DRAFT_TEXT.noAi);
  assert.equal(describeAiUnavailable({ code: 'GLOBAL_QUOTA_EXCEEDED', message: '' }), DRAFT_TEXT.aiErrors.GLOBAL_QUOTA_EXCEEDED);
  assert.equal(describeAiUnavailable(null), DRAFT_TEXT.noAi);
  await edit(nodes, 'leave_type', '特休');
  await flush(dialog);
  assert.equal(field(nodes, 'leave_type').control.value, '特休');
}
test('AI 無法使用時說明一次並保留手動填寫', aiUnavailable);

/**
 * 驗證請求失敗：第一次呼叫 503 顯示訊息與重試提示、重新開啟時重試；聊天 429 限流開始倒數並把訊息標為未送達、放回輸入框且不列入對話紀錄；
 * 額度用盡不倒數；驗證失敗顯示在面板下方；401 交給頁面回登入頁；非預期錯誤只寫入主控台並顯示通用提示。
 * 倒數使用 node:test 的模擬計時器（只模擬 Date 與 setInterval，驗證用的 setTimeout 維持真實）。
 * @param {import('node:test').TestContext} context 測試情境，提供模擬計時器。
 * @returns {Promise<void>}
 */
async function failures(context) {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const errors = [new TicketServiceError('系統暫時忙碌，請稍後再試', { status: 503, code: 'AI_UNAVAILABLE' })];
  /**
   * 有排定的錯誤時拋出，否則回問候或驗證結果。
   * @param {object} input 請求。
   * @returns {object} 後端 JSON。
   * @throws {TicketServiceError} 排定的錯誤。
   */
  function responder(input) {
    const error = errors.shift();
    if (error) throw error;
    return defaultResponder(input);
  }
  const { nodes, page, calls, dialog } = mount({ responder });
  await dialog.open();
  assert.deepEqual(bubbles(nodes), [['system', `系統暫時忙碌，請稍後再試\n${DRAFT_TEXT.retryHint}`]]);
  assert.equal(nodes.send.disabled, false, '失敗後仍可輸入訊息重試');
  assert.equal(nodes.departmentField.hidden, true, '還沒有結果時不顯示處理部門');
  dialog.close();
  await dialog.open();
  assert.equal(calls.length, 2, '重新開啟時重試第一次呼叫');
  assert.equal(calls[1].state, undefined);
  errors.push(new TicketServiceError('請求太頻繁', { status: 429, code: 'RATE_LIMITED', retryAfter: 5 }));
  await say(nodes, '明天請假');
  assert.equal(nodes.send.disabled, true);
  assert.equal(nodes.send.textContent, '請等 5 秒');
  assert.equal(nodes.message.value, '明天請假', '失敗的訊息放回輸入框');
  const failed = nodes.log.children.at(-2);
  assert.equal(failed.classList.contains('is-undelivered'), true);
  assert.ok(failed.textContent.includes(DRAFT_TEXT.undelivered));
  assert.equal(bubbles(nodes).at(-1)[1], `請求太頻繁\n${DRAFT_TEXT.manualHint}`);
  assert.equal(dialog.state.history.map(roleOf).includes('user'), false, '未送達的訊息不列入對話紀錄');
  context.mock.timers.tick(5000);
  assert.equal(nodes.send.disabled, false, '倒數結束後恢復送出');
  assert.equal(nodes.send.textContent, DRAFT_TEXT.send);
  assert.equal(dialog.state.waitTimer, null);
  errors.push(new TicketServiceError('今日額度已用完，將於台北時間午夜重置', { status: 429, code: 'DAILY_QUOTA_EXCEEDED' }));
  await say(nodes, '明天請假');
  await flush(dialog);
  assert.equal(nodes.send.textContent, DRAFT_TEXT.send, '額度用盡不倒數');
  errors.push(new TicketServiceError('資料庫暫時無法使用', { status: 503, code: 'DATABASE_UNAVAILABLE' }));
  await edit(nodes, 'leave_type', '事假');
  await flush(dialog);
  assert.equal(nodes.error.textContent, `${DRAFT_TEXT.validateFailed}資料庫暫時無法使用`);
  errors.push(new TicketServiceError('登入已失效，請重新登入', { status: 401, code: 'UNAUTHORIZED' }));
  await say(nodes, '再試');
  assert.equal(page.logins, 1);
  errors.push(new Error('boom'));
  const originalError = console.error;
  const logged = [];
  /** 記錄主控台錯誤而不輸出。@param {...unknown} args 參數。@returns {void} */
  console.error = function capture(...args) { logged.push(args); };
  try { await say(nodes, '再試一次'); } finally { console.error = originalError; }
  assert.equal(bubbles(nodes).at(-1)[1], `${DRAFT_TEXT.unexpected}\n${DRAFT_TEXT.manualHint}`);
  assert.equal(logged.length, 1);
}
test('草稿請求失敗的處理', failures);

/**
 * 驗證 Esc 與重新開啟：沒有輸入時直接關閉；有輸入時先詢問，取消則保留視窗；以相同主題重新開啟時接續、不再呼叫；
 * 主題變更時詢問重新開始，同意則清空對話並重新取得問候，不同意則沿用對話並在之後使用新主題。
 * @returns {Promise<void>}
 */
async function escapeAndReopen() {
  const { win, nodes, page, calls, dialog } = mount();
  await dialog.open();
  await nodes.dialog.dispatch('cancel');
  assert.equal(nodes.dialog.open, false);
  assert.deepEqual(win.confirms, []);
  await dialog.open();
  assert.equal(calls.length, 1, '相同主題重新開啟時接續');
  nodes.message.value = '還沒送出的訊息';
  win.confirmAnswer = false;
  await nodes.dialog.dispatch('cancel');
  assert.equal(nodes.dialog.open, true);
  assert.deepEqual(win.confirms, [DRAFT_TEXT.closeConfirm]);
  win.confirmAnswer = true;
  await nodes.dialog.dispatch('cancel');
  assert.equal(nodes.dialog.open, false);
  assert.equal(nodes.message.value, '還沒送出的訊息', '關閉後保留內容');
  await nodes.cancel.click();
  page.subject = '我要請特休';
  win.confirmAnswer = false;
  await dialog.open();
  assert.equal(win.confirms.at(-1), DRAFT_TEXT.restartConfirm);
  assert.equal(calls.length, 1);
  await say(nodes, '下週一');
  await flush(dialog);
  assert.equal(calls.at(-1).subject, '我要請特休', '沿用對話但使用新主題');
  await nodes.close.click();
  page.subject = '我要請病假';
  win.confirmAnswer = true;
  await dialog.open();
  await flush(dialog);
  assert.deepEqual(calls.at(-1), { subject: '我要請病假' }, '重新開始時重新取得問候');
  assert.deepEqual(bubbles(nodes), [['assistant', GREETING], ['checklist', PROMPT]]);
  assert.equal(nodes.message.value, '');
}
test('Esc 關閉確認與重新開啟', escapeAndReopen);

/**
 * 驗證 Apply：需求內容已有文字時詢問取代或附加在後，返回時焦點回到 Apply；附加後超過 2000 字時提示且不套用。
 * @returns {Promise<void>}
 */
async function applyChoices() {
  /**
   * 第一次就回完成的請假內容（AI 從主題整理）。
   * @returns {object} 後端 JSON。
   */
  function responder() { return completeLeaveResponse(); }
  const { doc, nodes, page, dialog } = mount({ responder, content: '原本的說明' });
  await dialog.open();
  await nodes.apply.click();
  assert.equal(nodes.applyChoice.hidden, false);
  assert.equal(doc.activeElement, nodes.replace);
  assert.equal(page.applied.length, 0);
  await nodes.choiceCancel.click();
  assert.equal(nodes.applyChoice.hidden, true);
  assert.equal(doc.activeElement, nodes.apply);
  await nodes.apply.click();
  await nodes.append.click();
  assert.equal(page.applied[0].content, `原本的說明\n\n${RENDERED}`);
  page.content = '舊內容';
  await dialog.open();
  await nodes.apply.click();
  await nodes.replace.click();
  assert.equal(page.applied[1].content, RENDERED);
  page.content = 'x'.repeat(1990);
  await dialog.open();
  await nodes.apply.click();
  await nodes.append.click();
  assert.equal(page.applied.length, 2);
  assert.equal(nodes.error.textContent, describeOverLimit(1990 + 2 + Array.from(RENDERED).length));
  assert.equal(nodes.dialog.open, true);
}
test('Apply 的取代、附加與字數上限', applyChoices);

/**
 * 驗證訊息輸入：Enter 送出、Shift+Enter 與輸入法組字不送出、空白與超過 300 字時提示且不送出、字數提示。
 * @returns {Promise<void>}
 */
async function messageInput() {
  const { nodes, calls, dialog } = mount();
  await dialog.open();
  nodes.message.value = '  ';
  await nodes.chatForm.dispatch('submit');
  assert.equal(nodes.error.textContent, DRAFT_TEXT.emptyMessage);
  nodes.message.value = '😀'.repeat(301);
  await nodes.message.dispatch('input');
  assert.equal(nodes.messageCount.textContent, '301 / 300');
  assert.equal(nodes.messageCount.classList.contains('over-limit'), true);
  assert.equal(nodes.error.textContent, '');
  await nodes.chatForm.dispatch('submit');
  assert.equal(nodes.error.textContent, '訊息最多 300 字，目前 301 字');
  nodes.message.value = '換行';
  assert.equal(dialog.handleMessageKeydown(keyEvent({ shiftKey: true })), undefined);
  assert.equal(dialog.handleMessageKeydown(keyEvent({ isComposing: true })), undefined);
  assert.equal(calls.length, 1);
  await dialog.handleMessageKeydown(keyEvent());
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message, '換行');
}
test('訊息的鍵盤操作與字數限制', messageInput);

/**
 * 驗證定義檔的檢查未通過時：後端把錯誤放在 invalid、摘要放在 summaries，面板顯示摘要與欄位的格式不符狀態，Apply 停用（即使後端誤回 complete）。
 * 前端不自行判斷額度或時數，只依回應呈現。
 * @returns {Promise<void>}
 */
async function checkFailures() {
  /** 回額度不足的結果。@returns {object} 後端 JSON。 */
  function responder() {
    return completeLeaveResponse({ invalid: [{ key: 'leave_type', message: '假別剩餘時數不足' }], summaries: ['事假剩餘時數：1 小時 → -6 小時'] });
  }
  const { nodes, dialog } = mount({ responder });
  await dialog.open();
  await flush(dialog);
  assert.deepEqual(nodes.summaries.children.map(textOf), ['事假剩餘時數：1 小時 → -6 小時']);
  assert.equal(field(nodes, 'leave_type').status.textContent, `${DRAFT_TEXT.status.invalid}：假別剩餘時數不足`);
  assert.equal(field(nodes, 'leave_type').control.getAttribute('aria-invalid'), 'true');
  assert.equal(nodes.apply.disabled, true);
}
test('定義檔檢查未通過時顯示摘要並停用套用', checkFailures);

/**
 * 驗證固定部門由 type.department 提供的類型（模擬設備申請）完全依定義繪製：self 唯讀、短文字為單行（maxLength）、長文字為多行、
 * number 為數字輸入（min、max、step 1）、date 為日期輸入；部門由類型固定，不顯示處理部門欄位；手動輸入的日期只保留 YYYY-MM-DD、數字去除空白；
 * 後端回報的數量格式錯誤顯示在該欄位；完成後套用帶該類型的表單與 departmentFixed。
 * @returns {Promise<void>}
 */
async function equipmentType() {
  const filled = { applicant: 'tina.test', item: '27 吋螢幕', quantity: '2', purpose: '雙螢幕工作', needed_by: '2026-11-20', location: '3F 研發區' };
  const rendered = '[申請人]: tina.test\n[設備品項]: 27 吋螢幕\n[數量]: 2\n[用途說明]: 雙螢幕工作\n[需要日期]: 2026-11-20（週五）\n[送交地點]: 3F 研發區';
  /**
   * 第一次回空白表單；驗證時數量超過上限回格式錯誤，其他欄位都有值時完成。
   * @param {object} input 請求。
   * @returns {object} 後端 JSON。
   */
  function responder(input) {
    if (!input.state) return equipmentResponse();
    const values = { applicant: 'tina.test', ...input.state.fields };
    const invalid = Number(values.quantity) > 50 ? [{ key: 'quantity', message: '數量最多 50' }] : [];
    /**
     * 欄位是否還沒有值。
     * @param {string} key 欄位代號。
     * @returns {boolean} 是否空白。
     */
    function isEmpty(key) { return !values[key]; }
    const missing = Object.keys(values).filter(isEmpty);
    const complete = !invalid.length && !missing.length;
    return equipmentResponse({ values, invalid, missing, complete, rendered_content: complete ? rendered : null, reply: '' });
  }
  const { nodes, page, calls, dialog } = mount({ responder, subject: '申請螢幕' });
  await dialog.open();
  await flush(dialog);
  assert.deepEqual(nodes.fieldList.children.map(dataKeyOf), ['applicant', 'item', 'quantity', 'purpose', 'needed_by', 'location']);
  assert.equal(nodes.departmentField.hidden, true);
  assert.equal(dialog.state.departmentId, GA.id);
  assert.equal(field(nodes, 'applicant').control.readOnly, true);
  assert.equal(field(nodes, 'applicant').control.value, 'tina.test');
  assert.equal(field(nodes, 'item').control.tagName, 'INPUT');
  assert.equal(field(nodes, 'item').control.maxLength, 50);
  const quantity = field(nodes, 'quantity').control;
  assert.equal(quantity.type, 'number');
  assert.deepEqual([quantity.getAttribute('min'), quantity.getAttribute('max'), quantity.getAttribute('step')], ['1', '50', '1']);
  assert.equal(field(nodes, 'purpose').control.tagName, 'TEXTAREA');
  assert.equal(field(nodes, 'needed_by').control.type, 'date');
  for (const [key, value] of Object.entries(filled)) if (key !== 'applicant') await edit(nodes, key, key === 'quantity' ? ' 99 ' : key === 'needed_by' ? `${value}T00:00` : value);
  await flush(dialog);
  assert.equal(calls.at(-1).state.type_id, 'equipment');
  assert.deepEqual(calls.at(-1).state.fields, { item: filled.item, quantity: '99', purpose: filled.purpose, needed_by: filled.needed_by, location: filled.location },
    'self 欄位不送出、日期只保留到日、數字去除空白');
  assert.equal(field(nodes, 'quantity').status.textContent, `${DRAFT_TEXT.status.invalid}：數量最多 50`);
  assert.equal(nodes.apply.disabled, true);
  await edit(nodes, 'quantity', '2');
  await flush(dialog);
  assert.equal(nodes.apply.disabled, false);
  await nodes.apply.click();
  assert.deepEqual(page.applied[0].draft, { form: { id: 'equipment', version: 1, fields: { item: filled.item, quantity: '2', purpose: filled.purpose, needed_by: filled.needed_by, location: filled.location } },
    formName: '設備申請', department: GA, departmentFixed: true, handler: null, rendered });
}
test('固定部門類型依定義繪製數字與日期欄位並套用', equipmentType);

/**
 * 驗證之後新增、前端從未見過的類型只靠定義就能繪製：帳號與部門欄位的候選來自 field_options（部門欄位沒有提供時改用 department_options），
 * 不可選的候選停用並附原因（沒有原因時使用通用文字）；沒有候選時顯示說明；不認得的欄位型別以單行文字輸入呈現；
 * 後端任意的計算結果與摘要以通用清單顯示；沒有固定部門時部門可選。
 * @returns {Promise<void>}
 */
async function futureType() {
  const type = { id: 'parking-test', version: 3, name: '測試停車證申請', fields: [
    { key: 'plate', label: '車牌', type: 'text', required: true, max_length: 10 },
    { key: 'owner', label: '車主同仁', type: 'account', required: true },
    { key: 'backup', label: '備援聯絡人', type: 'account' },
    { key: 'host', label: '主辦部門', type: 'department' },
    { key: 'color', label: '車色', type: 'colour-test' },
  ] };
  /**
   * 回只靠定義描述的新類型。
   * @param {object} input 請求。
   * @returns {object} 後端 JSON。
   */
  function responder(input) {
    return {
      intent: '停車證', type, department: null, department_options: [HR, IT], handler: null, handler_options: [],
      values: { plate: input.state?.fields.plate ?? '', owner: '', backup: '', host: '', color: '' }, sources: {}, missing: ['plate', 'owner', 'department_id'], invalid: [],
      field_options: { owner: [{ id: 'amy.test', name: 'amy.test' }, { id: 'ben.test', name: 'ben.test', available: false }], backup: [] },
      computed: [{ key: 'days', label: '使用天數', value: 30, text: '30 天' }], summaries: ['本月剩餘名額：3 → 2'], reply: '請填寫車牌', prompt: '', ai_available: true, complete: false,
    };
  }
  const { nodes, calls, dialog } = mount({ responder, subject: '申請停車證' });
  await dialog.open();
  await flush(dialog);
  assert.deepEqual(nodes.fieldList.children.map(dataKeyOf), ['plate', 'owner', 'backup', 'host', 'color']);
  assert.equal(field(nodes, 'plate').control.tagName, 'INPUT');
  const owner = field(nodes, 'owner').control;
  assert.deepEqual(owner.children.map(textOf), ['請選擇', 'amy.test', `ben.test（${DRAFT_TEXT.optionUnavailable}）`]);
  assert.deepEqual(owner.children.map(disabledOf), [false, false, true]);
  assert.equal(field(nodes, 'backup').wrapper.querySelector('.draft-field-note').hidden, false, '沒有候選時顯示說明');
  assert.deepEqual(field(nodes, 'host').control.children.map(textOf), ['請選擇', '測試人資部', '測試資訊部'], '部門欄位沒有 field_options 時改用 department_options');
  assert.equal(field(nodes, 'color').control.tagName, 'INPUT', '不認得的型別以文字輸入呈現');
  assert.equal(field(nodes, 'color').control.type, 'text');
  assert.equal(nodes.departmentSelect.hidden, false, '沒有固定部門時可以選擇');
  assert.deepEqual(nodes.computed.children.map(textOf), ['使用天數：30 天']);
  assert.deepEqual(nodes.summaries.children.map(textOf), ['本月剩餘名額：3 → 2']);
  await edit(nodes, 'plate', 'TEST-01');
  await flush(dialog);
  assert.deepEqual(calls.at(-1).state, { type_id: 'parking-test', department_id: null, handler_id: null, intent: '停車證',
    fields: { plate: 'TEST-01', owner: '', backup: '', host: '', color: '' }, locked: ['plate'] });
  assert.equal(normalizeControlValue({ type: 'date' }, '2026-11-20T08:00'), '2026-11-20');
  assert.equal(normalizeControlValue({ type: 'number' }, ' 7 '), '7');
}
test('只靠定義就能繪製前端沒見過的新類型', futureType);

/**
 * 驗證 reset 清空對話與面板，之後才回來的舊請求結果被捨棄。
 * @returns {Promise<void>}
 */
async function resetDiscards() {
  const gate = deferred();
  /** 第一次呼叫等待測試放行。@returns {Promise<object>} 回應。 */
  function responder() { return gate.promise; }
  const { nodes, dialog } = mount({ responder });
  const opening = dialog.open();
  dialog.reset();
  gate.resolve(leaveResponse());
  await opening;
  await flush(dialog);
  assert.deepEqual(bubbles(nodes), []);
  assert.equal(nodes.fieldList.children.length, 0);
  assert.equal(dialog.state.started, false);
  assert.equal(nodes.send.disabled, true);
  assert.equal(nodes.typing.hidden, true);
}
test('重新開始後捨棄舊的結果', resetDiscards);

/**
 * 驗證與後端實際行為的整合點：
 * - AI 無法使用時後端已把 ai_error.message 放進回覆，前端不再重複顯示系統提示；
 * - 檢查尚未能執行時（例如還沒選類別）後端只回計算結果、沒有摘要，面板只顯示計算結果；
 * - 有尚未驗證的修改時停用 Apply，驗證完成前不採用舊的整理結果。
 * @returns {Promise<void>}
 */
async function backendIntegration() {
  const notice = '目前 AI 助手尚未啟用，請直接在右側欄位填寫或選擇';
  const preview = '[請假人]: tina.test\n[請假日期]: 2026-12-01（週二）\n（後端預覽）';
  /**
   * 第一次呼叫回問候加說明；之後回只有計算結果、沒有摘要的驗證結果。
   * @param {object} input 請求。
   * @returns {object} 後端 JSON。
   */
  function responder(input) {
    const unavailable = { ai_available: false, ai_error: { code: 'AI_UNAVAILABLE', message: notice } };
    if (!input.state) return leaveResponse({ ...unavailable, reply: `${GREETING}\n${notice}` });
    return leaveResponse({ ...unavailable, reply: input.message ? notice : '', values: { applicant: 'tina.test', ...input.state.fields },
      missing: ['leave_type', 'agent'], computed: [{ key: 'minutes', label: '請假時數', value: 420, text: '7 小時 0 分鐘' }], summaries: [], preview_content: preview });
  }
  const { nodes, dialog } = mount({ responder });
  await dialog.open();
  await flush(dialog);
  assert.deepEqual(bubbles(nodes).map(firstOf), ['assistant', 'checklist'], '回覆已含 AI 無法使用的說明時不另加系統提示');
  await edit(nodes, 'start_at', '2026-12-01T09:30');
  await edit(nodes, 'end_at', '2026-12-01T17:30');
  await flush(dialog);
  assert.equal(nodes.computed.hidden, false);
  assert.deepEqual(nodes.computed.children.map(textOf), ['請假時數：7 小時 0 分鐘']);
  assert.equal(nodes.summaries.hidden, true);
  assert.equal(nodes.apply.disabled, true);
  const control = field(nodes, 'note').control;
  control.value = '補充';
  await control.dispatch('input');
  assert.equal(nodes.apply.disabled, true, '有尚未驗證的修改時不能套用');
  await flush(dialog);
  await say(nodes, '代理人可以選誰？');
  await flush(dialog);
  assert.deepEqual(bubbles(nodes).map(firstOf), ['assistant', 'checklist', 'user', 'assistant'], '之後的回覆只有說明時也不重複提示');
}
test('與後端整合：AI 說明不重複、只有計算結果', backendIntegration);

/**
 * 驗證處理部門的鎖定：手動選部門後 locked 含 department_id、handler_id 一律為 null；選回「請選擇處理部門」則解除部門鎖定。
 * @returns {Promise<void>}
 */
async function routingLocks() {
  /**
   * 一般需求：依送出的部門回應。
   * @param {object} input 請求。
   * @returns {object} 後端 JSON。
   */
  function responder(input) {
    const departmentId = input.state?.department_id ?? null;
    return generalResponse({ department: departmentId === IT.id ? IT : null, values: { description: input.state?.fields.description ?? '' } });
  }
  const { nodes, calls, dialog } = mount({ responder, subject: '電腦很慢' });
  await dialog.open();
  await flush(dialog);
  nodes.departmentSelect.value = IT.id;
  await nodes.departmentSelect.dispatch('change');
  await flush(dialog);
  assert.deepEqual(calls.at(-1).state.locked, ['department_id']);
  assert.equal(calls.at(-1).state.handler_id, null);
  nodes.departmentSelect.value = '';
  await nodes.departmentSelect.dispatch('change');
  await flush(dialog);
  assert.deepEqual(calls.at(-1).state.locked, [], '選回請選擇處理部門時解除部門鎖定');
}
test('處理部門的手動選擇會送出鎖定', routingLocks);

/**
 * 驗證 AI 忙碌（ai_error 附 retry_after）時送出鈕倒數，面板仍可手動填寫。
 * @returns {Promise<void>}
 */
async function aiBusyCountdown() {
  /**
   * 第一次呼叫回 AI 忙碌並要求等待 8 秒。
   * @param {object} input 請求。
   * @returns {object} 後端 JSON。
   */
  function responder(input) {
    return leaveResponse({ ai_available: false, ai_error: { code: 'SERVICE_BUSY', message: 'AI 忙碌（測試）', retry_after: 8 }, reply: input.state ? '' : GREETING });
  }
  const { nodes, calls, dialog } = mount({ responder });
  await dialog.open();
  await flush(dialog);
  assert.equal(nodes.send.disabled, true);
  assert.match(nodes.send.textContent, /^請等 \d+ 秒$/);
  const before = calls.length;
  await edit(nodes, 'leave_type', '病假');
  await flush(dialog);
  assert.equal(field(nodes, 'leave_type').control.value, '病假', '倒數期間仍可手動填寫');
  assert.equal(calls.length, before + 1, 'AI 忙碌只限制詢問 AI，手動修改的驗證照常送出');
  assert.equal(calls.at(-1).message, undefined);
  assert.equal(nodes.send.disabled, true, '驗證結果不解除 AI 倒數');
  dialog.reset();
}
test('AI 忙碌時送出鈕倒數', aiBusyCountdown);
