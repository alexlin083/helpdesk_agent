import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestEnv } from './helpers/testEnv.js';

setupTestEnv();
const { env } = await import('../src/config/env.js');
const { normalizeCalendar, workdaysBefore } = await import('../src/services/requestTypes/capabilities.js');
const { getRequestTypes, loadRequestTypes } = await import('../src/services/requestTypes/registry.js');
const { createDraftEngine, parseDraftRequest } = await import('../src/services/requestTypes/draftEngine.js');
const { evaluateForm } = await import('../src/services/requestTypes/evaluator.js');
const { approvalNotice, NOTIFIED_EVENT } = await import('../src/services/requestTypes/workflow.js');
const { createDecisionHandler } = await import('../src/controllers/ticketController.js');
const { departmentService } = await import('../src/services/departmentService.js');
const { accountService } = await import('../src/services/personnel/accountService.js');
const { createSqliteDataStore, dataStore } = await import('../src/services/storage/dataStore.js');
const { backupTicketDatabase, openTicketDatabase, restoreTicketDatabase } = await import('../src/services/storage/database.js');
const { createUsageService } = await import('../src/services/usageService.js');
const { createMemoryLimitStore } = await import('../src/services/storage/limitStore.js');
const { createTaskTracker } = await import('../src/services/taskTracker.js');
const { createAdminReset } = await import('../src/services/admin/adminService.js');

// 固定在台北 2026-11-01（週日）上午
const clock = /** 固定時間 @returns {number} epoch 毫秒 */ () => Date.UTC(2026, 10, 1, 2, 0);
const HR = departmentService.findDepartment('dept-hr-1');
const identity = /** 人資部的憑證身分 @param {string} username 帳號 @returns {object} 身分 */ (username) => ({ username, userID: `user-${username}`, role: 'USER', department: { id: HR.id, name: HR.name } });

/**
 * 改掉某個定義檔的內容再載入
 * @param {string} name 檔名
 * @param {(data: object) => void} change 修改方式
 * @returns {object} 需求類型目錄
 */
function withChange(name, change) {
  return loadRequestTypes({ read: /** 讀檔 @param {string|URL} file 檔案 @param {string} encoding 編碼 @returns {string} 內容 */ (file, encoding) => {
    const text = readFileSync(file, encoding);
    if (!String(file instanceof URL ? file.pathname : file).endsWith(name)) return text;
    const data = JSON.parse(text);
    change(data);
    return JSON.stringify(data);
  } });
}

test('工作日計數：從今天算到起點前一天，只算工作日、扣假日，數到上限就停', () => {
  const calendar = normalizeCalendar({ timezone_offset: '+08:00', work_windows: [['09:00', '18:00']], workdays: [1, 2, 3, 4, 5], holidays: { 2026: ['2026-11-03'] },
    unit_minutes: 1, min_minutes: 1, max_days: 14 }, 'test calendar');
  assert.equal(workdaysBefore(calendar, '2026-11-01', '2026-11-05', 10), 2, '週日不算、11/3 是假日，只剩 11/2、11/4');
  assert.equal(workdaysBefore(calendar, '2026-11-02', '2026-11-02', 10), 0, '當天不算提前');
  assert.equal(workdaysBefore(calendar, '2026-11-05', '2026-11-02', 10), 0, '起點早於今天時為 0');
  assert.equal(workdaysBefore(calendar, '2026-11-01', '2027-11-01', 3), 3, '夠了就停');
});

// notice_workdays 能力本身仍保留；請假定義 2026-11-16 起拿掉這個檢查（提早提出改成建議），這裡用測試加回的一筆驗證能力
const NOTICE_CHECK = Object.freeze({ capability: 'notice_workdays', on: ['draft', 'submit'], args: { start: 'start_at', category: 'leave_type', calendar: 'calendar' },
  min_workdays: 3, exempt: ['病假'], error: { code: 'TEST_NOTICE_TOO_LATE', message: '事假與特休要在請假日 3 個工作日前提出（測試）' } });

/**
 * 在請假定義加回提早提出的檢查再載入
 * @param {(check: object) => void} [change] 再修改加回的這一筆
 * @returns {object} 需求類型目錄
 */
