import { initAdminReset } from './components/adminReset.js';
import { initAdminMonitoring } from './components/adminMonitoring.js';
import { authService } from './services/authService.js';
import { resetClassroom } from './services/adminService.js';
import { initAccountMenu } from './components/account.js';

/**
 * 組裝管理員頁面：先驗證登入與角色，再分別初始化唯讀監測與重置表單元件。
 * 重置互動與輪詢生命週期由元件負責，API 呼叫維持在獨立 service。
 * @param {Document} [doc=document] 頁面文件。
 * @param {Window} [win=window] 導頁與事件來源。
 * @param {object} [services={}] 可替換的登入及管理服務。
 * @param {object} [services.auth] 登入服務替身。
 * @param {Function} [services.resetClassroom] 重置服務替身。
 * @param {Function} [services.loadAdminMetrics] 唯讀監測服務替身。
 * @returns {object|null} 頁面事件處理器，未通過頁面身分檢查時為 null。
 */
export function initAdminPage(doc = document, win = window, services = {}) {
  const auth = services.auth ?? authService;
  const reset = services.resetClassroom ?? resetClassroom;
  const { user, leave } = initAccountMenu(doc, win, auth, { role: 'ADMIN' });
  if (!user) return null;
  const monitoring = initAdminMonitoring(doc, win, { auth, leave, load: services.loadAdminMetrics });
  const resetForm = initAdminReset(doc, { auth, reset, monitoring, leave });
  return { ...resetForm, monitoring };
}
if (typeof document !== 'undefined' && typeof document.readyState === 'string') initAdminPage();
