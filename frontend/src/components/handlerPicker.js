import { element } from './dom.js';

export const PICKER_TEXT = {
  none: '不指定，由 AI 判斷部門',
  noMatch: '沒有符合的處理人，換個關鍵字試試',
};

/**
 * 依關鍵字過濾分組的處理人選項：比對處理人帳號、部門名稱與部門屬性標籤（例如「人資」），不分大小寫、忽略首尾空白。
 * 關鍵字命中部門名稱或屬性時列出該部門全部處理人；關鍵字空白時回傳原陣列；沒有處理人符合的部門不列出。
 * @param {Array<{label: string, type?: string, options: Array<{value: string, label: string, target: string}>}>} groups 依部門分組的選項。
 * @param {string} query 使用者輸入的關鍵字。
 * @returns {Array<{label: string, options: Array<object>}>} 過濾後的分組。
 */
export function filterHandlerGroups(groups, query) {
  const keyword = String(query ?? '').trim().toLowerCase();
  if (!keyword) return groups;
  const result = [];
  for (const group of groups) {
    const groupMatch = group.label.toLowerCase().includes(keyword) || String(group.type ?? '').toLowerCase().includes(keyword);
    const options = groupMatch
      ? group.options
      : group.options.filter((option) => option.label.toLowerCase().includes(keyword));
    if (options.length) result.push({ ...group, options });
  }
  return result;
}

/**
 * 建立「指定處理人」可搜尋下拉選單（combobox）：輸入框即時過濾依部門分組的名單，可用滑鼠或鍵盤（上下鍵、Enter、Esc）選擇，
 * 選定的處理人 id 寫入隱藏欄位供表單送出；清除按鈕回到「不指定」。
 * 規則：輸入文字會清掉已選定的處理人；失焦時輸入框還原為已選定的帳號或空白；名單載入中或失敗時停用。
 * @param {object} nodes 頁面節點。
 * @param {HTMLInputElement} nodes.input 搜尋輸入框（role=combobox）。
 * @param {HTMLButtonElement} nodes.clear 清除指定按鈕。
 * @param {HTMLElement} nodes.listbox 選項清單（role=listbox）。
 * @param {HTMLInputElement} nodes.hidden 隱藏欄位，保存選定的處理人 id。
 * @param {object} [options={}] 設定。
 * @param {Function} [options.onChange] 選定或清除時呼叫，參數為選項（含 value、label、target）或 null。
 * @returns {object} 控制器：setState、clearSelection、open、close、value、enabled、selected。
 */