function withNotice(change = /** 不改 @returns {void} */ () => {}) {
  return withChange('leave.json', /** 加回檢查 @param {object} data 定義 @returns {void} */ (data) => {
    const check = structuredClone(NOTICE_CHECK);
    change(check);
    data.checks.push(check);
  });
}

/** 是提早提出的檢查 @param {{capability: string}} check 檢查 @returns {boolean} 是時 true */
const isNotice = (check) => check.capability === 'notice_workdays';

test('請假定義：提早提出只是建議（沒有 notice_workdays）與核准通知（事假通知薪資系統）；加回 notice_workdays 時設定寫錯會啟動失敗', () => {
  const leave = getRequestTypes().find('leave');
  assert.equal(leave.checks.some(isNotice), false, '提早提出改成建議，請假定義不再擋');
  const notice = withNotice().find('leave').checks.find(isNotice);
  assert.deepEqual([notice.on, notice.notice.minWorkdays, notice.notice.exempt, notice.error.code], [['draft', 'submit'], 3, ['病假'], 'TEST_NOTICE_TOO_LATE']);
  assert.deepEqual(leave.workflow.notify, { target: '薪資系統', when: { field: 'leave_type', values: ['事假'] } });
  for (const id of getRequestTypes().ids().filter(/** 請假以外 @param {string} id 類型 id @returns {boolean} 是時 true */ (id) => id !== 'leave')) assert.equal(getRequestTypes().find(id).workflow.notify, null, `${id} 不通知`);
  assert.throws(() => withNotice(/** 改 0 @param {object} check 檢查 @returns {void} */ (check) => { check.min_workdays = 0; }), /leave\.json checks\[2\]\.min_workdays/);
  assert.throws(() => withNotice(/** 改 31 @param {object} check 檢查 @returns {void} */ (check) => { check.min_workdays = 31; }), /checks\[2\]\.min_workdays/);
  assert.throws(() => withNotice(/** 核准時檢查 @param {object} check 檢查 @returns {void} */ (check) => { check.on = ['submit', 'approve']; }), /checks\[2\]\.on 必須是 draft、submit 的非空子集/);
  assert.throws(() => withNotice(/** 不存在的類別 @param {object} check 檢查 @returns {void} */ (check) => { check.exempt = ['婚假']; }), /checks\[2\]\.exempt/);
  assert.throws(() => withNotice(/** 沒有工作日曆 @param {object} check 檢查 @returns {void} */ (check) => { check.args.calendar = 'nope'; }), /checks\[2\]\.args\.calendar/);
  assert.throws(() => withNotice(/** 類別不是 enum @param {object} check 檢查 @returns {void} */ (check) => { check.args.category = 'note'; }), /checks\[2\]\.args\.category/);
  assert.throws(() => withChange('leave.json', /** 通知對象空白 @param {object} data 定義 @returns {void} */ (data) => { data.workflow.notify.target = ' '; }), /leave\.json workflow\.notify\.target/);
  assert.throws(() => withChange('leave.json', /** 不存在的選項 @param {object} data 定義 @returns {void} */ (data) => { data.workflow.notify.when.values = ['婚假']; }), /workflow\.notify\.when\.values/);
  /** DEPARTMENT 單加一個 enum 欄位，再依它通知 @param {object} data 定義 @returns {void} */
  const byField = (data) => { data.fields.push({ key: 'urgency', label: '緊急程度', type: 'enum', options: ['一般', '緊急'], required: false }); data.workflow.notify = { target: '某系統', when: { field: 'urgency', values: ['緊急'] } }; };
  assert.throws(() => withChange('general.json', byField), /general\.json workflow\.notify\.when 只適用 FORM 單/, '欄位與選項都對，仍因為不是 FORM 單而拒絕');
  assert.equal(withChange('general.json', /** DEPARTMENT 單一律通知 @param {object} data 定義 @returns {void} */ (data) => { data.workflow.notify = { target: '某系統' }; }).find('general').workflow.notify.target, '某系統');
  assert.throws(() => withChange('leave.json', /** 拼錯頂層鍵 @param {object} data 定義 @returns {void} */ (data) => { data.calender = data.calendar; }), /leave\.json calender 是未知的鍵/, '未知鍵的檢查照舊');
});

