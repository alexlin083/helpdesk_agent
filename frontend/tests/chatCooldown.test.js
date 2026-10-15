import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatPanel } from '../src/components/ChatPanel.js';

/**
 * 提供聊天元件狀態測試所需的最小畫面節點，避免真實 DOM 與十秒等待。
 * @returns {ChatPanel} 使用實際冷卻及提交方法的元件。
 */
function createPanel() {
  const button = { disabled: false, textContent: '' };
  const input = {
    value: 'VPN 連不上', disabled: false,
    /** 模擬輸入框恢復焦點。@returns {void} */
    focus() {},
  };
  const panel = Object.assign(Object.create(ChatPanel.prototype), {
    busy: false, cooldownUntil: 0, cooldownTimer: null, input,
    status: { textContent: '' }, cooldownStatus: { textContent: '' },
    messages: {
      /** 模擬聊天區的無障礙屬性更新。@returns {void} */
      setAttribute() {},
    },
    root: {
      /** 取得送出按鈕。@returns {object} 按鈕替身。 */
      querySelector() { return button; },
      /** 取得表單控制項。@returns {object[]} 輸入及按鈕。 */
      querySelectorAll() { return [input, button]; },
    },
  });
  return panel;
}

/**
 * 驗證回應提早結束時仍須等十秒，且 Enter 提交無法繞過倒數。
 * @param {import('node:test').TestContext} context 可控制的日期與計時器。
 * @returns {Promise<void>}
 */
async function earlyResponse(context) {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  const panel = createPanel();
  let submissions = 0;
  /** 記錄通過冷卻保護的提交。@returns {Promise<void>} */
  async function onSend() { submissions += 1; }
  /** 模擬原生表單取消預設行為。@returns {void} */
  function preventDefault() {}
  panel.onSend = onSend;
  panel.setBusy(true);
  panel.startCooldown();
  assert.match(panel.cooldownStatus.textContent, /等待 10 秒/);
  context.mock.timers.tick(2000);
  panel.setBusy(false);
  assert.equal(panel.root.querySelector().disabled, true);
  assert.equal(panel.input.disabled, false);
  assert.match(panel.cooldownStatus.textContent, /等待 8 秒/);
  await panel.handleSubmit({ preventDefault });
  assert.equal(submissions, 0);
  context.mock.timers.tick(7750);
  assert.equal(panel.root.querySelector().disabled, true);
  assert.match(panel.cooldownStatus.textContent, /等待 1 秒/);
  context.mock.timers.tick(250);
  assert.equal(panel.root.querySelector().disabled, false);
  assert.equal(panel.cooldownTimer, null);
  await panel.handleSubmit({ preventDefault });
  assert.equal(submissions, 1);
}
test('提早完成或失敗後仍鎖定十秒，Enter 不能繞過倒數', earlyResponse);

/**
 * 驗證 API 超過十秒時仍鎖定，處理完成才解鎖；再次呼叫會重新計算十秒。
 * @param {import('node:test').TestContext} context 可控制的日期與計時器。
 * @returns {void}
 */
function slowResponse(context) {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  const panel = createPanel();
  panel.setBusy(true);
  panel.startCooldown();
  context.mock.timers.tick(15000);
  assert.equal(panel.root.querySelector().disabled, true);
  assert.match(panel.cooldownStatus.textContent, /仍在等待 AI/);
  panel.setBusy(false);
  assert.equal(panel.root.querySelector().disabled, false);
  panel.startCooldown();
  assert.equal(panel.root.querySelector().disabled, true);
  assert.match(panel.cooldownStatus.textContent, /等待 10 秒/);
  context.mock.timers.tick(10000);
  assert.equal(panel.root.querySelector().disabled, false);
  panel.startCooldown(20);
  context.mock.timers.tick(1000);
  panel.startCooldown(2);
  assert.equal(panel.remainingCooldown(), 19);
  context.mock.timers.tick(19000);
  assert.equal(panel.root.querySelector().disabled, false);
}
test('慢速回應持續鎖定，每次送出重新倒數', slowResponse);
