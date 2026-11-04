import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const DEFAULT_CASES = fileURLToPath(new URL('../evals/classification-cases.json', import.meta.url));
const USAGE = `用法（以後端的環境設定執行，與服務相同：先用 AI_PROVIDER 的主要供應商（預設 gemini），回 429 額度或流量已滿時改用有金鑰的另一家）：
  node scripts/eval-classification.js [--cases <題庫 JSON>] [--provider gemini|anthropic] [--repeat N] [--concurrency N] [--department <部門 id>] [--min-accuracy 0～1] [--offline] [--json]
  --cases         題庫檔，預設 evals/classification-cases.json
  --provider      只用指定的供應商（不切換備援），用來比較兩家；需要該供應商的金鑰
  --repeat        每題執行幾輪（1～5，預設 1），用來看判斷是否穩定
  --concurrency   同時呼叫幾題（1～4，預設 2）
  --department    模擬提問者的所屬部門（預設 dept-legal-1；提問者部門會一起交給 AI）
  --min-accuracy  類型準確度低於這個值，或有題目呼叫失敗時，以結束碼 1 結束
  --offline       不呼叫 AI，只評測沒有 AI 時的關鍵字備援
  --json          輸出 JSON（統計與答錯的題目），不輸出文字報告
  --verbose       在 stderr 顯示後端的錯誤日誌（例如 Gemini 回 404 時的狀態碼），預設不顯示
最先完成的 3 題全部失敗時會停止評測，通常是金鑰、模型名稱或額度有問題。
每題直接呼叫 AI 一次（重試另計），會用到 API 額度，但不經過服務的每日自動生成額度，也不讀寫資料庫。`;

/**
 * 解析命令列參數並檢查範圍。
 * @param {string[]} argv 命令列參數（不含 node 與腳本路徑）。
 * @returns {{cases: string, provider: string|null, repeat: number, concurrency: number, department: string, minAccuracy: number|null, offline: boolean, json: boolean, verbose: boolean}} 設定。
 * @throws {Error} code USAGE：未知選項或數值超出範圍；help 時也拋出，以印出用法。
 */