export function createHandlerPicker(nodes, { onChange } = {}) {
  const state = { groups: [], enabled: false, open: false, active: -1, items: [], selected: null };

  /**
   * 以目前狀態同步隱藏欄位、清除鈕與輸入框文字，並通知外部。
   * @param {object|null} option 選定的選項，null 代表不指定。
   * @returns {void}
   */
  function applySelection(option) {
    state.selected = option && option.value ? option : null;
    nodes.hidden.value = state.selected ? state.selected.value : '';
    nodes.input.value = state.selected ? state.selected.label : '';
    nodes.clear.hidden = !state.selected;
    onChange?.(state.selected);
  }

  /**
   * 標示鍵盤目前停留的選項並更新 aria-activedescendant，必要時捲到可見範圍。
   * @param {number} index 選項索引，-1 代表沒有。
   * @returns {void}
   */
  function setActive(index) {
    state.active = index;
    state.items.forEach((item, position) => item.node.classList.toggle('is-active', position === index));
    const current = state.items[index];
    if (current) {
      nodes.input.setAttribute('aria-activedescendant', current.node.id);
      current.node.scrollIntoView?.({ block: 'nearest' });
    } else nodes.input.removeAttribute('aria-activedescendant');
  }

  /**
   * 依關鍵字重建選項清單：關鍵字空白時第一項為「不指定」，沒有符合時顯示提示。
   * @param {string} query 關鍵字。
   * @returns {void}
   */
  function render(query) {
    const groups = filterHandlerGroups(state.groups, query);
    const children = [];
    state.items = [];
    /**
     * 建立一個可選項目並登記到 items。
     * @param {object} option 選項。
     * @param {string} className 額外樣式。
     * @returns {void}
     */
    function addOption(option, className) {
      const node = element('li', `picker-option${className ? ` ${className}` : ''}`, option.label);
      node.setAttribute('role', 'option');
      node.setAttribute('id', `handler-option-${state.items.length}`);
      node.setAttribute('aria-selected', String((state.selected?.value ?? '') === option.value));
      node.addEventListener('click', () => select(option));
      state.items.push({ node, option });
      children.push(node);
    }
    if (!String(query ?? '').trim()) addOption({ value: '', label: PICKER_TEXT.none, target: '' }, 'picker-none');
    for (const group of groups) {
      const heading = element('li', 'picker-group', group.label);
      heading.setAttribute('role', 'presentation');
      children.push(heading);
      for (const option of group.options) addOption(option, '');
    }
    if (!state.items.length) {
      const empty = element('li', 'picker-empty', PICKER_TEXT.noMatch);
      empty.setAttribute('role', 'presentation');
      children.push(empty);
    }
    nodes.listbox.replaceChildren(...children);
    setActive(-1);
  }

  /**
   * 開啟清單；已選定處理人時顯示完整名單，否則依輸入框文字過濾。
   * @returns {void}
   */
  function open() {
    if (!state.enabled) return;
    render(state.selected ? '' : nodes.input.value);
    nodes.listbox.hidden = false;
    nodes.input.setAttribute('aria-expanded', 'true');
    state.open = true;
  }

  /**
   * 關閉清單並清除鍵盤焦點標示。
   * @returns {void}
   */
  function close() {
    nodes.listbox.hidden = true;
    nodes.input.setAttribute('aria-expanded', 'false');
    state.open = false;
    setActive(-1);
  }

  /**
   * 選定一個選項（含「不指定」）後關閉清單，焦點留在輸入框。
   * @param {object} option 選項。
   * @returns {void}
   */
  function select(option) {
    applySelection(option);
    close();
  }

  /**
   * 回到「不指定」並清空輸入框；名單停用時只清空欄位不通知。
   * @returns {void}
   */
  function clearSelection() {
    if (state.enabled) applySelection(null);
    else { nodes.hidden.value = ''; nodes.input.value = ''; nodes.clear.hidden = true; }
    close();
  }

  /**
   * 輸入時清掉已選定的處理人並即時過濾清單。
   * @returns {void}
   */
  function handleInput() {
    if (state.selected) {
      state.selected = null;
      nodes.hidden.value = '';
      nodes.clear.hidden = true;
      onChange?.(null);
    }
    render(nodes.input.value);
    nodes.listbox.hidden = false;
    nodes.input.setAttribute('aria-expanded', 'true');
    state.open = true;
  }

  /**
   * 鍵盤操作：上下鍵移動、Enter 選取、Esc 關閉；清單開啟時 Enter 不會送出表單。
   * @param {KeyboardEvent} event 鍵盤事件。
   * @returns {void}
   */
  function handleKeydown(event) {
    if (!state.enabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!state.open) open();
      if (!state.items.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = state.active < 0 ? (step > 0 ? 0 : state.items.length - 1) : (state.active + step + state.items.length) % state.items.length;
      setActive(next);
      return;
    }
    if (event.key === 'Enter' && state.open) {
      event.preventDefault();
      if (state.active >= 0) select(state.items[state.active].option);
      else if (state.items.length === 1) select(state.items[0].option);
      return;
    }
    if (event.key === 'Escape' && state.open) {
      event.preventDefault();
      close();
      nodes.input.value = state.selected ? state.selected.label : '';
    }
  }

  /**
   * 焦點離開整個選單（不是移到清除鈕）時關閉清單，並把輸入框還原成已選定的帳號或空白。
   * @param {FocusEvent} event 焦點事件。
   * @returns {void}
   */
  function handleFocusOut(event) {
    const related = event.relatedTarget;
    if (related === nodes.input || related === nodes.clear) return;
    close();
    nodes.input.value = state.selected ? state.selected.label : '';
  }

  /**
   * 清單上按下滑鼠時阻止輸入框失焦，讓 click 能完成選取。
   * @param {Event} event 指標事件。
   * @returns {void}
   */
  function keepFocus(event) { event.preventDefault(); }

  /** 清除鈕：回到不指定並把焦點放回輸入框。@returns {void} */
  function handleClear() { clearSelection(); nodes.input.focus(); }
  /** 點擊輸入框時開啟清單。@returns {void} */
  function handleClick() { if (!state.open) open(); }

  /**
   * 依名單狀態設定選單：載入中與失敗時停用並顯示對應提示文字，成功時啟用並載入分組選項。
   * @param {'loading'|'ready'|'failed'} listState 名單狀態。
   * @param {string} placeholder 輸入框提示文字。
   * @param {Array<object>} [groups=[]] 成功時的分組選項。
   * @returns {void}
   */
  function setState(listState, placeholder, groups = []) {
    state.groups = listState === 'ready' ? groups : [];
    state.enabled = listState === 'ready';
    state.selected = null;
    nodes.hidden.value = '';
    nodes.input.value = '';
    nodes.input.placeholder = placeholder;
    nodes.input.disabled = !state.enabled;
    nodes.clear.hidden = true;
    close();
  }

  nodes.input.setAttribute('role', 'combobox');
  nodes.input.setAttribute('aria-expanded', 'false');
  nodes.input.setAttribute('aria-autocomplete', 'list');
  nodes.input.addEventListener('input', handleInput);
  nodes.input.addEventListener('keydown', handleKeydown);
  nodes.input.addEventListener('click', handleClick);
  nodes.input.addEventListener('focusout', handleFocusOut);
  nodes.listbox.addEventListener('pointerdown', keepFocus);
  nodes.clear.addEventListener('click', handleClear);
  nodes.clear.addEventListener('focusout', handleFocusOut);
  close();

  return {
    setState,
    clearSelection,
    open,
    close,
    /** 選定的處理人 id，未指定為空字串。@returns {string} id。 */
    get value() { return nodes.hidden.value; },
    /** 名單是否可用。@returns {boolean} 可用。 */
    get enabled() { return state.enabled; },
    /** 目前選定的選項。@returns {object|null} 選項。 */
    get selected() { return state.selected; },
  };
}
