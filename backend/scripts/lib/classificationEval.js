// 「自動生成」第一回合分類的評測：讀取題庫、逐題呼叫分類、計算準確度與混淆。
// 不含任何需求類型的 id 或領域用語，類型與部門全部來自目錄與部門設定；不讀寫資料庫、不扣使用者額度。
import { readFileSync } from 'node:fs';

const SUBJECT_MAX = 100;
// 可重試的 AI 失敗原因（draftReason）；其他原因（例如回應格式異常）重試也不會改善，直接記錄。
const RETRYABLE = Object.freeze(['RATE_LIMIT_EXCEEDED', 'AI_TIMEOUT', 'AI_UPSTREAM_ERROR']);

/**
 * 建立題庫格式錯誤：訊息含題庫內的位置，方便直接修正 JSON。
 * @param {string} where 位置（例如 cases[3].type）。
 * @param {string} reason 原因。
 * @returns {Error} code 為 CASES_INVALID 的錯誤。
 */
function casesError(where, reason) {
  return Object.assign(new Error(`評測題庫 ${where} ${reason}`), { code: 'CASES_INVALID' });
}

/**
 * 驗證並整理題庫。規則：
 * - 頂層為 { version: 1, description?, cases: [...] }，cases 至少一題；
 * - 每題 subject 為去除首尾空白後 1～100 字的字串，且不重複；type 必須是目錄中的類型；
 * - 類型有固定部門時，department 可省略（預期部門即為固定部門），有寫就必須相同；類型由對話決定部門時 department 必填且必須存在；
 * - boundary 選填，必須是目錄中與 type 不同的類型，只用來分組報告，不影響是否答對。
 * @param {unknown} raw 解析後的題庫 JSON。
 * @param {object} services 查詢服務。
 * @param {object} services.types 需求類型目錄（find）。
 * @param {object} services.departments 部門查詢服務（findDepartment）。
 * @returns {Array<{subject: string, type: string, department: string, boundary: string|null}>} 整理後的題目（department 為預期送達部門）。
 * @throws {Error} code CASES_INVALID：格式不符，訊息含位置。
 */