function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, strict: true, options: {
      cases: { type: 'string', default: DEFAULT_CASES }, provider: { type: 'string' }, repeat: { type: 'string', default: '1' }, concurrency: { type: 'string', default: '2' },
      department: { type: 'string', default: 'dept-legal-1' }, 'min-accuracy': { type: 'string' },
      offline: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, verbose: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    } });
  } catch (error) {
    throw Object.assign(new Error(`參數錯誤：${error.message}`), { code: 'USAGE' });
  }
  const values = parsed.values;
  if (values.help) throw Object.assign(new Error(''), { code: 'USAGE' });
  /**
   * 解析範圍內的整數選項。
   * @param {string} name 選項名稱。
   * @param {number} min 下限。
   * @param {number} max 上限。
   * @returns {number} 數值。
   * @throws {Error} code USAGE。
   */
  const integer = (name, min, max) => {
    const value = Number(values[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw Object.assign(new Error(`--${name} 必須是 ${min}～${max} 的整數`), { code: 'USAGE' });
    return value;
  };
  let minAccuracy = null;
  if (values['min-accuracy'] !== undefined) {
    minAccuracy = Number(values['min-accuracy']);
    if (!Number.isFinite(minAccuracy) || minAccuracy < 0 || minAccuracy > 1) throw Object.assign(new Error('--min-accuracy 必須是 0～1 的數字'), { code: 'USAGE' });
  }
  const provider = values.provider?.trim().toLowerCase() || null;
  if (provider && !['gemini', 'anthropic'].includes(provider)) throw Object.assign(new Error('--provider 只接受 gemini 或 anthropic'), { code: 'USAGE' });
  return { cases: values.cases, provider, repeat: integer('repeat', 1, 5), concurrency: integer('concurrency', 1, 4), department: values.department, minAccuracy, offline: values.offline, json: values.json, verbose: values.verbose };
}

/**
 * 主程式：載入目錄與題庫，依模式評測，輸出報告；依 --min-accuracy 決定結束碼。
 * 先把 LOG_LEVEL 設為 silent（--verbose 時為 error）再載入後端模組（.env 不覆寫已設定的值），讓報告不夾雜服務日誌。
 * 副作用：呼叫選定的 AI 供應商（非 --offline 時）、寫出到 stdout／stderr、設定 process.exitCode。
 * @returns {Promise<void>}
 */
async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    if (error.code !== 'USAGE') throw error;
    if (error.message) console.error(error.message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  process.env.LOG_LEVEL = options.verbose ? 'error' : 'silent';
  const { env } = await import('../src/config/env.js');
  const { getRequestTypes } = await import('../src/services/requestTypes/registry.js');
  const { departmentService } = await import('../src/services/departmentService.js');
  const { classificationRequest } = await import('../src/services/requestTypes/draftEngine.js');
  const { createDraftAssistant } = await import('../src/services/ai/providers.js');
  const { localToday } = await import('../src/utils/dates.js');
  const { loadCases, keywordResults, runClassification, scoreResults, formatReport } = await import('./lib/classificationEval.js');

  const types = getRequestTypes();
  const cases = loadCases(options.cases, { types, departments: departmentService });
  const department = departmentService.findDepartment(options.department);
  if (!department) {
    console.error(`找不到部門 ${options.department}`);
    process.exitCode = 2;
    return;
  }
  const rounds = Array.from({ length: options.repeat }, () => cases).flat();
  const config = aiConfig(env, options.provider);
  let results;
  if (options.offline) {
    results = keywordResults(rounds, types);
  } else {
    if (!config.aiApiKey && !config.aiFallbackProvider) {
      console.error(`沒有設定 ${config.aiKeyName}（供應商 ${config.aiProvider}），無法呼叫 AI；可以先用 --offline 評測關鍵字備援`);
      process.exitCode = 2;
      return;
    }
    const assistant = createDraftAssistant(config);
    const user = { username: 'eval.user', department: { id: department.id, name: department.name } };
    const today = localToday(Date.now());
    results = await runClassification(rounds, {
      concurrency: options.concurrency,
      buildRequest: /** 組出與正式畫面相同的分類請求。@param {string} subject 主題。@returns {object} 請求。 */ (subject) => classificationRequest({ types, departments: departmentService, user, subject, today }),
      classify: /** 呼叫 AI 分類（有備援時依服務相同的規則切換）。@param {object} request 請求。@returns {Promise<object>} 結果。 */ (request) => assistant.classify(request),
      onProgress: /** 在 stderr 顯示進度。@param {number} done 已完成。@param {number} total 總數。@returns {void} */ (done, total) => {
        if (!options.json) process.stderr.write(`\r已完成 ${done}/${total}`);
      },
    });
    if (!options.json) process.stderr.write('\n');
    if (results.some(/** 是否被略過。@param {object} item 結果。@returns {boolean} 略過時 true。 */ (item) => item.error?.reason === 'SKIPPED')) {
      console.error(`最先完成的題目全部失敗，已停止評測。請確認 ${config.aiKeyName}、模型名稱（目前為 ${config.aiProvider} 的 ${config.aiModel}；名稱錯誤時回 404）與帳號額度，可加 --verbose 查看錯誤日誌`);
    }
  }
  const score = scoreResults(results, types);
  const fallback = config.aiFallbackProvider ? `（備援 ${config.aiFallbackProvider}/${config.aiFallbackProvider === 'anthropic' ? env.anthropicModel : env.geminiModel}）` : '';
  const meta = { mode: options.offline ? 'keywords' : 'ai', model: options.offline ? null : `${config.aiProvider}/${config.aiModel}${fallback}`, cases: cases.length, repeat: options.repeat, department: department.id };
  console.log(options.json ? JSON.stringify({ meta, ...score }, null, 2) : formatReport(score, meta, types));
  if (options.minAccuracy !== null && (score.errors > 0 || (score.typeAccuracy ?? 0) < options.minAccuracy)) process.exitCode = 1;
}

/**
 * 決定評測使用的 AI 設定：沒有指定 --provider 時與服務相同（主要供應商加上有金鑰的備援）；指定時只用該供應商、不切換備援。
 * @param {object} env 後端設定。
 * @param {string|null} provider --provider 的值。
 * @returns {object} 交給 createDraftAssistant 的設定（aiProvider、aiApiKey、aiModel、aiKeyName、aiFallbackProvider）。
 */
function aiConfig(env, provider) {
  if (!provider) return env;
  const anthropic = provider === 'anthropic';
  return { ...env, aiProvider: provider, aiApiKey: anthropic ? env.anthropicApiKey : env.geminiApiKey, aiModel: anthropic ? env.anthropicModel : env.geminiModel,
    aiKeyName: anthropic ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY', aiFallbackProvider: null };
}

await main();
