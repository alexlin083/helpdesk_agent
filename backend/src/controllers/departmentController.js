import { departmentService } from '../services/departmentService.js';
import { accountService } from '../services/personnel/accountService.js';

/**
 * 建立部門名單處理器；部門取自部門設定檔，每個部門的處理人（handlers）為該部門的登入帳號；不呼叫 Gemini、不扣額度
 * @param {object} [departments=departmentService] 部門查詢服務
 * @param {object} [accounts=accountService] 帳號查詢服務
 * @returns {Function} Express 處理器
 */
export function createDepartmentsHandler(departments = departmentService, accounts = accountService) {
  /**
   * 回傳部門與處理人名單（id、name、type、duty、business、handlers）
   * @param {import('express').Request} req 已驗證請求
   * @param {import('express').Response} res 回應
   * @returns {void}
   */
  return function departmentsHandler(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json({ departments: departments.list().map((department) => ({ ...department, handlers: accounts.handlersOf(department.id) })) });
  };
}

export const listDepartments = createDepartmentsHandler();