test('提早提出：請假定義不擋隔天請假（事假、特休的自動生成與事假的送出都可以）；加回 notice_workdays 時，不到 3 個工作日擋、3 個工作日以上可以、病假不受限', async () => {
  const config = { ...env, aiApiKey: '' };
  /**
   * 手動編輯的驗證（不呼叫 AI），回傳起點欄位的錯誤
   * @param {object} types 需求類型目錄
   * @param {string} leaveType 假別
   * @param {string} day 日期 YYYY-MM-DD
   * @returns {Promise<object|undefined>} 錯誤
   */
  async function startError(types, leaveType, day) {
    const engine = createDraftEngine({ types, departments: departmentService, accounts: accountService, store: dataStore, usage: createUsageService({ store: createMemoryLimitStore(), config, clock }),
      assistant: {}, config, clock });
    const request = parseDraftRequest({ subject: '請假', state: { type_id: 'leave', department_id: 'dept-hr-1', fields: { leave_type: leaveType, start_at: `${day}T09:00`, end_at: `${day}T18:00` } } }, { types, departments: departmentService });
    const body = await engine.run(identity('emily.wu'), request);
    return body.invalid.find(/** 起點欄位的錯誤 @param {{key: string}} item 錯誤 @returns {boolean} 是時 true */ (item) => item.key === 'start_at');
  }
  /**
   * 送出階段的驗證失敗
   * @param {object} types 需求類型目錄
   * @param {string} day 日期 YYYY-MM-DD
   * @returns {Promise<Array<{code: string}>>} 失敗
   */
  async function submitFailures(types, day) {
    const fields = { leave_type: '事假', start_at: `${day}T09:00`, end_at: `${day}T18:00`, agent: '', note: '' };
    const result = await dataStore.withLedger(/** 送出階段的驗證 @param {object} helpers 交易內查詢 @returns {object} 結果 */ (helpers) => evaluateForm({ type: types.find('leave'), input: fields, user: identity('emily.wu'), department: HR,
      registry: types, accounts: accountService, departments: departmentService, helpers, today: '2026-11-01', phase: 'submit' }));
    return result.failures;
  }
  const types = getRequestTypes();
  assert.equal(await startError(types, '事假', '2026-11-02'), undefined, '11/1 週日提出、隔天 11/2 請事假不擋');
  assert.equal(await startError(types, '特休', '2026-11-02'), undefined, '特休也不擋');
  assert.deepEqual(await submitFailures(types, '2026-11-02'), [], '送出時也不擋');
  const strict = withNotice();
  assert.equal((await startError(strict, '事假', '2026-11-04'))?.message, '事假與特休要在請假日 3 個工作日前提出（測試）', '11/1 週日提出、11/4 請，只隔 11/2、11/3 兩個工作日');
  assert.equal(await startError(strict, '事假', '2026-11-05'), undefined, '隔 3 個工作日可以');
  assert.ok(await startError(strict, '特休', '2026-11-03'), '特休一樣要提前');
  assert.equal(await startError(strict, '病假', '2026-11-02'), undefined, '病假不受限');
  assert.ok((await submitFailures(strict, '2026-11-04')).some(/** 提前檢查 @param {{code: string}} item 失敗 @returns {boolean} 是時 true */ (item) => item.code === 'TEST_NOTICE_TOO_LATE'), '送出時也擋');
});

/**
 * 組出一張待簽核的請假單（直接寫進資料庫，模擬已送出）
 * @param {string} leaveType 假別
 * @returns {object} 需求單
 */
function pendingLeave(leaveType) {
  const now = new Date(clock()).toISOString();
  const fields = { applicant: 'emily.wu', leave_type: leaveType, start_at: '2026-12-01T09:00', end_at: '2026-12-01T18:00', agent: 'frank.liu', note: '' };
  return {
    ticket_id: `TK-test-${leaveType}-${Math.random().toString(36).slice(2, 10)}`, created_at: now, updated_at: now,
    requester: { user_id: 'user-emily.wu', username: 'emily.wu', department_id: HR.id, department_name: HR.name },
    subject: `請${leaveType}`, content: '測試', status: 'PENDING', decision: null, department_id: HR.id, department_name: HR.name,
    history: [{ at: now, event: 'SUBMITTED', by_user_id: 'user-emily.wu', by_username: 'emily.wu' }],
    form: { id: 'leave', version: 3, name: '請假申請', fields, computed: { minutes: 480 }, labels: {}, ledger: { category: leaveType, amount: 480, period: 2026, start: fields.start_at, end: fields.end_at } },
  };
}

