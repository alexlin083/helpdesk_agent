import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument } from './helpers/fakeDom.js';
import { createHandlerPicker, filterHandlerGroups, PICKER_TEXT } from '../src/components/handlerPicker.js';

const groups = [
  { label: '資訊管理一部', options: [{ value: 'racky.huang', label: 'racky.huang', target: 'racky.huang（資訊管理一部）' }] },
  { label: '人力資源部', type: '人資', options: [
    { value: 'emily.wu', label: 'emily.wu', target: 'emily.wu（人力資源部）' },
    { value: 'frank.liu', label: 'frank.liu', target: 'frank.liu（人力資源部）' },
  ] },
  { label: '財務部', options: [{ value: 'amy.chen', label: 'amy.chen', target: 'amy.chen（財務部）' }] },
];

/**
 * 驗證關鍵字過濾：帳號比對不分大小寫、部門名稱命中列出整個部門、空白回傳全部、沒有符合回空陣列。
 * @returns {void}
 */
function filtering() {
  assert.equal(filterHandlerGroups(groups, ''), groups);
  assert.equal(filterHandlerGroups(groups, '   '), groups);
  assert.deepEqual(filterHandlerGroups(groups, 'F').map((group) => [group.label, group.options.map((option) => option.value)]),
    [['人力資源部', ['frank.liu']]]);
  assert.deepEqual(filterHandlerGroups(groups, ' 人力 ').map((group) => [group.label, group.options.map((option) => option.value)]),
    [['人力資源部', ['emily.wu', 'frank.liu']]]);
  assert.deepEqual(filterHandlerGroups(groups, 'amy.CHEN').map((group) => group.label), ['財務部']);
  assert.deepEqual(filterHandlerGroups(groups, '人資').map((group) => group.options.length), [2], '部門屬性標籤也能搜尋');
  assert.deepEqual(filterHandlerGroups(groups, 'zzz'), []);
}
test('處理人名單依帳號或部門關鍵字過濾', filtering);

/**
 * 建立選單替身與控制器。
 * @returns {object} nodes、picker 與 onChange 紀錄。
 */
function mount() {
  const doc = createFakeDocument();
  globalThis.document = doc;
  const nodes = { input: doc.createElement('input'), clear: doc.createElement('button'), listbox: doc.createElement('ul'), hidden: doc.createElement('input') };
  const changes = [];
  /** 記錄選定變化。@param {object|null} option 選項。@returns {void} */
  function onChange(option) { changes.push(option ? option.value : null); }
  const picker = createHandlerPicker(nodes, { onChange });
  return { nodes, picker, changes };
}
test.afterEach(() => { delete globalThis.document; });

/**
 * 驗證三種名單狀態：載入中與失敗時停用並顯示提示，成功時可開啟完整名單。
 * @returns {Promise<void>}
 */
