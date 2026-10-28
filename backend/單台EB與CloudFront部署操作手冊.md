# 單台 EB 與 CloudFront 部署操作手冊

本專案統一 Node.js 22，只區分 local 與 production。不使用資料庫或 ALB；工作單以單一 JSON 檔儲存，用量與限流以單程序記憶體管理。此文件是操作步驟，不代表 AWS 資源已建立。

## 1. 架構與身分

```text
瀏覽器 → GitHub Pages（靜態前端）
       → CloudFront（API HTTPS，停用快取）
       → Elastic Beanstalk Single instance
       → Nginx → 單一 Node.js 22 程序
                    ├─ data/tickets.json
                    ├─ 記憶體保護計數
                    └─ Gemini API
```

AWS Console 使用既有 IAM user `alex.admin` 操作，不把 AWS 金鑰放進專案。IAM user 是操作者，不能直接選為 EB Service Role 或 EC2 Instance Profile；這兩個欄位仍須選擇合適的既有 IAM role／instance profile，缺少時需建立。應用程式沒有 AWS SDK 或資料庫權限需求，EC2 profile 只需平台運作所需權限，不應授予 admin 權限。

應用程式內另有 `alex.admin`，role 為 ADMIN、部門為 dept-it-1，使用 ADMIN_PASSWORD。它與 AWS IAM user 沒有整合關係，不使用 AWS 登入密碼。只有此應用程式角色能查看保護用量監測、清空目前環境的工作單及一般保護計數。

參考：[AWS 角色與使用者政策](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/concepts-roles.html)、[EC2 instance profile](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/iam-instanceprofile.html)。

## 2. 本機檢查

```bash
cd /Users/liweimac/helpdesk_agent
nvm install 22
nvm use 22
node --version
cd backend
npm ci
npm test
```

複製 `.env.example` 為未追蹤的 `.env`，私下設定兩個不同的 DEMO_PASSWORD、ADMIN_PASSWORD 及 Gemini 設定。第一次不要覆蓋既有 `.env`。本機預設 local，也可明確執行：

```bash
NODE_ENV=local npm start
```

Windows PowerShell：

```powershell
$env:NODE_ENV="local"
npm start
```

local 讀取 `.env`，shell 參數優先；production 完全不讀 `.env`。不要以本機模式啟動正式服務。已有環境如果設定其他模式或 LIMIT_STORE 非 memory，須先改掉舊平台參數。

前端使用 Node.js 22 執行測試，靜態伺服器仍以 Python 提供：

```bash
cd ../frontend
npm test
npm run dev
```

## 3. 建立 EB 環境

1. AWS 區域選東京 ap-northeast-1，進入 Elastic Beanstalk。
2. Application 建議命名 helpdesk-agent，建立 Web server environment。
3. 選 Node.js 22 running on Amazon Linux 2023，以及 **Single instance**；不要選 Load balanced。
4. 初次先部署 Sample application，排除 AWS 網路與角色問題。
5. Service access 選擇合適的 EB Service Role 與 EC2 Instance Profile，操作身分維持既有 alex.admin。
6. VPC 選既有 helpdesk-vpc；instance subnet 選已驗證的 public subnet A（ap-northeast-1a），啟用 public IPv4。subnet B 保留，不代表需要第二台 EC2。
7. 選適合預算的小型 On-Demand instance，建立前確認區域價格及帳號免費額度。不要建立 RDS、NAT Gateway 或 ALB。
8. 維持一台 EC2、一個 Node.js 程序，不使用 PM2 cluster。不使用額外 instance 的部署策略；平台仍可能在更新或故障時換機。
9. 等待環境健康並確認 Sample application 可開啟，再上傳專案。

