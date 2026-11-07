import { env } from '../config/env.js';
import { HttpError } from '../middleware/errorHandler.js';
import { accountService } from '../services/personnel/accountService.js';
import { taskTracker } from '../services/taskTracker.js';
import { departmentService } from '../services/departmentService.js';
import { draftAssistant } from '../services/ai/providers.js';
import { createDraftEngine, parseDraftRequest } from '../services/requestTypes/draftEngine.js';
import { getRequestTypes } from '../services/requestTypes/registry.js';
import { dataStore } from '../services/storage/dataStore.js';
import { usageService } from '../services/usageService.js';

export { AI_NOTICES } from '../services/requestTypes/draftEngine.js';

/**
 * 建立需求類型清單處理器（GET /api/forms）：回傳目錄中的全部需求類型（欄位、送達部門、計算項目名稱與簽核／轉單規則），不含 AI 專用文字；不呼叫 Gemini、不扣額度。
 * @param {object} [types] 需求類型目錄；省略時使用預設目錄（第一次請求時才取得，啟動時已驗證）。
 * @returns {Function} Express 處理器。
 */
export function createRequestTypesHandler(types) {
  /**
   * 回應 { types: [{ id, version, name, summary, department: { id, name } | null, fields, computed: [{ key, label, display }], workflow: { transfer, not_requester } }] }，
   * 每一項由 registry.forClient 產生；前端以 computed 為需求單的計算值加上名稱與格式，以 workflow 決定卡片是否顯示轉單與簽核按鈕。
   * @param {import('express').Request} req 已驗證請求。
   * @param {import('express').Response} res 回應。
   * @returns {void}
   */
  return function formsHandler(req, res) {
    const registry = types ?? getRequestTypes();
    res.json({ types: registry.list().map(/** 轉成前端形狀。@param {object} type 需求類型。@returns {object} 需求類型。 */ (type) => registry.forClient(type)) });
  };
}

/**
 * 建立「自動生成」對話處理器（POST /api/tickets/draft）：驗證請求後交給通用的需求類型引擎（draftEngine）處理，整次處理納入工作追蹤。
 * 引擎依需求類型定義判斷類型、部門、欄位、計算、檢查與渲染，AI 只提供建議；詳見 createDraftEngine。
 * @param {object} [options={}] 可注入的依賴。
 * @param {object} [options.types] 需求類型目錄；省略時使用預設目錄。
 * @param {object} [options.departments=departmentService] 部門查詢服務。
 * @param {object} [options.accounts=accountService] 帳號查詢服務。
 * @param {object} [options.store=dataStore] 需求單儲存。
 * @param {object} [options.usage=usageService] 配額服務（reserveDraft、releaseDraft）。
 * @param {object} [options.tasks=taskTracker] 工作追蹤器。
 * @param {{classify: Function, fill: Function}} [options.assistant=draftAssistant] AI 助手。
 * @param {object} [options.config=env] 設定（aiApiKey、aiFallbackProvider：主要供應商的金鑰與有金鑰的備援供應商，決定是否可用 AI）。
 * @param {Function} [options.clock=Date.now] 時間來源（台北今天）。
 * @returns {Function} Express 非同步處理器。
 */
export function createDraftHandler({ types, departments = departmentService, accounts = accountService, store = dataStore, usage = usageService, tasks = taskTracker,
  assistant = draftAssistant, config = env, clock = Date.now } = {}) {
  let engine;
  /**
   * 取得（第一次使用時建立）引擎，讓預設目錄延後到第一次請求才取得。
   * @returns {{run: Function}} 引擎。
   */
  function engineOf() {
    engine ??= createDraftEngine({ types: types ?? getRequestTypes(), departments, accounts, store, usage, assistant, config, clock });
    return engine;
  }
  /**
   * 處理一次自動生成請求。
   * @param {import('express').Request} req 已驗證請求。
   * @param {import('express').Response} res 回應。
   * @returns {Promise<void>}
   * @throws {HttpError} 401 未登入、400 欄位錯誤、503 儲存無法讀取。
   */
  async function draftHandler(req, res) {
    if (!req.user) throw new HttpError(401, 'UNAUTHORIZED', '請先登入');
    const request = parseDraftRequest(req.body, { types: types ?? getRequestTypes(), departments });
    res.json(await engineOf().run(req.user, request));
  }
  /**
   * 追蹤整次自動生成處理（含額度預扣、Gemini、工具與釋放租約），供關機與維護流程等待。
   * @param {import('express').Request} req 請求。
   * @param {import('express').Response} res 回應。
   * @returns {Promise<void>} 完整處理結果。
   */
  return function trackedDraftHandler(req, res) {
    /** 執行本次自動生成的完整生命週期。@returns {Promise<void>} 處理結果。 */
    function executeDraft() { return draftHandler(req, res); }
    return tasks.run(executeDraft);
  };
}

export const listRequestTypes = createRequestTypesHandler();
export const submitDraft = createDraftHandler();
