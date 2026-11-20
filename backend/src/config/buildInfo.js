// 部署版本資訊：由 deploy/hd build 以 Docker build-arg 寫入 image 的環境參數（HELPDESK_VERSION、HELPDESK_COMMIT、HELPDESK_BRANCH）。
// 本機 npm 啟動或手動 docker build 沒有帶這些參數時一律為 null，代表「未標記版本」；這些值不是秘密，會出現在啟動日誌與管理監測。

const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/**
 * 取出符合格式的字串；空白、未設定或格式不符時回 null，避免把任意文字輸出到日誌與管理頁。
 * @param {string|undefined} value 環境參數原值。
 * @param {RegExp} pattern 允許的格式。
 * @returns {string|null} 去除前後空白後的值，或 null。
 */
function pick(value, pattern) {
  const text = typeof value === 'string' ? value.trim() : '';
  return pattern.test(text) ? text : null;
}

/**
 * 讀取部署版本資訊。版本 tag 的格式為 `<branch>-<yyyy>.<mm>.<dd>.<當天第幾次 build>`（例如 main-2026.11.20.1），
 * commit 為完整 SHA（管理頁只顯示前 7 碼），branch 為建置時的分支名稱。
 * @param {object} [environment=process.env] 環境參數來源；測試可注入。
 * @returns {Readonly<{tag: string|null, commit: string|null, branch: string|null}>} 版本資訊，未標記時各欄為 null。
 */
export function loadBuildInfo(environment = process.env) {
  return Object.freeze({
    tag: pick(environment.HELPDESK_VERSION, TAG_PATTERN),
    commit: pick(environment.HELPDESK_COMMIT, COMMIT_PATTERN),
    branch: pick(environment.HELPDESK_BRANCH, BRANCH_PATTERN),
  });
}

export const buildInfo = loadBuildInfo();