EB 本身不加收服務費，但 EC2、公有 IPv4、EBS、CloudFront、日誌與網路仍可能產生費用。設定費用通知；通知不會自動停機。參考：[EB 費用](https://aws.amazon.com/elasticbeanstalk/pricing/)、[執行個體替換風險](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/using-features.managing.ec2.html)。

## 4. 正式環境變數與打包

在 EB Configuration 的 environment properties 設定：

| 參數 | 值／規則 |
| --- | --- |
| NODE_ENV | production |
| PORT | 5000 |
| GEMINI_API_KEY | 私下設定的有效金鑰 |
| GEMINI_MODEL | 本機已驗證可用的模型名稱 |
| DEMO_PASSWORD | 一般帳號登入密碼，私下設定 |
| ADMIN_PASSWORD | 獨立管理密碼，不能等於一般密碼 |
| AUTH_SECRET | 至少 32 bytes 的隨機秘密，更新部署時維持穩定 |
| CORS_ORIGIN | https://你的帳號.github.io；不包含 repo 路徑 |
| LIMIT_STORE | memory（也可省略） |
| LOG_LEVEL | info，排查時才改 debug |
| SHUTDOWN_TIMEOUT_MS | 75000；平台終止寬限應大於此值 |
| TICKETS_FILE | 留空沿用應用程式 data/tickets.json；改路徑不保證換機後保留 |
| ORIGIN_VERIFY_SECRET | 首次直接驗證 EB 可留空；CloudFront 完成後設定至少 32 bytes 的隨機秘密 |
| TRUST_PROXY | 首次直接驗證可留空；來源封鎖與 CloudFront 完成後，依第 6 節驗證代理鏈 |

沒有 LIMIT_TABLE 或資料庫區域設定需求。不要新增 AWS Access Key。Secrets 不能放進前端、README 或 Git。

確認修改已 commit 後，在專案根目錄打包：

```bash
git status --short
git archive --format=zip --output=/tmp/helpdesk-backend.zip HEAD:backend
unzip -l /tmp/helpdesk-backend.zip
```

git archive 只包含已提交版本，不包含未提交修改；它不會自動套用 .ebignore。檢查 ZIP 不含 `.env`、真實工作單、憑證或 node_modules，根目錄直接是 package.json、package-lock.json、Procfile、index.js 等，不可再多一層 backend。

在 EB Upload and deploy 上傳，version label 依序命名。先測 `http://<EB-domain>/api/health`，預期 200，`data.status` 為 ok。健康檢查不驗證 Gemini、不寫工作單。未配置 HTTPS 前只驗證健康端點，不輸入登入密碼。

## 5. 建立 CloudFront API distribution

此步驟在 AWS Console 手動執行，程式碼不會自動建立 distribution。

1. 開啟 CloudFront，建立 distribution，選自訂來源（custom origin）。
2. Origin domain 填 EB 環境的 DNS 名稱，不含 scheme、port、`/api`；不要填 EC2 IP，IP 可能變動。
3. Origin path 留空，否則 /api 可能重複。
4. 初次沒有來源憑證時只能選 HTTP only、port 80。這只加密「瀏覽器 → CloudFront」，**CloudFront → EB 仍為明文，不能宣稱全程 HTTPS**。此階段只使用假資料與測試密碼。要傳真實敏感資料前，需在單台 EC2 的 Nginx 為自己持有的來源網域配置有效公開 TLS 憑證，並將 origin 改成該網域、HTTPS only、443；憑證部署與續期需另行完成。本專案目前沒有配置來源憑證。
5. Viewer protocol policy 選 **HTTPS only**，避免 HTTP POST 被重導。
6. Allowed HTTP methods 選包含全部七種方法的組合（CloudFront 選單通常沒有只含 GET／POST／OPTIONS 的組合）；後端仍只提供 GET／POST／OPTIONS，其餘業務方法回 404。
7. Cache policy 選 **Managed-CachingDisabled**。不要快取登入、工作單、管理 API、OPTIONS 或錯誤結果。
8. Origin request policy 選 **Managed-AllViewerExceptHostHeader**，轉送 Authorization、Origin、預檢標頭、查詢參數等，讓 CloudFront 使用 EB 的 Host。只選一般 CORS policy 可能漏掉 Bearer。
9. Origin custom header 新增 `X-Origin-Verify`，值為私下產生的來源秘密；在 EB 設相同 ORIGIN_VERIFY_SECRET。CloudFront 會覆寫 viewer 同名標頭；不要讓前端傳這個秘密。
10. API 的 origin response timeout 建議 60 秒，確保可涵蓋 15 秒 AI 與管理維護等待；不設定會快取舊資料的 custom error response，適用的錯誤快取最短 TTL 設 0。
11. 可先用 CloudFront 自帶的 `https://<distribution>.cloudfront.net` 網域與預設憑證，無須立即購買網域。若改用 viewer 自訂網域，CloudFront 使用的 ACM 憑證需在 us-east-1。
12. 等待 distribution 部署完成，再測 health、登入、部門、工作單、管理重置及 CORS 預檢。

來源秘密不是加密機制；使用 HTTP origin 時，它也會經明文來源連線。不能以此取代上一節的來源 TLS。

參考：[CloudFront Authorization 轉送](https://repost.aws/knowledge-center/cloudfront-authorization-header)、[Managed origin request policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html)、[Origin custom headers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html)、[TLS 憑證要求](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)。

## 6. 來源防繞過與 IP 驗證

CloudFront 設好後，除了 ORIGIN_VERIFY_SECRET，還應把 EC2 的 HTTP／HTTPS 入站來源限制為 CloudFront origin-facing managed prefix list；只開實際使用的 port，不對全網開 Node.js 5000。不要移除 EC2 呼叫 Gemini 必要的出站路徑。若有其他管理連線需求，另外以最小範圍設定，不以開放所有入站解決。

預期代理鏈為 viewer → CloudFront → Nginx → Express。確認 EB Nginx 將來源資訊附加至 X-Forwarded-For、原始 viewer 位於右起第二跳，且所有 API 只接受自己 distribution 的來源秘密後，可設 TRUST_PROXY=2。**這個數字只適用已驗證的兩層鏈**；更換代理設定後需重驗，不直接設 true。

用兩個不同網路的瀏覽器／測試端確認 IP 限流各自計數；同一個學校 Wi-Fi 仍可能共用出口 IP，所以入口 IP 上限維持寬鬆，帳號用量依可信任 userID 隔離。沒有驗證代理鏈前，不可宣稱 IP 防護已驗收完成。直連 EB 的業務 API 應被 security group 或來源驗證拒絕，健康檢查不要求來源秘密。

參考：[CloudFront managed prefix list](https://docs.aws.amazon.com/vpc/latest/userguide/working-with-aws-managed-prefix-lists.html)、[CloudFront X-Forwarded-For 行為](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html)。

## 7. 前端及最終驗收

1. 修改 frontend/src/config.js 的 API_BASE_URL 為 CloudFront HTTPS origin，不含 /api。
2. GitHub Pages 發布 frontend，確認 EB CORS_ORIGIN 與實際前端 origin 相同；如果 Pages 有自訂網域就填該網域。
3. 一般帳號登入可送單與簽核；管理員登入到 admin/admin.html，可查看監測與執行重置。
4. 指定一般處理人驗證 JSON 寫檔，不呼叫 Gemini；指定 alex.admin 應回 400。
5. 不指定處理人驗證 AI 與額度，連續操作驗證 429、Retry-After。
6. 驗證管理員無法進工作單 API，一般帳號不能呼叫管理 API。
7. 只在測試環境或確認資料可刪除後，輸入 RESET_HELPDESK；結果顯示筆數，檔案與快取均為 []，一般額度與 HTTP 計數恢復。
8. 測試另一個請求仍在處理時重置，確認維護會等待，沒有舊工作單寫回；管理自己的限流不被重置。
9. 驗證 CloudFront 不快取不同帳號資料或 429，Authorization 與預檢可到後端；GET /api/admin/metrics 每次 observedAt 更新，畫面約每 5 秒顯示新快照，隱藏分頁停止輪詢。監測有獨立限流，不消耗一般查詢或管理重置額度。
10. 確認只有一台／一程序，並記錄目前 origin 是否已啟用 HTTPS。未配置來源 TLS、未驗證代理鏈或未完成資料備份時，應保留為待辦，不能當作已上線驗收。

## 8. JSON 生命週期與課堂重置

工作單只存在目前 instance，本次沒有匯出或備份 API。重要資料先透過受控方式備份，不提交 Git。EC2 替換、應用程式更新或手動重置都可能讓工作單消失；原始資料可能無法復原。多台或共享 EFS 檔案不會自動解決各程序的快取與競爭。

管理頁的清除會同時清空所有一般保護計數，是授權的課堂重置功能，會讓當日可用額度重新增加；不會退還 Gemini 已發生費用，也不會變更供應端配額。重啟同樣會重置記憶體計數。費用控制應另搭配供應端配額與 AWS 費用通知。

不應在伺服器執行中手動 rm 或覆寫 tickets.json，因為記憶體可能保有舊資料。管理維護會等待既有工作完成，成功清檔後再清計數；日誌只記錄操作者、清除筆數及時間。管理員看到連線失敗時應先確認實際結果，不自動重送。
