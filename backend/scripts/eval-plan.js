import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const DEFAULT_CASES = fileURLToPath(new URL('../evals/plan-cases.json', import.meta.url));
const USAGE = `用法（以後端的環境設定執行；兩家各自呼叫、不切換備援，需要 GEMINI_API_KEY 與 ANTHROPIC_API_KEY）：
  node scripts/eval-plan.js [--cases <題庫 JSON>] [--provider gemini|anthropic] [--repeat N] [--concurrency N] [--offline] [--json] [--out <結果檔>]
  --cases         題庫檔，預設 evals/plan-cases.json
  --provider      只跑指定的一家（不比較）；省略時兩家都跑並比較
  --repeat        每題執行幾輪（1～3，預設 1），用來看建議是否穩定
  --concurrency   同時跑幾件（1～4，預設 2）
  --offline       不呼叫 AI：把題庫的預期方案當成 AI 的方案，檢查題庫本身和後端規則是否一致（自動測試用這個模式）
  --json          輸出 JSON（統計與逐題結果），不輸出文字報告
  --out           另外把結果寫進這個檔案（檔案已存在就停，不覆蓋）；結果檔請放在 repo 以外，不要提交到 Git
  --verbose       在 stderr 顯示後端的錯誤日誌，預設不顯示
用後端規則判定每個方案能不能送、比較兩家的建議（不用 AI 評 AI）；每題用記憶體資料庫載入示範名冊、行事曆用替身，
不讀寫正式資料庫（就算環境設定指向正式資料庫也一樣）、不連 Google，輸出只會有示範名冊與替身行事曆的資料
每題每家是一回合「自動生成」：工具階段最多 5 次請求加整理 1 次，約 2～7 次 API 請求；預設 10 題 × 2 家 × 1 輪約 40～140 次，會用到兩家的 API 額度
最先完成的 3 件全部失敗時會停止評測，通常是金鑰、模型名稱或額度有問題`;

/**
 * 解析命令列參數並檢查範圍
 * @param {string[]} argv 命令列參數（不含 node 與腳本路徑）
 * @returns {{cases: string, provider: string|null, repeat: number, concurrency: number, offline: boolean, json: boolean, out: string|null, verbose: boolean}} 設定
 * @throws {Error} code USAGE：未知選項或數值超出範圍；help 時也拋出，以印出用法
 */