/**
 * 呼叫簽核處理器
 * @param {object} store 資料存取
 * @param {string} id 單號
 * @param {'APPROVE'|'REJECT'} action 動作
 * @returns {Promise<object>} 更新後的需求單
 */
async function decide(store, id, action) {
  const handler = createDecisionHandler(store, getRequestTypes());
  const res = { body: null, /** 記錄標頭 @returns {object} 自己 */ set() { return this; }, /** 記錄回應 @param {object} body 回應 @returns {void} */ json(body) { this.body = body; } };
  await handler({ body: { action }, params: { id }, user: { ...identity('frank.liu'), userID: 'user-frank.liu' } }, res);
  return res.body.ticket;
}

/** 歷程裡的通知 @param {object} ticket 需求單 @returns {object[]} 通知 */
const noticesOf = (ticket) => ticket.history.filter(/** 是通知 @param {{event: string}} item 歷程 @returns {boolean} 是時 true */ (item) => item.event === NOTIFIED_EVENT);

test('核准時的模擬通知：事假核准寫一筆、由系統記錄；退回與病假不寫；不能重複核准、已有通知時不再寫；跟著資料庫備份還原，重置時一起清掉', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'helpdesk-notice-'));
  const file = join(scratch, 'helpdesk.db');
  const backup = join(scratch, 'helpdesk-backup.db');
  try {
    const store = createSqliteDataStore({ file });
    const personal = pendingLeave('事假');
    const sick = pendingLeave('病假');
    const rejected = pendingLeave('事假');
    for (const ticket of [personal, sick, rejected]) await store.insert(ticket);

    const approved = await decide(store, personal.ticket_id, 'APPROVE');
    assert.equal(approved.status, 'APPROVED');
    assert.deepEqual(approved.history.map(/** 事件 @param {{event: string}} item 歷程 @returns {string} 事件 */ (item) => item.event), ['SUBMITTED', 'APPROVED', NOTIFIED_EVENT]);
    const [notice] = noticesOf(approved);
    assert.deepEqual({ ...notice, at: undefined }, { at: undefined, event: 'NOTIFIED', by_user_id: 'system', by_username: 'system', target: '薪資系統', comment: '已通知薪資系統（模擬）', simulated: true }, '不冒用核准人、不寫金額或扣薪結論');
    assert.equal(notice.at, approved.decision.at, '和核准同一個時間、同一筆交易');
    assert.equal(noticesOf(await store.find(personal.ticket_id)).length, 1, '寫進資料庫');
    await assert.rejects(decide(store, personal.ticket_id, 'APPROVE'), { code: 'TICKET_ALREADY_DECIDED' }, '不能重複核准');
    assert.equal(noticesOf(await store.find(personal.ticket_id)).length, 1, '還是只有一筆');
    assert.equal(approvalNotice({ types: getRequestTypes(), ticket: await store.find(personal.ticket_id), now: 'x' }), null, '已有通知時不再寫');

    assert.equal(noticesOf(await decide(store, sick.ticket_id, 'APPROVE')).length, 0, '病假不通知');
    assert.equal(noticesOf(await decide(store, rejected.ticket_id, 'REJECT')).length, 0, '退回不通知');

    const reader = openTicketDatabase(file, { readonly: true });
    try { backupTicketDatabase(reader, backup); } finally { reader.close(); }
    await store.clear();
    assert.equal((await store.all()).length, 0, '備份後清掉，模擬資料遺失');
    store.close();
    restoreTicketDatabase(file, backup, '20261101-000000');
    const restored = createSqliteDataStore({ file });
    try {
      assert.equal(noticesOf(await restored.find(personal.ticket_id)).length, 1, '還原後通知還在');
      const reset = createAdminReset({ tickets: restored, limits: createMemoryLimitStore(), tasks: createTaskTracker(), resetRates: /** 不用清 HTTP 計數 @returns {Promise<void>} */ async () => {} });
      assert.equal((await reset({ userID: 'user-alex.admin' })).deletedTickets, 3);
      assert.equal((await restored.all()).length, 0, '重置時通知跟著需求單一起清掉');
    } finally { restored.close(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