export function parseCases(raw, { types, departments }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw casesError('頂層', '必須是物件');
  if (raw.version !== 1) throw casesError('version', '必須是 1');
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) throw casesError('cases', '必須是至少一題的陣列');
  const seen = new Set();
  return raw.cases.map(/** 驗證單題。@param {unknown} item 題目。@param {number} index 序號。@returns {object} 整理後的題目。 */ (item, index) => {
    const where = `cases[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw casesError(where, '必須是物件');
    const subject = typeof item.subject === 'string' ? item.subject.trim() : '';
    if (!subject || Array.from(subject).length > SUBJECT_MAX) throw casesError(`${where}.subject`, `必須是 1～${SUBJECT_MAX} 字的字串`);
    if (seen.has(subject)) throw casesError(`${where}.subject`, `與前面的題目重複：「${subject}」`);
    seen.add(subject);
    const type = typeof item.type === 'string' ? types.find(item.type) : null;
    if (!type) throw casesError(`${where}.type`, `找不到需求類型「${String(item.type)}」`);
    let department = type.departmentId;
    if (department) {
      if (item.department !== undefined && item.department !== department) throw casesError(`${where}.department`, `類型 ${type.id} 固定送達 ${department}，不能另外指定`);
    } else {
      if (typeof item.department !== 'string' || !departments.findDepartment(item.department)) throw casesError(`${where}.department`, `類型 ${type.id} 由對話決定部門，必須填寫存在的部門 id`);
      department = item.department;
    }
    let boundary = null;
    if (item.boundary !== undefined) {
      if (typeof item.boundary !== 'string' || !types.find(item.boundary) || item.boundary === type.id) throw casesError(`${where}.boundary`, '必須是目錄中另一個需求類型的 id');
      boundary = item.boundary;
    }
    return { subject, type: type.id, department, boundary };
  });
}

/**
 * 讀取並驗證題庫檔。
 * @param {string} file 題庫 JSON 的路徑。
 * @param {object} services 同 parseCases。
 * @returns {Array<object>} 整理後的題目。
 * @throws {Error} code CASES_INVALID：檔案無法讀取、不是 JSON 或格式不符。
 */
export function loadCases(file, services) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw casesError(file, `無法讀取或不是 JSON：${error.message}`);
  }
  return parseCases(raw, services);
}

/**
 * 沒有 AI 時的基準：每題以目錄的關鍵字備援（types.match）判斷類型，部門依備援規則（固定部門或未決定）。
 * @param {Array<object>} cases 整理後的題目。
 * @param {object} types 需求類型目錄（match）。
 * @returns {Array<{case: object, prediction: {typeId: string, departmentId: null, confidence: null}, error: null, attempts: number}>} 與 runClassification 相同形狀的結果（沒有信心分數）。
 */
export function keywordResults(cases, types) {
  return cases.map(/** 以關鍵字判斷一題。@param {object} item 題目。@returns {object} 結果。 */ (item) => ({
    case: item, prediction: { typeId: types.match(item.subject).id, departmentId: null, confidence: null }, error: null, attempts: 0,
  }));
}

/**
 * 逐題呼叫分類並收集結果。最多同時執行 concurrency 題；遇到可重試的失敗（限流、逾時、上游錯誤）時等待後重試，
 * 等待毫秒數為 (retryAfter 秒，沒有時 5 秒) × 1000 × 第幾次重試；重試用盡或不可重試的失敗記錄在 error，不中斷其他題目。
 * 例外：最先完成的 abortAfter 題全部失敗、一題都沒成功時（通常是金鑰或模型名稱錯誤），不再開始新的題目，
 * 尚未開始的題目記錄為 error.reason SKIPPED，避免每題都等待重試；已經在執行的題目照常完成。
 * @param {Array<object>} cases 整理後的題目（可重複，用於多輪評測）。
 * @param {object} options 設定。
 * @param {(subject: string) => object} options.buildRequest 依主題組出分類請求（classificationRequest）。
 * @param {(request: object) => Promise<object>} options.classify 分類函式（assistant.classify）。
 * @param {number} [options.concurrency=2] 同時執行的題數（至少 1）。
 * @param {number} [options.retries=2] 每題最多重試次數。
 * @param {(ms: number) => Promise<void>} [options.sleep] 等待函式（測試可替換）。
 * @param {(done: number, total: number) => void} [options.onProgress] 每完成一題呼叫一次（略過的題目不呼叫）。
 * @param {number} [options.abortAfter=3] 開頭連續失敗幾題就停止；0 表示不停止。
 * @returns {Promise<Array<{case: object, prediction: object|null, error: {reason: string, message: string}|null, attempts: number}>>} 與題目同順序的結果。
 */
export async function runClassification(cases, { buildRequest, classify, concurrency = 2, retries = 2, sleep = defaultSleep, onProgress = () => {}, abortAfter = 3 }) {
  const results = new Array(cases.length);
  let next = 0;
  let done = 0;
  let succeeded = 0;
  let failed = 0;
  /** 是否因開頭連續失敗而停止。@returns {boolean} 停止時 true。 */
  const aborted = () => abortAfter > 0 && succeeded === 0 && failed >= abortAfter;
  /**
   * 以重試規則判斷一題。
   * @param {object} item 題目。
   * @returns {Promise<object>} 結果。
   */
  async function judge(item) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const prediction = await classify(buildRequest(item.subject));
        return { case: item, prediction, error: null, attempts: attempt };
      } catch (error) {
        const reason = error?.draftReason ?? error?.code ?? 'UNKNOWN';
        if (!RETRYABLE.includes(reason) || attempt > retries) return { case: item, prediction: null, error: { reason, message: String(error?.message ?? error) }, attempts: attempt };
        await sleep((error?.retryAfter ?? 5) * 1000 * attempt);
      }
    }
  }
  /**
   * 工作者：依序取下一題，直到題目用完或因開頭連續失敗而停止。
   * @returns {Promise<void>}
   */
  async function worker() {
    while (next < cases.length && !aborted()) {
      const index = next;
      next += 1;
      results[index] = await judge(cases[index]);
      if (results[index].prediction) succeeded += 1; else failed += 1;
      done += 1;
      onProgress(done, cases.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, cases.length)) }, worker));
  for (let index = next; index < cases.length; index += 1) {
    results[index] = { case: cases[index], prediction: null, error: { reason: 'SKIPPED', message: `最先完成的 ${abortAfter} 題全部失敗，停止評測` }, attempts: 0 };
  }
  return results;
}

/**
 * 預設等待函式。
 * @param {number} ms 毫秒數。
 * @returns {Promise<void>} 時間到時完成。
 */
function defaultSleep(ms) {
  return new Promise(/** 設定計時器。@param {Function} resolve 完成。@returns {void} */ (resolve) => { setTimeout(resolve, ms); });
}

/**
 * 依正式畫面的規則決定實際採用的部門：判斷出的類型有固定部門時一律是它（AI 的部門判斷不採用）；
 * 由對話決定部門時，AI 信心分數達到該類型的 min_confidence 才採用，否則為 null（畫面上改由使用者選擇）。
 * @param {object|null} type 判斷出的類型。
 * @param {{departmentId: string|null, confidence: number}} prediction 分類結果。
 * @returns {string|null} 採用的部門 id。
 */
function adoptedDepartment(type, prediction) {
  if (!type) return null;
  if (type.departmentId) return type.departmentId;
  return prediction.departmentId && prediction.confidence >= type.departmentChoice.minConfidence ? prediction.departmentId : null;
}

/**
 * 計算評測結果：
 * - 類型準確度 = 判斷出的類型正確的題數 ÷ 有回應的題數；失敗（error）另計，不算答錯；
 * - 部門準確度 = 依正式畫面規則採用的部門（adoptedDepartment）等於預期部門的題數 ÷ 有回應的題數；
 *   pendingDepartment 為類型正確但信心不足、要由使用者選部門的題數（不算答對）；
 * - 每個類型的召回率（該類型的題目判斷正確的比例）與精確率（判斷成該類型的題目真的屬於它的比例），沒有分母時為 null；
 * - 混淆：預期 → 實際的類型配對與次數（只列答錯的），依次數由多到少；
 * - 邊界題：有標 boundary 的題目另計類型準確度；
 * - 不穩定：同一主題在多輪中判斷出不只一種類型；
 * - models：各模型回答的題數（有備援時可看出有多少題改由備援回答；關鍵字備援沒有模型，為空物件）。
 * @param {Array<object>} results runClassification 或 keywordResults 的結果。
 * @param {object} types 需求類型目錄（find、ids）。
 * @returns {object} 統計：total、answered、errors、typeCorrect、typeAccuracy、departmentCorrect、departmentAccuracy、pendingDepartment、models、
 *   perType、confusions、boundary、unstable、failures（答錯或失敗的題目）。
 */
export function scoreResults(results, types) {
  const answered = results.filter(/** 有回應。@param {object} item 結果。@returns {boolean} 有回應時 true。 */ (item) => item.prediction);
  const perType = Object.fromEntries(types.ids().map(/** 初始化。@param {string} id 類型。@returns {[string, object]} 計數。 */ (id) => [id, { expected: 0, correct: 0, predicted: 0 }]));
  const confusionCounts = new Map();
  const boundary = { total: 0, correct: 0 };
  const predictionsBySubject = new Map();
  const models = {};
  const failures = [];
  let typeCorrect = 0;
  let departmentCorrect = 0;
  let pendingDepartment = 0;
  for (const item of results) {
    const expected = item.case;
    if (!item.prediction) {
      failures.push({ subject: expected.subject, expectedType: expected.type, actualType: null, expectedDepartment: expected.department, actualDepartment: null, error: item.error });
      continue;
    }
    if (item.prediction.model) models[item.prediction.model] = (models[item.prediction.model] ?? 0) + 1;
    const actualType = item.prediction.typeId ?? null;
    const type = actualType ? types.find(actualType) : null;
    const department = adoptedDepartment(type, item.prediction);
    const typeOk = actualType === expected.type;
    const departmentOk = department === expected.department;
    perType[expected.type].expected += 1;
    if (actualType && perType[actualType]) perType[actualType].predicted += 1;
    if (typeOk) { typeCorrect += 1; perType[expected.type].correct += 1; }
    if (departmentOk) departmentCorrect += 1;
    if (typeOk && !department) pendingDepartment += 1;
    if (!typeOk) {
      const key = `${expected.type}→${actualType ?? 'null'}`;
      confusionCounts.set(key, (confusionCounts.get(key) ?? 0) + 1);
    }
    if (expected.boundary) { boundary.total += 1; if (typeOk) boundary.correct += 1; }
    const seen = predictionsBySubject.get(expected.subject) ?? new Set();
    seen.add(actualType);
    predictionsBySubject.set(expected.subject, seen);
    if (!typeOk || !departmentOk) {
      failures.push({ subject: expected.subject, expectedType: expected.type, actualType, expectedDepartment: expected.department, actualDepartment: department,
        confidence: item.prediction.confidence, error: null });
    }
  }
  /** 比例（沒有分母時 null）。@param {number} part 分子。@param {number} whole 分母。@returns {number|null} 比例。 */
  const ratio = (part, whole) => (whole ? part / whole : null);
  return {
    total: results.length,
    answered: answered.length,
    errors: results.length - answered.length,
    typeCorrect,
    typeAccuracy: ratio(typeCorrect, answered.length),
    departmentCorrect,
    departmentAccuracy: ratio(departmentCorrect, answered.length),
    pendingDepartment,
    models,
    perType: Object.fromEntries(Object.entries(perType).map(/** 加上比例。@param {[string, object]} entry 計數。@returns {[string, object]} 統計。 */ ([id, count]) => [id, {
      ...count, recall: ratio(count.correct, count.expected), precision: ratio(count.correct, count.predicted),
    }])),
    confusions: [...confusionCounts].map(/** 拆出配對。@param {[string, number]} entry 計數。@returns {object} 配對。 */ ([key, count]) => {
      const [expected, actual] = key.split('→');
      return { expected, actual: actual === 'null' ? null : actual, count };
    }).sort(/** 次數多的在前。@param {object} a 配對。@param {object} b 配對。@returns {number} 排序值。 */ (a, b) => b.count - a.count || a.expected.localeCompare(b.expected)),
    boundary: { ...boundary, accuracy: ratio(boundary.correct, boundary.total) },
    unstable: [...predictionsBySubject].filter(/** 多種判斷。@param {[string, Set]} entry 主題與判斷。@returns {boolean} 不只一種時 true。 */ ([, seen]) => seen.size > 1)
      .map(/** 轉成陣列。@param {[string, Set]} entry 主題與判斷。@returns {object} 不穩定題目。 */ ([subject, seen]) => ({ subject, types: [...seen] })),
    failures,
  };
}

/**
 * 把比例轉成百分比文字（一位小數），沒有分母時為「-」。
 * @param {number|null} value 比例。
 * @returns {string} 百分比文字。
 */
function percent(value) {
  return value === null ? '-' : `${(value * 100).toFixed(1)}%`;
}

/**
 * 產生給人看的繁體中文報告（純文字）。
 * @param {object} score scoreResults 的結果。
 * @param {object} meta 評測資訊。
 * @param {string} meta.mode 'ai'（呼叫 AI）或 'keywords'（關鍵字備援）。
 * @param {string} [meta.model] 供應商與模型名稱（例如 anthropic/claude-sonnet-5-5）。
 * @param {number} meta.cases 題目數。
 * @param {number} meta.repeat 輪數。
 * @param {object} types 需求類型目錄（find，用來顯示類型名稱）。
 * @returns {string} 報告。
 */
export function formatReport(score, meta, types) {
  /** 類型名稱。@param {string|null} id 類型。@returns {string} 名稱。 */
  const name = (id) => (id ? `${types.find(id)?.name ?? id}（${id}）` : '（沒有判斷）');
  const lines = [
    `分類評測：${meta.mode === 'ai' ? `AI ${meta.model ?? ''}`.trim() : '關鍵字備援（不呼叫 AI）'}，${meta.cases} 題 × ${meta.repeat} 輪`,
    `類型準確度：${percent(score.typeAccuracy)}（${score.typeCorrect}/${score.answered}）`,
    `部門準確度：${percent(score.departmentAccuracy)}（${score.departmentCorrect}/${score.answered}；類型正確但信心不足、要由使用者選部門：${score.pendingDepartment}）`,
    `邊界題類型準確度：${percent(score.boundary.accuracy)}（${score.boundary.correct}/${score.boundary.total}）`,
    `呼叫失敗：${score.errors} 題`,
    ...(Object.keys(score.models).length ? [`回答的模型：${Object.entries(score.models).map(/** 一個模型。@param {[string, number]} entry 模型與題數。@returns {string} 文字。 */ ([model, count]) => `${model} ${count} 題`).join('、')}`] : []),
    '',
    '各類型（召回率＝該類型的題目答對比例；精確率＝判斷成該類型的題目真的屬於它的比例）：',
    ...Object.entries(score.perType).map(/** 一列類型統計。@param {[string, object]} entry 統計。@returns {string} 文字。 */ ([id, stat]) =>
      `  ${name(id)}：召回率 ${percent(stat.recall)}（${stat.correct}/${stat.expected}），精確率 ${percent(stat.precision)}（${stat.correct}/${stat.predicted}）`),
  ];
  if (score.confusions.length) {
    lines.push('', '最常混淆（預期 → 實際）：', ...score.confusions.map(/** 一列混淆。@param {object} item 配對。@returns {string} 文字。 */ (item) => `  ${name(item.expected)} → ${name(item.actual)}：${item.count} 次`));
  }
  if (score.unstable.length) {
    lines.push('', '多輪結果不一致：', ...score.unstable.map(/** 一列不穩定題目。@param {object} item 題目。@returns {string} 文字。 */ (item) => `  「${item.subject}」：${item.types.map(name).join('、')}`));
  }
  if (score.failures.length) {
    lines.push('', '答錯或失敗的題目：', ...score.failures.map(/** 一列失敗題目。@param {object} item 題目。@returns {string} 文字。 */ (item) => {
      if (item.error) return `  「${item.subject}」：呼叫失敗（${item.error.reason}）`;
      const typePart = item.actualType === item.expectedType ? `類型正確（${item.actualType}）` : `類型 ${item.expectedType} → ${item.actualType ?? 'null'}`;
      const confidence = typeof item.confidence === 'number' ? `（信心 ${item.confidence}）` : '';
      const departmentPart = item.actualDepartment === item.expectedDepartment ? '' : `，部門 ${item.expectedDepartment} → ${item.actualDepartment ?? '未決定'}${confidence}`;
      return `  「${item.subject}」：${typePart}${departmentPart}`;
    }));
  }
  return lines.join('\n');
}