function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, strict: true, options: {
      cases: { type: 'string', default: DEFAULT_CASES }, provider: { type: 'string' }, repeat: { type: 'string', default: '1' }, concurrency: { type: 'string', default: '2' },
      offline: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, out: { type: 'string' }, verbose: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    } });
  } catch (error) {
    throw Object.assign(new Error(`參數錯誤：${error.message}`), { code: 'USAGE' });
  }
  const values = parsed.values;
  if (values.help) throw Object.assign(new Error(''), { code: 'USAGE' });
  /**
   * 解析範圍內的整數選項
   * @param {string} name 選項名稱
   * @param {number} min 下限
   * @param {number} max 上限
   * @returns {number} 數值
   * @throws {Error} code USAGE
   */
  const integer = (name, min, max) => {
    const value = Number(values[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw Object.assign(new Error(`--${name} 必須是 ${min}～${max} 的整數`), { code: 'USAGE' });
    return value;
  };
  const provider = values.provider?.trim().toLowerCase() || null;
  if (provider && !['gemini', 'anthropic'].includes(provider)) throw Object.assign(new Error('--provider 只接受 gemini 或 anthropic'), { code: 'USAGE' });
  if (values.out !== undefined && !values.out.trim()) throw Object.assign(new Error('--out 必須是檔案路徑'), { code: 'USAGE' });
  return { cases: values.cases, provider, repeat: integer('repeat', 1, 3), concurrency: integer('concurrency', 1, 4), offline: values.offline, json: values.json,
    out: values.out?.trim() || null, verbose: values.verbose };
}

/**
 * 決定一家的 AI 設定：只用這一家、不切換備援（才比得出兩家的差別）
 * @param {object} env 後端設定
 * @param {string} provider gemini 或 anthropic
 * @returns {object} 交給 createDraftAssistant 的設定
 */
function providerConfig(env, provider) {
  const anthropic = provider === 'anthropic';
  return { ...env, aiProvider: provider, aiApiKey: anthropic ? env.anthropicApiKey : env.geminiApiKey, aiModel: anthropic ? env.anthropicModel : env.geminiModel,
    aiKeyName: anthropic ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY', aiFallbackProvider: null };
}

/**
 * 主程式：載入題庫，依模式跑每題，輸出報告（--out 時另寫一份檔案）
 * 先把 LOG_LEVEL 設為 silent（--verbose 時為 error）、DATABASE_FILE 設為記憶體再載入後端模組，評測不會開到任何資料庫檔
 * 副作用：呼叫選定的 AI 供應商（非 --offline 時）、寫出到 stdout／stderr、--out 時寫一個新檔、設定 process.exitCode
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
  process.env.DATABASE_FILE = ':memory:';
  const { env } = await import('../src/config/env.js');
  const { getRequestTypes } = await import('../src/services/requestTypes/registry.js');
  const { createDraftAssistant } = await import('../src/services/ai/providers.js');
  const { demoUsernames, expectAssistant, formatPlanReport, loadPlanCases, runPlanEval, summarizePlanEval } = await import('./lib/planEval.js');

  const types = getRequestTypes();
  const plan = loadPlanCases(options.cases, { types, usernames: demoUsernames() });
  let providers;
  const models = {};
  if (options.offline) {
    providers = [{ name: 'offline', assistantFor: expectAssistant }];
  } else {
    const names = options.provider ? [options.provider] : ['gemini', 'anthropic'];
    const configs = names.map(/** 一家的設定 @param {string} name 供應商 @returns {object} 設定 */ (name) => providerConfig(env, name));
    const missing = configs.filter(/** 沒有金鑰 @param {{aiApiKey: string}} config 設定 @returns {boolean} 沒有時 true */ (config) => !config.aiApiKey);
    if (missing.length) {
      console.error(`沒有設定 ${missing.map(/** 金鑰名稱 @param {{aiKeyName: string}} config 設定 @returns {string} 名稱 */ (config) => config.aiKeyName).join('、')}，無法呼叫 AI；只有一家的金鑰時加 --provider，或先用 --offline 檢查題庫`);
      process.exitCode = 2;
      return;
    }
    providers = configs.map(/** 一家 @param {object} config 設定 @returns {object} 供應商 */ (config) => {
      models[config.aiProvider] = config.aiModel;
      const assistant = createDraftAssistant(config);
      return { name: config.aiProvider, assistantFor: /** 同一個助手 @returns {object} 助手 */ () => assistant };
    });
  }
  const results = await runPlanEval(plan, {
    providers, types, config: env, repeat: options.repeat, concurrency: options.concurrency,
    onProgress: /** 在 stderr 顯示進度 @param {number} done 已完成 @param {number} total 總數 @returns {void} */ (done, total) => { if (!options.json) process.stderr.write(`\r已完成 ${done}/${total}`); },
  });
  if (!options.json) process.stderr.write('\n');
  if (results.some(/** 被略過 @param {{error: object|null}} item 結果 @returns {boolean} 是時 true */ (item) => item.error?.reason === 'SKIPPED')) {
    console.error('最先完成的件數全部失敗，已停止評測；請確認金鑰、模型名稱與帳號額度，可加 --verbose 查看錯誤日誌');
  }
  const summary = summarizePlanEval(plan, results, providers.map(/** 名稱 @param {{name: string}} provider 供應商 @returns {string} 名稱 */ (provider) => provider.name));
  const meta = { mode: options.offline ? 'offline' : 'ai', models, cases: plan.cases.length, repeat: options.repeat, today: plan.today, data: '示範名冊與替身行事曆' };
  const output = options.json ? JSON.stringify({ meta, ...summary, results }, null, 2) : formatPlanReport(summary, meta);
  console.log(output);
  if (options.out) {
    try {
      writeFileSync(options.out, `${output}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      console.error(error.code === 'EEXIST' ? `${options.out} 已存在，不覆蓋；請換一個檔名` : `無法寫入 ${options.out}：${error.message}`);
      process.exitCode = 2;
      return;
    }
  }
  if (summary.expectMismatches.length || Object.values(summary.providers).some(/** 有失敗 @param {{errors: number}} stat 統計 @returns {boolean} 是時 true */ (stat) => stat.errors > 0)) process.exitCode = 1;
}

await main();