async function listStates() {
  const { nodes, picker } = mount();
  assert.equal(nodes.input.getAttribute('role'), 'combobox');
  assert.equal(nodes.input.getAttribute('aria-expanded'), 'false');
  picker.setState('loading', '載入中');
  assert.equal(nodes.input.disabled, true);
  assert.equal(nodes.input.placeholder, '載入中');
  await nodes.input.dispatch('click');
  assert.equal(nodes.listbox.hidden, true, '停用時點擊不開啟');
  picker.setState('failed', '失敗');
  assert.equal(nodes.input.disabled, true);
  assert.equal(picker.enabled, false);
  picker.setState('ready', '不指定', groups);
  assert.equal(nodes.input.disabled, false);
  await nodes.input.dispatch('click');
  assert.equal(nodes.listbox.hidden, false);
  assert.equal(nodes.input.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(nodes.listbox.querySelectorAll('.picker-group').map((node) => node.textContent), ['資訊管理一部', '人力資源部', '財務部']);
  const options = nodes.listbox.querySelectorAll('.picker-option');
  assert.equal(options[0].textContent, PICKER_TEXT.none);
  assert.equal(options[0].getAttribute('aria-selected'), 'true', '尚未指定時「不指定」為選取狀態');
  assert.equal(options.length, 5);
}
test('名單載入中、失敗與成功狀態', listStates);

/**
 * 驗證鍵盤操作：上下鍵移動、Enter 選取且不送出表單、Esc 關閉並還原文字、失焦還原。
 * @returns {Promise<void>}
 */
async function keyboard() {
  const { nodes, picker, changes } = mount();
  picker.setState('ready', '不指定', groups);
  let prevented = 0;
  /** 記錄被攔截的預設行為。@returns {void} */
  function preventDefault() { prevented += 1; }
  await nodes.input.dispatch('keydown', { key: 'ArrowDown', preventDefault });
  assert.equal(nodes.listbox.hidden, false);
  assert.equal(nodes.input.getAttribute('aria-activedescendant'), 'handler-option-0');
  await nodes.input.dispatch('keydown', { key: 'ArrowUp', preventDefault });
  assert.equal(nodes.input.getAttribute('aria-activedescendant'), 'handler-option-4', '從第一項往上繞到最後一項');
  await nodes.input.dispatch('keydown', { key: 'Enter', preventDefault });
  assert.equal(nodes.hidden.value, 'amy.chen');
  assert.equal(nodes.input.value, 'amy.chen');
  assert.equal(nodes.listbox.hidden, true);
  assert.equal(nodes.clear.hidden, false);
  assert.deepEqual(changes, ['amy.chen']);
  assert.equal(prevented, 3, '清單開啟時方向鍵與 Enter 都攔下預設行為');
  await nodes.input.dispatch('keydown', { key: 'Enter', preventDefault });
  assert.equal(prevented, 3, '清單關閉時 Enter 交給表單');
  nodes.input.value = 'fr';
  await nodes.input.dispatch('input');
  assert.equal(nodes.hidden.value, '', '輸入文字後清掉已選定的處理人');
  assert.deepEqual(changes, ['amy.chen', null]);
  assert.deepEqual(nodes.listbox.querySelectorAll('.picker-option').map((node) => node.textContent), ['frank.liu']);
  await nodes.input.dispatch('keydown', { key: 'Enter', preventDefault });
  assert.equal(nodes.hidden.value, 'frank.liu', '只剩一個符合時 Enter 直接選取');
  await nodes.input.dispatch('click');
  assert.equal(nodes.listbox.querySelectorAll('.picker-option').length, 5, '已選定時再開啟顯示完整名單');
  nodes.input.value = 'xx';
  await nodes.input.dispatch('input');
  assert.equal(nodes.listbox.querySelector('.picker-empty').textContent, PICKER_TEXT.noMatch);
  await nodes.input.dispatch('keydown', { key: 'Escape', preventDefault });
  assert.equal(nodes.listbox.hidden, true);
  assert.equal(nodes.input.value, '', '已清掉選定時 Esc 還原為空白');
  nodes.input.value = 'em';
  await nodes.input.dispatch('input');
  await nodes.listbox.querySelector('.picker-option').click();
  assert.equal(nodes.hidden.value, 'emily.wu');
  nodes.input.value = 'em';
  await nodes.input.dispatch('input');
  await nodes.input.dispatch('focusout', { relatedTarget: null });
  assert.equal(nodes.listbox.hidden, true);
  assert.equal(nodes.input.value, '', '失焦且沒有選定時清空輸入框');
  await nodes.input.dispatch('click');
  await nodes.listbox.querySelectorAll('.picker-option')[2].click();
  assert.equal(nodes.hidden.value, 'emily.wu');
  await nodes.input.dispatch('focusout', { relatedTarget: nodes.clear });
  assert.equal(nodes.input.value, 'emily.wu', '焦點移到清除鈕不算離開');
  await nodes.clear.click();
  assert.equal(nodes.hidden.value, '');
  assert.equal(nodes.clear.hidden, true);
  assert.equal(nodes.input.value, '');
}
test('鍵盤與滑鼠操作可搜尋選單', keyboard);
