# Docker 與 Lightsail 部署操作手冊

本專案目前採用「單台 AWS Lightsail Linux 主機＋Docker Compose＋Caddy」；前後端使用同一個 HTTPS 網址，不需要 GitHub Pages、Elastic Beanstalk、CloudFront、ALB 或另外的資料庫服務；Docker 本機驗證可先用 HTTP，前後端分開啟動的 local 方式（各自 `npm run dev`）仍保留，後端仍只設定單一 CORS_ORIGIN

## 1. 先理解各元件

```text
瀏覽器 → Caddy（80／443；/helpdesk/ 前端、HTTPS、/helpdesk/api/ 代理）
                ├─ HTML、CSS、JavaScript
                └─ backend:3000（Docker 內部，未發布主機 port）
                       ├─ 單一 Node.js 22.23.4 程序（內嵌 SQLite）
                       └─ /app/storage/helpdesk.db → tickets volume
```

Caddy 提供 HTML／CSS／JS 與 /helpdesk/ 網站，並把 /helpdesk/api 轉送後端；只移除 /helpdesk 前綴，保留內部的 /api（路徑規則見第 5.1 節）；後端各模組的職責見 [backend/README.md](../backend/README.md)「架構」，AI 供應商與備援見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md) 第 1 節，資料庫內容與舊版 tickets.json 的匯入規則見規格書第 3.4 節

| 檔案／元件 | 用途與理由 |
| --- | --- |
| `backend/Dockerfile` | 以 `node:22.23.4-bookworm-slim` 建置，固定 Node.js 22.23.4（better-sqlite3 13 需 22.14 以上）；只複製 `package.json`、`package-lock.json`（以 `npm ci --omit=dev` 依 lockfile 安裝正式相依，SQLite 原生驅動以 node-gyp 編譯，建置期間安裝 Python、make 與 g++，完成後移除建置工具）、`src/`、`scripts/`、`data/departments.json`（部門）、整個 `data/requestTypes/` 資料夾（需求類型目錄 `_catalog.json` 與 `leave.json`、`equipment.json`、`general.json` 等定義檔）與 `docker-healthcheck.js`，並於建置時載入 better-sqlite3 確認原生模組可用；部門與需求類型的啟動驗證見[需求類型與 AI 資料來源規範](需求類型與AI資料來源規範.md)第 2 節；新增或修改需求類型只改 JSON 並重新建置 backend image（第 5.9 節）；人員資料（帳號、部門、員工與額度）不在 image 內，只存在 volume 的資料庫；以非 root 的 node 帳號用 `node src/index.js` 直接啟動（不經 npm），直接接收 SIGTERM 並交給優雅關機流程 |
| `backend/.dockerignore` | 排除 `.env`、測試、Markdown，以及 `data/` 內的資料庫、還原保留檔、匯出與舊版 JSON 檔 |
| `backend/docker-healthcheck.js` | 檢查本容器 /api/health，不登入、不寫單、不呼叫 AI |
| `deploy/web.Dockerfile` | 以 `caddy:2-alpine` 為基底，將網站資產（`frontend/index.html`、`frontend/styles/`、`frontend/pages/`、`frontend/src/`）與 Caddy 設定包成另一個 image，不含 README、測試、後端檔案或 .env，沒有前端建置工具需求 |
| `deploy/Caddyfile` | /helpdesk/ 靜態網站與 /helpdesk/api/ 代理；正式網域可自動申請、更新 HTTPS 憑證 |
| `compose.yaml` | 定義兩個服務、內部網路、資料 volume、健康等待、日誌輪替、停止寬限；容器使用 `init: true`、`stop_grace_period: 90s`，web 在 backend 健康檢查通過後才啟動 |

Compose 是一次管理兩個容器，不是把所有程式塞進同一個容器；前端 service、component 與 API 合約維持既有分工；資料與程式 image 分離，更新程式不必清除工作單

`backend/scripts/` 的維運腳本已複製進 image，各腳本用法見 [backend/README.md](../backend/README.md)「維運腳本」；本文只列部署主機上的操作步驟

並行存取設計（已實作）：前端不直接接觸 SQLite，所有讀寫都經後端 HTTP API，進入單一後端程序持有的唯一資料庫連線（ticketStore 單例）；資料庫使用 WAL 模式，維護腳本 `db-backup.js`、`export-tickets-json.js` 另開唯讀連線，可在服務執行中同時讀取而不阻擋 API；`db-restore.js` 必須先停止後端；不支援多副本或 PM2 cluster；多個程序不會共用資料，交易與寫入者的設計見規格書第 3.4 節

## 2. 第一階段：在 Mac 驗證

### 2.1 啟動 Docker Desktop

先開 Docker Desktop，等待 Engine 啟動，再於 Mac 終端機執行：

```bash
cd /Users/liweimac/helpdesk_agent
docker version
docker compose version
```

`docker version` 應同時有 Client 與 Server。只有 Client 或出現 cannot connect，表示 Engine 尚未就緒；Compose 使用 `docker compose`，不是舊版 `docker-compose`。

### 2.2 建立 Docker 專用環境檔

確認根目錄沒有既有 `.env` 後再複製，避免覆蓋設定：

```bash
cp -n .env.example .env
chmod 600 .env
```

用編輯器開啟根目錄 `.env`，私下填入兩組不同的 `DEMO_PASSWORD`、`ADMIN_PASSWORD`；不要把密碼或金鑰貼進 README、Git、截圖或聊天

範本已預填本機值（`NODE_ENV=local`、`SITE_ADDRESS=http://localhost`、`CORS_ORIGIN=http://localhost:8080`、8080／8443 只綁定 127.0.0.1），本機通常只需填密碼；各參數的意義、預設值與寫法見 [backend/README.md](../backend/README.md)「啟動」與「正式環境與部署」，登入密碼、AUTH_SECRET、AI 供應商、模型與「自動生成」額度的規則見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md) 第 1、2 節

可在私人的終端機產生 AUTH_SECRET，再存入未追蹤的 `.env`；指令輸出不要分享：

```bash
openssl rand -hex 32
```

Compose 的參數來源是專案根目錄未追蹤的 `.env`（或 `HELPDESK_ENV_FILE` 指定的檔案），與 `backend/.env` 分開；`NODE_ENV` 與 `CORS_ORIGIN` 只由這個 env_file 提供，`compose.yaml` 不再另外設定或提供預設值（`environment` 會蓋過 env_file）：缺少 `NODE_ENV` 時後端以 local 執行，缺少 `CORS_ORIGIN` 時 local 預設 http://localhost:5173、production 拒絕啟動；Compose 固定、寫在 `.env` 也會被覆蓋的項目見第 4.4 節

不用 Docker、改以 npm 啟動後端的方式見 [README](../README.md)「本機啟動」

### 2.3 檢查、建立及啟動

```bash
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
curl --fail http://localhost:8080/helpdesk/api/health
```

`config --quiet` 檢查 Compose 語法，不印出展開後的秘密。不要把一般 `docker compose config`、容器環境或 inspect 完整結果貼給他人。

第一次建立會下載 Node 與 Caddy image、安裝 npm 依賴，時間較長。`--wait` 等後端健康後才完成；預期 backend 為 healthy、web 為 running，health 回傳：

```json
{"success":true,"data":{"status":"ok"}}
```

後端在監聽前會開啟資料庫，開啟失敗會記錄 `storage.failed` 並以結束碼 1 結束，不會變成 healthy，容器會反覆重啟；此時依 `storage.failed` 的 reason 排查（第 8 節）；在正式主機上急需恢復服務時，可先回滾 image（第 5.5 節，backend 與 web 一起換回）再排查；healthcheck 不會自動重啟卡住但未退出的程序；restart policy 只處理程序結束或主機重啟等情況；健康端點能證明的範圍見 [backend/README.md](../backend/README.md)「正式環境與部署」

瀏覽器開啟 **http://localhost:8080/helpdesk/**（登入頁）；登入後的頁面網址與其他本機啟動方式見 [README](../README.md)「本機啟動」

### 2.4 功能驗收

1. 一般帳號登入，輸入主題（例如「座位調整」）按「自動生成」，在右側欄位選處理部門、填寫需求說明，「Apply 套用」後送出，確認成功、查詢得到（畫面行為見[API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.18 節）
2. 重新建立後端容器：`docker compose up -d --force-recreate --wait backend`，重新整理查詢，工作單應保留，登入仍有效（重建後登入狀態與記憶體限量的行為見規格書第 2.1、2.2 節）
3. 設定有效的 Gemini 金鑰後，以「自動生成」用一句話描述需求，確認 AI 判斷需求類型與處理部門並填入欄位（後端日誌 `ticket.draft.evaluated`）；這一步會使用自動生成額度並可能產生模型費用；AI 判斷部門的送單路徑要另外驗證：以 API 用戶端送出不帶 `form`、`department_id`、`handler_id` 的 `POST /api/tickets`
4. alex.admin 登入管理頁，確認監測能更新，「待簽核需求單」卡片與「需求單資料庫」區塊顯示筆數、結構版本（3）與檔案大小；清除測試工作單前確認資料可刪，再完整輸入確認文字操作。
5. 一般使用者不能呼叫管理 API；管理員不能進入工作單 API。
6. 請假（不需要 AI 金鑰也能驗證）：以 racky.huang 輸入主題「請假」按「自動生成」，第一則訊息應說明由人資部處理並列出需要的資料；在右側欄位（窄畫面為下方）選假別、填一段 2026 或 2027 年的平日上班時間（其他年度尚未開放）、代理人選 kevin.ho，確認面板列出請假時數，以及該假別剩餘時數的「前 → 後」（例如「特休剩餘時數：112 小時 0 分鐘 → 105 小時 0 分鐘」），「Apply 套用」後送出，結果為「依表單規則送達」人力資源部；再以 emily.wu 或 frank.liu 登入簽核；有金鑰時另用一句話描述請假內容（例如問「代理人可以選誰」），確認 AI 會填入欄位並查詢同事；這一步會使用自動生成額度並可能產生模型費用
7. 設備申請（同樣不需要金鑰；已設定金鑰時先暫時拿掉）：以 racky.huang 輸入含關鍵字的主題「申請螢幕」按「自動生成」，確認處理部門為唯讀的總務與硬體組、招呼語正確；在右側欄位把數量填 0 或超過 50、需要日期填過去的日期（例如昨天），應出現「格式不符」與對應的正確訊息；改正後「Apply 套用」送出，結果為「依表單規則送達」總務與硬體組（視窗不顯示需求內容預覽，不必確認預覽）；人資帳號的狀態追蹤頁看不到這張單；以總務與硬體組的另一位帳號 grace.tsai 或 henry.yang 登入，確認卡片逐列顯示欄位、有轉單按鈕，並簽核一次；有金鑰時另用一句話描述需求（例如「下週三前需要兩台 27 吋螢幕到 3F」），確認 AI 會依今天換算日期並填入欄位，這一步會使用自動生成額度並可能產生模型費用
8. 一般需求：主題不含任何需求類型的關鍵字（例如「座位調整」；「投影機故障」含「故障」，會選到報修）時為一般需求；沒有金鑰時處理部門留空、需在視窗中選擇，填寫需求說明後套用送出，結果為「依 AI 對話確認部門」。

新 volume 第一次啟動時建立的資料庫、示範名冊與 `storage.ready` 的預期值見[API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.4 節；之後的人員調整用 `scripts/personnel.js`（第 5.7 節）

### 2.5 日常指令

```bash
docker compose logs --tail=100 backend
docker compose logs --tail=100 web
docker compose logs -f backend
docker compose stop
docker compose start
docker compose down
```

`logs -f` 用 Control+C 離開；不會停止服務；`stop`、`down` 與重建容器都會先送 SIGTERM，後端的關機流程與日誌見 [backend/README.md](../backend/README.md)「關機」；Compose 的停止寬限為 90 秒，不要縮短；`stop` 保留容器與 volume；`down` 移除本專案容器與網路、保留 volume；不要加 `-v`，不要用 Docker Desktop 刪除資料 volume，也不要執行會清除 volume 的清理指令；Compose 的日誌輪替上限為每服務 3 個 10 MB 檔，不是總磁碟空間上限

## 3. 第二階段：建立 Lightsail 主機

### 3.1 選擇方案

1. 用目前 AWS Console 身分開啟 Amazon Lightsail，區域選 Tokyo／ap-northeast-1。
2. 選 **Create instance → Linux/Unix → OS Only → Ubuntu 24.04 LTS**。這是虛擬主機，不是 Lightsail Container Service。
3. 選含公有 IPv4 的方案，先用 1 GB RAM。確認建立頁的實際月費及稅金，不把短期優惠當作永久價格。
4. 命名 `helpdesk-docker`，選擇 SSH key pair；保管可下載的私鑰。它用來連線 Linux，不是 AWS Access Key。
5. 第一次可先不啟用付費的自動快照，待第 7 節確認備份與成本後決定。建立主機即可能開始計費。

程式不建立雲端資源，也不需要 AWS Access Key；Lightsail 主機、固定 IP、防火牆、DNS 與公開 HTTPS 都由操作者依本文自行建立並驗收

官方目前列出的含 IPv4 Linux 方案為 1 GB／40 GB SSD：US$7／月，2 GB／60 GB SSD：US$12／月。用 US$1≈NT$33 作規劃分別約 NT$231、NT$396，不含稅、網域、備份、額外傳輸及 Gemini。若總預算 NT$500 包含 AI，先用 1 GB 留下餘裕；實際課堂測試若記憶體不足再評估升級。參考 [Lightsail 價格](https://aws.amazon.com/lightsail/pricing/)。

Lightsail 的網路由 AWS 管理，不直接使用你先前建立的 helpdesk-vpc 與兩個 public subnet。這次不需要新增 NAT Gateway、ALB、EB 角色或資料庫服務；不會修改既有 VPC。參考 [AWS Lightsail 與 EC2 比較](https://repost.aws/knowledge-center/lightsail-differences-from-ec2)。

### 3.2 固定 IP 與防火牆

在 Lightsail Networking 建立 Static IP，掛載到這台 instance。動態 IP 可能在停止／啟動後變動，固定 IP 可避免每次更新 DNS；不用的固定 IP 要按官方價格規則處理。參考 [建立 Static IP](https://docs.aws.amazon.com/lightsail/latest/userguide/lightsail-create-static-ip.html)。

在該 instance 的 Networking／IPv4 firewall 設定：

| 通訊協定／port | 來源 | 原因 |
| --- | --- | --- |
| TCP 22 | 你的管理用公有 IP／32；需要時啟用 Allow Lightsail browser SSH/RDP | 只供 SSH 管理 |
| TCP 80 | 所有人 | HTTP 轉 HTTPS，及公開憑證驗證 |
| TCP 443 | 所有人 | 同學使用 HTTPS 網站與 API |

不開放 3000、5173、8080、8443 或 Caddy 管理 port。首次只使用 DNS A 記錄與 IPv4 即可，不先發布 AAAA；若要啟用 IPv6，須同時驗證 IPv6 防火牆、服務綁定與 DNS，不能只加入 AAAA。參考 [Lightsail 防火牆](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html)。

### 3.3 SSH 與安裝 Docker Engine

可以先用 Lightsail 的 Connect using SSH。登入後執行：

```bash
uname -m
cat /etc/os-release
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

建立 Docker 官方套件來源；以下整段在 Ubuntu 執行：

```bash
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
mkdir -p ~/helpdesk_agent
```

這台主機安裝 Docker Engine，不安裝 Docker Desktop。本文在雲端使用 sudo 管理 Docker，避免額外授予 docker 群組權限；不要修改 socket 為所有人可寫。Ubuntu 操作依 [Docker 官方安裝說明](https://docs.docker.com/engine/install/ubuntu/)。

記下 `uname -m`：`x86_64` 對應 linux/amd64；`aarch64` 對應 linux/arm64。Mac 是 Apple Silicon 也能建立 amd64 image，代價是跨架構建置較慢。

## 4. 第三階段：網域、打包與正式啟動

### 4.1 設定網域

購買網域或使用已有網域的子網域，例如 `alex-lin-lab.com`。到實際管理 DNS 的平台新增：

| 類型 | 名稱 | 值 |
| --- | --- | --- |
| A | @ | Lightsail Static IPv4 |

若使用已有 DNS 平台，可直接在該平台新增記錄，不必另外付費建立 Route 53 hosted zone。首次先保持直接 DNS 指向主機，不啟用其他 CDN 代理。正式啟動前從 Mac 執行 `dig +short alex-lin-lab.com A`，確認解析到 Static IP。此專案已選定 alex-lin-lab.com；其他操作者部署時改為自己持有的網域。Cloudflare DNS 記錄使用 DNS only，不啟用代理。

公開 DNS 指向正確、80／443 可達且 Caddy 的 `/data` 可寫後，Caddy 會自動管理公開 HTTPS 憑證；憑證資料存在 caddy_data volume。參考 [Caddy 自動 HTTPS](https://caddyserver.com/docs/automatic-https)。

### 4.2 在 Mac 建立與匯出正式 images

建議在 Mac 建立，再傳到小主機，避免 1 GB 主機執行 npm 安裝與建置。以下以已確認為 x86_64 的 Lightsail 為例；若是 aarch64，兩處 linux/amd64 都改成 linux/arm64。

```bash
cd /Users/liweimac/helpdesk_agent
docker buildx build --platform linux/amd64 --load -t helpdesk-backend:latest ./backend
docker buildx build --platform linux/amd64 --load -t helpdesk-web:latest -f deploy/web.Dockerfile .
docker image inspect helpdesk-backend:latest --format '{{.Os}}/{{.Architecture}}'
docker image inspect helpdesk-web:latest --format '{{.Os}}/{{.Architecture}}'
docker save -o /tmp/helpdesk-images.tar helpdesk-backend:latest helpdesk-web:latest
```

images 不包含本機 .env，也不含 backend/storage 內的 tickets.json、helpdesk.db、還原保留檔、還原暫存檔或匯出 JSON（`.dockerignore` 排除整個 storage 目錄）；未使用 image registry，不必建立 ECR 權限或公開 image。之後每次更新都要重做建置與傳送，單純修改原始碼不會改變已執行容器。

### 4.3 從 Mac 傳送部署檔案

將下載的 SSH 私鑰存至你的私人位置，以下路徑與 IP 都自行替換；不要將私鑰放進專案。先確定 SSH 22 的來源包含目前網路公有 IP：

```bash
HELPDESK_KEY="$HOME/.ssh/helpdesk-lightsail.pem"
HELPDESK_IP='填入實際的StaticIPv4'
chmod 600 "$HELPDESK_KEY"
ssh -i "$HELPDESK_KEY" "ubuntu@$HELPDESK_IP" 'mkdir -p ~/helpdesk_agent'
scp -i "$HELPDESK_KEY" compose.yaml .env.example /tmp/helpdesk-images.tar "ubuntu@$HELPDESK_IP:~/helpdesk_agent/"
ssh -i "$HELPDESK_KEY" "ubuntu@$HELPDESK_IP"
```

第一次連線需確認 host key 與主機身分，不停用 SSH 的 host key 檢查。若使用不同 Linux 使用者，將 ubuntu 改為實際帳號。第一次下載的 Lightsail key 名稱可能不同，使用你實際的檔案即可。

正式主機只需要 Compose、環境檔與載入後的 images，不需要上傳 node_modules、整個 Git 專案或 Mac 的 backend/.env。

### 4.4 在 Lightsail 設定 production

以下指令在 Lightsail SSH 終端機執行：

```bash
cd ~/helpdesk_agent
sudo docker load -i helpdesk-images.tar
cp -n .env.example .env
chmod 600 .env
nano .env
```

在 `.env` 中修改既有項目，不要新增重複設定：

```dotenv
NODE_ENV=production
SITE_ADDRESS=alex-lin-lab.com
CORS_ORIGIN=https://alex-lin-lab.com
HTTP_BIND=0.0.0.0
HTTP_PORT=80
HTTPS_BIND=0.0.0.0
HTTPS_PORT=443
```

再私下填入 GEMINI_API_KEY、已驗證的 GEMINI_MODEL（要用 Claude 當備援時再填 ANTHROPIC_API_KEY）、兩組不同密碼，以及至少 32 bytes 的固定 AUTH_SECRET；範例不提供任何可用密碼或金鑰；NODE_ENV、CORS_ORIGIN 與 SITE_ADDRESS 的寫法規則見第 2.2 節與 [backend/README.md](../backend/README.md)「正式環境與部署」

Compose 在後端容器的 `environment` 固定 PORT=3000、TRUST_PROXY=1、ORIGIN_VERIFY_SECRET 為空、LIMIT_STORE=memory、SHUTDOWN_TIMEOUT_MS=75000、DATABASE_FILE=/app/storage/helpdesk.db（工作單資料庫，目錄須已存在，即 tickets volume）、TICKETS_FILE=/app/storage/tickets.json（只作舊版 JSON 匯入來源，服務不寫入）；這些值寫在 `.env` 也會被覆蓋；資料庫與 JSON 檔位於同一個 tickets volume（掛載整個 /app/storage 目錄，volume 名稱不變），容器另設停止寬限 90 秒與 `init: true`；TRUST_PROXY 的啟動驗證見 [backend/README.md](../backend/README.md)「登入、限流與配額」；不要把舊的 CloudFront 來源秘密帶入這個架構；只有 Caddy 對外，Caddy 依實際連線建立來源資訊；不要另加 backend ports，否則 TRUST_PROXY=1 的單跳信任條件失效

### 4.5 正式啟動與驗收

```bash
sudo docker compose config --quiet
sudo docker compose up -d --no-build --pull never --wait
sudo docker compose ps
sudo docker compose logs --tail=100 web
sudo docker compose logs --tail=100 backend
```

backend 日誌應有 `storage.ready`（新主機與重啟時各欄位的預期值見[API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.4 節）；若是從舊版 JSON 儲存升級，改依第 5.4 節操作；從 schemaVersion 1 的 SQLite 版升級，依第 5.6 節操作；從 schemaVersion 2 升級，依第 5.7 節操作

`--no-build --pull never` 使用剛載入的 images，不在雲端重建或到 registry 找 helpdesk 私有程式。等待 DNS／憑證完成後，在 Mac 執行：

```bash
curl --fail https://alex-lin-lab.com/helpdesk/api/health
curl -I http://alex-lin-lab.com/
```

第一個預期成功回 health JSON；第二個應導向 HTTPS。不要用 `curl -k` 當作 TLS 驗收通過。HTTP health／Docker healthy 不代表公開憑證已成功。

正式驗收：

- 瀏覽器開 https://alex-lin-lab.com/helpdesk/，憑證有效、沒有 mixed content；Network 的 /helpdesk/api 請求送到同一網站，沒有送往同學的 localhost。
- 以「自動生成」套用後送單、查詢、簽核／退回／轉單／取消正常，再以「自動生成」對話驗證 AI（後端日誌有 `claude.generate.completed` 或 `gemini.generate.completed`）。
- 依第 2.4 節第 6～8 點，以「自動生成」送出並簽核一張請假單與一張設備申請單（一般需求可選做）；測試用請假單對假別時數的影響與清除方式見規格書第 3.12、3.17 節
- 管理員登入只進管理頁，監測輪詢正常，「需求單資料庫」區塊顯示 SQLite 結構版本與各狀態筆數；一般帳號的管理 API 為 403。
- 更換後端容器後工作單保留；固定 AUTH_SECRET 不變時憑證仍可驗證，保護計數重啟歸零。
- 從不同網路測試，再送入假的 X-Forwarded-For，確認不能藉偽造來源繞過 IP 限流；學校 Wi-Fi 共用出口仍會共享 IP 視窗，帳號配額維持分開。
- 3000 沒有主機 port mapping，也沒有在 Lightsail firewall 開放。

## 5. 上線後的更新與回復

### 5.1 從根目錄版本更新到 /helpdesk/（2026-10-29）

目前選定網域為 `alex-lin-lab.com`。新版本的路徑為：

| 網址路徑 | 行為 |
| --- | --- |
| `/` | 暫時以 302 導向 `/helpdesk/`；日後可另做多專案導覽頁 |
| `/helpdesk` | 308 導向含尾斜線的 `/helpdesk/`，讓相對資產路徑正確 |
| `/helpdesk/` | 登入頁；其他前端頁面在 `/helpdesk/pages/` 底下，例如 `/helpdesk/pages/admin/admin.html`（2026-11-01 目錄重整後的路徑，見第 5.2 節） |
| `/helpdesk/api/...` | 移除 `/helpdesk` 後轉送既有 Express `/api/...`（Express 路由、健康檢查與請求／回應仍維持 /api），保留查詢參數與 Authorization 授權標頭，並產生可信任的 X-Forwarded-For；API 保持 `Cache-Control: no-store`，Caddy 不快取 API |
| 根目錄 `/api/...`、`/project-b/` 等未部署路徑 | Caddy 直接回 404，不轉送服務台後端；第二個專案尚未部署 |

靜態資產帶 `Cache-Control: no-cache`，更新部署後瀏覽器會重新驗證；前端 `src/config.js` 依自身模組位置推導專案基底，部署時不必寫死網域；後端沒有發布主機 port，只在 Docker 網路可達，只有 Caddy 發布對外 port；Caddy 是唯一代理，因此 Compose 固定 `TRUST_PROXY=1` 並清空舊的 `ORIGIN_VERIFY_SECRET`；修改拓撲（例如前面再加一層代理）後須重新驗證來源 IP，不可直接沿用這個跳數

這次只需更新 web image；後端程式、Compose 網路與工作單 volume 不變；正式 HTTPS 的環境參數仍依第 4.4 節另行設定，CORS_ORIGIN 只填 origin（例如 `https://helpdesk.example.com`），不加 /helpdesk；不要把 DNS 已生效視為 HTTPS 已完成

先在 Mac 依正確平台重新建立 web image：

```bash
docker buildx build --platform linux/amd64 --load -t helpdesk-web:latest -f deploy/web.Dockerfile .
docker save -o /tmp/helpdesk-web.tar helpdesk-web:latest
```

確認建置與匯出成功，再以第 4.3 節的 scp 方式只傳送這個 tar 檔至原部署目錄。若 Mac 的 Docker Hub 連線回 EOF，可改用第 5.3 節在 Lightsail 建立前端 image，保留公司專案使用的 Docker Desktop 設定；不要把失敗的建置視為已更新 image。

在 Lightsail 載入後更新 web：

```bash
cd ~/helpdesk_agent
sudo docker load -i helpdesk-web.tar
sudo docker compose up -d --no-build --pull never --no-deps --wait web
```

`--no-deps` 讓這次路徑更新只重建 web，保留正在運行的 backend。先維持原本 localhost／8080 綁定，可經既有 SSH 通道開啟 `http://localhost:8080/helpdesk/`，驗證登入、以「自動生成」送單、查詢與管理頁。後續改正式 CORS_ORIGIN 時需套用後端環境變數變更，不能繼續只更新 web。

### 5.2 一般版本更新

先依第 6.2 節備份工作單資料庫，並私下保存設定，再於 Mac 重新建置正確架構的 images、匯出並用 scp 傳送。不要使用 Git 裡未提交的舊版本當成已上線版本；建議每次記下部署的 commit 與日期，並保留上一版 image 匯出檔於本機。

在 Lightsail 更新：

```bash
cd ~/helpdesk_agent
sudo docker load -i helpdesk-images.tar
sudo docker compose up -d --no-build --pull never --wait
```

2026-11-01 的目錄重整版（後端程式移到 `backend/src/`、前端頁面移到 `frontend/pages/`、共用樣式移到 `frontend/styles/`）要注意：

- backend 與 web image 都要重新建置：`backend/Dockerfile` 改為複製 `src/` 並執行 `node src/index.js`，`deploy/web.Dockerfile` 改為複製 `index.html`、`styles/`、`pages/` 與 `src/`；兩者一起更新、一起回復。
- 頁面網址改為 `/helpdesk/pages/propose/propose.html`、`/helpdesk/pages/tickets/tickets.html`、`/helpdesk/pages/admin/admin.html`；舊網址（`/helpdesk/propose.html`、`/helpdesk/tickets/tickets.html`、`/helpdesk/admin/admin.html`）會回 404。登入頁 `/helpdesk/` 不變，請使用者從登入頁進入或更新書籤。
- 新版 compose.yaml 不再提供 NODE_ENV 與 CORS_ORIGIN 的預設值，要和 images 一起傳送；載入前先在部署目錄以 `grep -E '^(NODE_ENV|CORS_ORIGIN)=' .env` 確認兩項都已設定（這兩項不是秘密，其他行不要印出；缺少時的後端行為見第 2.2 節）

同一個 ~/helpdesk_agent、同一份 Compose project name `helpdesk` 才會沿用原 volume。更新會短暫中斷，記憶體配額與頻率計數會歸零；不要使用多副本避免中斷，這個儲存設計不支援多程序。

只改 `.env` 時也執行上述 up 指令讓容器重建；`docker compose restart` 不會載入修改後的環境設定。回復程式則載入上一版 image 匯出檔再執行 up；若資料格式有變更，先確認備份與程式版本相容（例如資料庫已升級為結構版本 3 時，只支援版本 1、2 的 image 無法啟動，見第 5.6、5.7 節）。目前的管理頁要求 `/api/admin/metrics` 回應含 `ticketStore`，只把 backend 換回沒有此欄位的版本、保留新版 web image 時，管理監測會顯示格式錯誤，所以 backend 與 web image 要一起回復；舊版 web 搭配新版 backend 仍可運作（忽略多出的欄位），只是不顯示需求單資料庫區塊。SQLite 版 image 不能開啟比自己新的資料庫結構版本；要回到 JSON 儲存的上一版，依第 5.5 節先匯出。

### 5.3 在 Lightsail 建立前端 image

本專案前端 image 只複製靜態檔案與 Caddy 設定，沒有 npm 安裝或前端編譯。若 Mac 的 Docker Hub 下載失敗，而公司其他專案共用 Docker Desktop，可保留本機設定，在 Lightsail 建置 web image。這不是後端建置方案；後端若有修改，須另外依第 4 節準備 image。

先在 Lightsail 確認可下載基底：

```bash
sudo docker pull --platform linux/amd64 caddy:2-alpine
```

確認成功後，在 Mac 的專案根目錄打包；只選入前端與建置檔案，不選入 .env、後端或工作單：

```bash
tar -czf /tmp/helpdesk-web-source.tar.gz \
  .dockerignore deploy/web.Dockerfile deploy/Caddyfile \
  frontend/index.html frontend/styles frontend/pages frontend/src
```

沿用第 4.3 節在 Mac 設定的 HELPDESK_KEY、HELPDESK_IP，傳送壓縮檔：

```bash
scp -i "$HELPDESK_KEY" /tmp/helpdesk-web-source.tar.gz "ubuntu@$HELPDESK_IP:~/helpdesk_agent/"
```

在 Lightsail 原部署目錄解壓並建置；這兩步尚不會替換執行中的容器：

```bash
cd ~/helpdesk_agent
tar -xzf helpdesk-web-source.tar.gz
sudo docker build --platform linux/amd64 -t helpdesk-web:latest -f deploy/web.Dockerfile .
sudo docker image inspect helpdesk-web:latest --format '{{.Id}} {{.Os}}/{{.Architecture}}'
```

確認建置成功、架構為 linux/amd64 後，只更新 web：

```bash
sudo docker compose up -d --no-build --pull never --no-deps --wait web
```

依第 4.5 節驗證公開 HTTPS、登入及工作單查詢。更新會短暫中斷網站入口；工作單 volume 與後端程序維持原狀。保留舊 image 匯出檔或版本標籤以便回復，避免更新成功前清理 images。

### 5.4 升級到 SQLite 儲存版（2026-11-01）

這一版把工作單從 volume 內的 tickets.json 改存 SQLite 資料庫 `/app/storage/helpdesk.db`（better-sqlite3 13.0.3），同目錄另有 `helpdesk.db-wal`、`helpdesk.db-shm`。業務 API 的請求與回應格式不變；管理監測 `GET /api/admin/metrics` 新增頂層 `ticketStore`（只含各狀態筆數、結構版本與檔案大小），管理頁新增「待簽核需求單」卡片與「需求單資料庫」區塊，因此這次 backend 與 web image 都要更新。舊版 web 搭配新版 backend 仍可使用，但新版 web 搭配 JSON 版 backend 時管理監測會顯示格式錯誤，回滾時兩者要一起換回。volume 仍是同一個 `tickets`，不要改名，也不要 `down -v`。Compose 以 DATABASE_FILE 指定資料庫；TICKETS_FILE 只代表舊版 JSON 匯入來源，執行中的服務不再寫入它。

後端第一次啟動時自動匯入舊版 tickets.json 的條件、逐筆檢查、失敗代碼，以及 `storage.legacy_warning` 各種 legacyImport 的意義，見[API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.4 節；本節只列升級操作

要匯入「無舊檔」標記之後才放入的 tickets.json 時，在維護時段先以 `sudo docker compose exec -T backend node scripts/import-legacy-tickets.js --dry-run --import-late` 預覽（status 應為 would-import），再去掉 `--dry-run` 執行

1. 仍執行舊版時，先把舊版 tickets.json 備份到主機外。舊版以暫存檔改名寫入，直接複製可取得某個完整版本：

```bash
cd ~/helpdesk_agent
mkdir -p backups
chmod 700 backups
TS=$(date +%Y%m%d-%H%M%S)
sudo docker compose cp backend:/app/storage/tickets.json "backups/tickets-before-sqlite-$TS.json"
sudo chown "$(id -u):$(id -g)" "backups/tickets-before-sqlite-$TS.json"
chmod 600 "backups/tickets-before-sqlite-$TS.json"
```

依第 6.2 節的 scp 方式下載到 Mac（檔名改為這份 JSON），確認權限 600、沒有加入 Git 後再繼續。cp 提示找不到檔案表示舊版從未寫入工作單，升級後會記為 no-legacy-file。

2. 在 Mac 重新建立 backend 與 web image，匯出後連同新版 compose.yaml 傳送。舊的 compose.yaml 沒有 DATABASE_FILE，後端會改用 image 內不可寫的預設位置而以 `storage.failed` 結束。若 Mac 無法建立 web image，可只傳 backend，之後依第 5.3 節在 Lightsail 建立 web；舊版 web 在新版 backend 上仍可使用：

```bash
cd /Users/liweimac/helpdesk_agent
docker buildx build --platform linux/amd64 --load -t helpdesk-backend:latest ./backend
docker buildx build --platform linux/amd64 --load -t helpdesk-web:latest -f deploy/web.Dockerfile .
docker save -o /tmp/helpdesk-images.tar helpdesk-backend:latest helpdesk-web:latest
scp -i "$HELPDESK_KEY" compose.yaml /tmp/helpdesk-images.tar "ubuntu@$HELPDESK_IP:~/helpdesk_agent/"
```

3. 在 Lightsail 先替目前的舊版 backend 與 web image 加上標籤，供第 5.5 節回滾，再載入新版：

```bash
cd ~/helpdesk_agent
sudo docker tag helpdesk-backend:latest helpdesk-backend:pre-sqlite
sudo docker tag helpdesk-web:latest helpdesk-web:pre-sqlite
sudo docker load -i helpdesk-images.tar
grep -n 'DATABASE_FILE' compose.yaml
sudo docker compose config --quiet
```

4. （建議）停止後端，以新版 image 預覽匯入（預覽完全唯讀，不建立也不改動資料庫檔，規則見規格書第 3.4 節）：

```bash
sudo docker compose stop backend
sudo docker compose run --rm --no-deps backend node scripts/import-legacy-tickets.js --dry-run
```

預期日誌 `storage.legacy_import` 的 status 為 would-import，count 與預期工作單數相同；沒有舊檔時為 no-legacy-file。出現 `storage.legacy_import_failed` 時不要繼續，先執行 `sudo docker compose start backend` 以原本的舊版容器恢復服務，再排查。停止後端期間網站 API 無法使用，安排在課後。

5. 啟動新版並確認匯入結果：

```bash
sudo docker compose up -d --no-build --pull never --wait
sudo docker compose ps
sudo docker compose logs --tail=100 backend | grep 'storage\.'
```

預期 `storage.ready` 顯示 engine 為 sqlite、legacyImport 為 imported，legacyCount 與預覽筆數相同，之後重啟為 already-imported；以目前版本升級時 schemaVersion 為 3 並寫入示範名冊（各欄位預期值見規格書第 3.4 節）；若出現 `storage.failed`，後端會以代碼 1 結束並被 Compose 反覆重啟，不會變成 healthy；先記下 reason（固定代碼，見第 8 節）與 detail，再依第 5.5 節換回舊版 image

6. 依第 4.5 節驗收，確認既有工作單查詢得到，並能新增與簽核；以 `sudo docker compose up -d --force-recreate --no-build --pull never --wait backend` 重建後端後資料仍在。最後依第 6.2 節做第一次資料庫備份並下載。

匯入後 volume 內的 tickets.json 被改動時的行為見規格書第 3.4 節；新主機首次部署此版本時沒有舊資料，依第 4 節操作即可

### 5.5 回滾到上一版（JSON 儲存）image

舊版 image 只讀寫 TICKETS_FILE，會忽略 DATABASE_FILE 與 volume 內的 helpdesk.db，舊版不會修改資料庫檔。backend 與 web 要一起換回：新版管理頁要求監測回應含 `ticketStore`，搭配 JSON 版 backend 會顯示格式錯誤。若沒有第 5.4 節的 `pre-sqlite` 標籤，改用保留在 Mac 的上一版 image 匯出檔（含 backend 與 web），傳送後以 `sudo docker load -i <上一版 image 匯出檔>` 取代下列 tag 指令，並先確認版本。

升級後新版沒有成功提供服務（例如 `storage.failed` 反覆重啟），也沒有寫入新工作單時，volume 內的 tickets.json 仍是升級前內容，直接換回舊 image：

```bash
cd ~/helpdesk_agent
sudo docker tag helpdesk-backend:pre-sqlite helpdesk-backend:latest
sudo docker tag helpdesk-web:pre-sqlite helpdesk-web:latest
sudo docker compose up -d --no-build --pull never --wait
```

新版已使用一段時間時，先在後端執行中依第 6.2 節備份資料庫，再把 SQLite 內容匯出成舊版格式、放成 tickets.json，然後換回舊 image：

```bash
cd ~/helpdesk_agent
TS=$(date +%Y%m%d-%H%M%S)
sudo docker compose stop backend
sudo docker compose run --rm --no-deps backend node scripts/export-tickets-json.js "/app/storage/tickets-export-$TS.json"
sudo docker compose run --rm --no-deps backend sh -c "set -e; cd /app/storage; if [ -e tickets.json ]; then mv tickets.json tickets.json.before-rollback-$TS; fi; mv tickets-export-$TS.json tickets.json"
sudo docker tag helpdesk-backend:pre-sqlite helpdesk-backend:latest
sudo docker tag helpdesk-web:pre-sqlite helpdesk-web:latest
sudo docker compose up -d --no-build --pull never --wait
```

匯出腳本（`export-tickets-json.js`）以唯讀連線開啟資料庫（服務執行中也可使用）、依建立順序輸出舊版 tickets.json 格式，只含需求單（請假單仍保留 form 欄位），不含帳號、員工、額度與人資調整；先寫入權限 600 的 `<輸出檔>.tmp` 再改名，輸出檔或殘留的 `.tmp` 已存在時以代碼 OUTPUT_EXISTS 拒絕，不覆寫，此時改用新的檔名；成功日誌為 `storage.export.completed`（tickets 筆數），失敗為 `storage.export.failed`；原本的舊版 tickets.json 改名保留；換回後查詢工作單，確認筆數與匯出結果一致

**注意：回滾期間在舊版新增或修改的工作單只寫入 tickets.json。** 之後再升級到 SQLite 版時，資料庫已有匯入標記，服務只記錄 `storage.legacy_warning`（legacyImport 為 legacy-changed；原本沒有舊檔、標記為「無舊檔」時為 legacy-appeared）並沿用資料庫，不會自動合併這段期間的資料。再次升級前須先決定如何處理這些資料；目前沒有合併工具，這個往返流程也尚未演練，不要刪除 tickets.json、helpdesk.db 或備份來嘗試解決。

日後若回到較舊的 SQLite 版 image，而資料庫結構版本比該 image 支援的新，舊 image 會拒絕開啟並記錄 `storage.failed`（reason 為 SCHEMA_TOO_NEW）；目前的 image 使用結構版本 3，第一次啟動就會把資料庫升級到這一版；要回到只支援版本 1、2 的 image，依第 5.6、5.7 節先停止後端，以升級前的 v1 或 v2 備份（`db-backup.js` 產生）執行 `db-restore.js`，升級後新增的需求單、人員調整與人資調整會遺失，因此升級前務必先以 `db-backup.js` 備份；從結構版本 2 以上回到 JSON 版 image 時，匯出檔只含工作單（含請假單），帳號、員工、額度與人資調整不會帶到 JSON 版

### 5.6 升級到「自動生成」與請假版（結構版本 2）

這一版新增提出需求單頁的「自動生成」對話（`POST /api/tickets/draft`）、固定表單「請假申請」、假別時數 API，並把一般帳號由 10 組增為 16 組（端點目前的規格見[API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.16 節）；backend 與 web image 都要更新、一起回復：新版前端的提出需求單頁依賴 `POST /api/tickets/draft`，只回滾 backend 時「自動生成」會回 404；compose.yaml、volume 名稱與 Caddy 設定不變；新的環境參數 `HTTP_DRAFT_LIMIT`、`DRAFT_USER_DAILY_LIMIT`、`DRAFT_GLOBAL_DAILY_LIMIT` 都有預設值，不必加入 `.env`

新版 backend 第一次啟動、開始監聽前會：

1. 驗證 image 內的 `data/employees.json`、`data/requestForms.json`、`data/leavePolicy.json`（連同帳號與部門設定檔）；不符時程序直接結束，訊息只列出位置與原因。（這是結構版本 2 當時的行為；第 5.7 節的版本起 image 已不含 `accounts.json`、`employees.json`，第 5.8 節的版本起 `requestForms.json`、`leavePolicy.json` 改為 `data/requestTypes/`。）
2. 把結構版本 1 的 `helpdesk.db` 就地升級為版本 2（新增 `employees`、`leave_entitlements`、`leave_adjustments`；每一步在一筆交易內完成，失敗整步回滾），既有工作單不變。
3. 以 INSERT OR IGNORE 寫入假員工與 2026、2027 年度假別額度；之後每次啟動都會補上新帳號或新年度，但不覆寫已存在的資料與人資調整。（第 5.7 節的版本起不再於每次啟動補寫，名冊只在帳號表為空時寫入一次。）

**升級後無法直接退回只支援版本 1 的 image**，所以升級前必須先備份：

1. 在舊版仍執行時依第 6.2 節備份資料庫，檔名可加上 `before-v2`，並下載到 Mac；`storage.backup.completed` 的 schemaVersion 應為 1。
2. 在 Mac 重新建立 backend 與 web image（第 4.2 節），匯出後傳送；在 Lightsail 先替目前的 image 加上回滾標籤：

```bash
cd ~/helpdesk_agent
sudo docker tag helpdesk-backend:latest helpdesk-backend:pre-v2
sudo docker tag helpdesk-web:latest helpdesk-web:pre-v2
sudo docker load -i helpdesk-images.tar
sudo docker compose up -d --no-build --pull never --wait
sudo docker compose logs --tail=100 backend | grep 'storage\.'
```

3. 確認 `storage.ready` 的 legacyImport 為 already-imported；目前的 image 會把版本 1 直接升到結構版本 3 並寫入示範名冊，各欄位的預期值見規格書第 3.4 節；出現 `storage.failed` 時記下 reason 與 detail，依下方回滾
4. 依第 4.5 節驗收（含請假），管理頁「需求單資料庫」應顯示目前的結構版本，最後依第 6.2 節做一次新的備份

回滾到 `pre-v2`：先停止 backend，以第 1 步的 `before-v2` 備份依第 6.3 節還原（`db-restore.js` 不會遷移目前資料庫，因此目前是版本 2 也能還原；被取代的版本 2 資料庫會改名保留為 `helpdesk.db.before-restore-<時間>`），再換回舊 image：

```bash
cd ~/helpdesk_agent
HELPDESK_RESTORE='helpdesk-填入 before-v2 備份時間.db'
sudo docker compose stop backend
sudo docker tag helpdesk-backend:pre-v2 helpdesk-backend:latest
sudo docker tag helpdesk-web:pre-v2 helpdesk-web:latest
sudo docker compose run --rm --no-deps -v "$PWD/backups:/backup:ro" backend node scripts/db-restore.js "/backup/$HELPDESK_RESTORE"
sudo docker compose up -d --no-build --pull never --wait
```

**升級後新增的工作單（含請假單）與人資調整都會遺失**；保留下來的 `before-restore` 檔只能以新版 image 讀取，目前沒有把它合併回版本 1 的工具。這個回滾流程尚未在 Lightsail 演練。

### 5.7 升級到人員資料只存 SQLite 版（結構版本 3）

這一版刪除 `data/accounts.json`、`data/employees.json`：帳號、所屬部門、角色、啟用狀態、員工資料與假別額度只存在資料庫，image 內不再有人員檔案。API 請求與回應結構不變，web image 不必更新。新版 backend 第一次啟動、開始監聽前會在一筆交易內：

1. 建立 `accounts` 資料表；版本 2 資料庫已有的員工依程式內示範名冊取得所屬部門（沿用原本的啟用狀態），並補上名冊中的管理員 `alex.admin`；有員工不在名冊時整步回滾，記錄 `storage.failed`（reason `PERSONNEL_UNMAPPED`），資料庫維持版本 2。
2. 重建 `employees`（外鍵參照 `accounts`，移除 `employees.active`），額度、人資調整與工作單不變。

步驟比照第 5.6 節：舊版執行時先備份（檔名加上 `before-v3`，schemaVersion 應為 2）、替目前 image 加上 `pre-v3` 標籤後載入新 image；`storage.ready` 的預期值（從版本 2 升級與全新 volume 不同）見規格書第 3.4 節

回滾到 `pre-v3` 與第 5.6 節相同：停止 backend，以 `before-v3` 備份依第 6.3 節還原後換回舊 image；升級後的人員調整、工作單與人資調整會遺失。這個升級與回滾流程尚未在 Lightsail 演練。

#### 升級後的人員調整（調整部門、新增、停用、設定額度）

在執行中的 backend 容器內以 `scripts/personnel.js` 調整人員；人員資料的規則（不需重啟、JSON 檔不影響人員資料、不提供刪除帳號、密碼共用）見[API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.6 節

- 一律用 `docker compose exec`（服務執行中）或 `docker compose run --rm --no-deps`（backend 已停止時）以 image 預設的 `node` 使用者（1000:1000）執行，**不要加 `--user 0:0`**；以 root 寫入可能讓 helpdesk.db 或 -wal／-shm 變成 root 擁有，backend 之後啟動失敗或回 503（修正方式見第 6.3 節）

每次調整的順序：

1. **備份**：人員資料沒有其他副本，先依第 6.2 節備份（檔名可加上 `before-personnel`），確認 `storage.backup.completed` 的 schemaVersion 為 3。
2. **確認現況**：執行 `list`。資料庫不存在或尚未升級時 `list` 與 `--dry-run` 會拒絕（`PERSONNEL_NOT_FOUND`、`PERSONNEL_SCHEMA_OLD`）。
3. **預覽**：同一個指令加 `--dry-run`（唯讀，不寫入），確認輸出的 `changes`；`changed: false` 表示內容已相同。
4. **執行**：拿掉 `--dry-run`；每個指令在一筆交易內完成，失敗時不留下部分修改。
5. **驗收**：再執行一次 `list`，必要時登入確認（例如調整部門後在狀態追蹤頁的轉單選單確認該部門的處理人名單）。

```bash
cd ~/helpdesk_agent
# 現況（結果含顯示名稱與員工編號，不要貼到公開處）
sudo docker compose exec -T backend node scripts/personnel.js list --department dept-it-1

# 調整所屬部門：先預覽再執行
sudo docker compose exec -T backend node scripts/personnel.js set-department <帳號> <部門 id> --dry-run
sudo docker compose exec -T backend node scripts/personnel.js set-department <帳號> <部門 id>

# 新增一般帳號（三個員工欄位必填），接著設定額度（新員工沒有任何額度）
sudo docker compose exec -T backend node scripts/personnel.js add <名.姓> --department <部門 id> --name '<顯示名稱>' --employee-no '<員工編號>' --hire-date YYYY-MM-DD --dry-run
sudo docker compose exec -T backend node scripts/personnel.js add <名.姓> --department <部門 id> --name '<顯示名稱>' --employee-no '<員工編號>' --hire-date YYYY-MM-DD
sudo docker compose exec -T backend node scripts/personnel.js grant <名.姓> 特休 2026 6720

# 停用與恢復
sudo docker compose exec -T backend node scripts/personnel.js deactivate <帳號>
sudo docker compose exec -T backend node scripts/personnel.js activate <帳號>

# 設定某年度某假別的額度（取代為指定分鐘數，不是加減；假別為事假、病假、特休）
sudo docker compose exec -T backend node scripts/personnel.js grant <帳號> 病假 2027 14400

# backend 已停止時（例如維護時段），改用一次性容器，同樣以 node 使用者執行
sudo docker compose run --rm --no-deps backend node scripts/personnel.js list
```

上面的 `<...>` 換成實際值時要一併拿掉角括號（不要讓 shell 把 `<`、`>` 當成重新導向）；各指令的效果、輸出格式、結束碼與 `storage.personnel.failed` 的 reason 見規格書第 3.6 節與 [backend/README.md](../backend/README.md)「人員資料」

要把 `list` 存成檔案給工具處理時加 `-e LOG_LEVEL=warn`，避免 info 日誌混入輸出（例如 `sudo docker compose exec -T -e LOG_LEVEL=warn backend node scripts/personnel.js list > personnel.json`），輸出檔含個人資料，用完刪除、不要放進 Git

### 5.8 升級到設定驅動的需求類型版（2026-11-01）

這一版把需求類型改成設定檔驅動：後端程式不再寫死任何需求類型，`data/requestForms.json`、`data/leavePolicy.json` 已刪除，改由 `backend/data/requestTypes/` 的目錄 `_catalog.json` 與每種類型一個 JSON 檔定義（這一版當時只有請假 `leave.json` 版本 2、設備申請 `equipment.json`、一般需求 `general.json` 三種；目前的類型與 AI 工具見[需求類型與 AI 資料來源規範](需求類型與AI資料來源規範.md)）；要注意：

- **backend 與 web image 都要更新，也要一起回復**：新版前端讀取 `GET /api/forms` 的 `types` 與自動生成回應的 `type`、`field_options`、`computed`、`summaries`，舊版 backend 回的是 `forms`、`form`、`agent_options`、`leave`，兩者不相容。
- 資料庫結構版本仍為 3，沒有遷移；既有工作單不變。已保存的請假單（版本 1）仍會顯示、計入剩餘時數、阻擋期間重疊，也可以簽核。
- 升級當下仍開著「自動生成」視窗並以舊版本送出請假單的使用者會得到 409 `FORM_VERSION_CHANGED`，重新按「自動生成」即可。
- 沒有新的環境參數。`SHUTDOWN_TIMEOUT_MS` 的下限由 25000 提高為 30000（自動生成一回合的期限改為 20 秒）；compose.yaml 固定為 75000，不受影響。有設定 `GEMINI_MODEL` 時確認該模型支援 function calling。

步驟比照第 5.2 節：

1. 依第 6.2 節備份（檔名可加上 `before-request-types`），schemaVersion 應為 3。
2. 在 Mac 重新建置 backend 與 web image（第 4.2 節），匯出後傳送；在 Lightsail 先替目前的 image 加上回滾標籤，再載入新 image：

```bash
cd ~/helpdesk_agent
sudo docker tag helpdesk-backend:latest helpdesk-backend:pre-request-types
sudo docker tag helpdesk-web:latest helpdesk-web:pre-request-types
sudo docker load -i helpdesk-images.tar
sudo docker compose up -d --no-build --pull never --wait
sudo docker compose logs --tail=100 backend | grep -E 'request_types\.|storage\.'
```

3. 預期先有 `request_types.ready`（`types` 與當次 image 內 `_catalog.json` 的類型一致，目前的清單見[需求類型與 AI 資料來源規範](需求類型與AI資料來源規範.md)；`defaultType` 為 general），再有 `storage.ready`（schemaVersion 3、seeded 三項皆為 0）；出現 `request_types.failed` 時記下 detail（含檔名與鍵路徑），依下方回滾
4. 依第 2.4 節第 6～8 點與第 4.5 節驗收。

回滾到 `pre-request-types`：資料庫結構沒有改變，換回兩個舊 image 即可（`sudo docker tag helpdesk-backend:pre-request-types helpdesk-backend:latest`、web 同理，再執行第 5.2 節的 up 指令）。升級後新建的設備申請單在舊版中沒有對應的範本，舊版如何顯示或簽核這類單尚未驗證，回滾前先把它們簽核、退回或取消。這個升級與回滾流程尚未在 Lightsail 演練。

### 5.9 新增或修改需求類型（只改 JSON，不改程式）

需求類型的定義放在 backend image 內（`data/requestTypes/`），屬於規則設定，跟程式一起提交 Git、一起建置；它不在 volume 裡，**不要在執行中的容器內修改**（容器重建後就會遺失）。撰寫格式、每個鍵的意義與完整範例見[需求類型與 AI 資料來源規範](需求類型與AI資料來源規範.md)。前端依定義自動產生畫面，因此只新增或修改需求類型時 web image 不必更新。

1. **在本機修改**：在 `backend/data/requestTypes/` 新增定義檔（可複製 `equipment.json` 改寫），並在 `_catalog.json` 的 `types` 加一筆 `{ id, file, name, summary, keywords }`；修改既有類型的欄位或規則時把該檔的 `version` 加 1。定義引用的部門 id 必須已在 `data/departments.json`；需要新部門時先加入部門設定檔，再以 `scripts/personnel.js` 建立該部門的帳號（第 5.7 節），否則沒有人能簽核。
2. **本機驗證**：在 `backend/` 執行 `npm test`，再以 `npm run dev` 啟動，確認日誌 `request_types.ready` 的 `types` 含新類型；出現 `request_types.failed` 時依規範第 2 節與第 13 節步驟 8 讀 `detail` 修正；再到提出需求單頁以符合 `keywords` 的主題按「自動生成」，填完欄位送出並由送達部門簽核一次
3. **部署**：依第 5.2 節備份，重新建置並傳送 backend image（web image 不變），替目前的 backend image 加上回滾標籤（例如 `helpdesk-backend:pre-<類型 id>`）後載入並 up；以 `sudo docker compose logs --tail=50 backend | grep request_types` 確認 `request_types.ready`。
4. **失敗時**：`request_types.failed` 會讓 backend 反覆重啟，網站的 API 請求會得到 502，`up --wait` 也會等不到健康狀態；換回剛才標記的 backend image 再 up，修正 JSON 後重新建置。資料庫不受影響。
5. **刪除或改名類型時**：先處理完這類待簽核的單再移除定義；已送出的單在定義移除後如何顯示、轉單與簽核見[需求類型與 AI 資料來源規範](需求類型與AI資料來源規範.md)第 14 節

### 5.10 升級到 Claude 備援版（2026-11-02）

這一版仍以 Gemini 為主要供應商（`AI_PROVIDER` 未設定時為 `gemini`），只多了 Claude 備援：`.env` 另有 `ANTHROPIC_API_KEY` 時才啟用，切換條件、冷卻時間與期限見[API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 1 節「AI 供應商」；原本只設定 `GEMINI_API_KEY` 的主機不必改設定就能更新，行為與上一版相同

1. 要啟用備援時，在 Lightsail 的根目錄 `.env`（或 `HELPDESK_ENV_FILE` 指定的檔案）加上 `ANTHROPIC_API_KEY=<Claude 金鑰>`；不加就沒有備援。
2. 依第 5.2 節重新建置並更新 backend image（新增依賴 `@anthropic-ai/sdk`）；web image 不必更新，API 結構不變。
3. 啟動後確認 `server.started` 日誌的 `aiProvider` 為 `gemini`、`aiFallbackProvider` 為 `anthropic`（沒有 Claude 金鑰時為 null）。Gemini 額度用完時，日誌會出現 `ai.fallback.used` 與 `claude.generate.completed`。
4. 回滾到上一版 image 時，上一版只使用 Gemini，`.env` 多出的 Claude 設定會被忽略。

### 5.11 升級到請假額度異動紀錄版（結構版本 4，2026-11-04）

這一版新增資料表 `leave_log`，記錄每張請假單送出、簽核、退回、取消時的時數、假別、期間與前後剩餘，也記錄人資調整與年度額度變更（欄位見[API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.4 節）；API 請求與回應結構不變，web image 不受這張資料表影響（同日的前端畫面改版另依第 5.2 節更新 web image）；新版 backend 第一次啟動、開始監聽前會在一筆交易內建立 `leave_log`，並依時間順序重播既有請假單的歷程與人資調整回填（`source` 為 `backfill`）；失敗時整步回滾，資料庫維持版本 3

1. 舊版執行時依第 6.2 節備份，檔名加上 `before-v4`；`storage.backup.completed` 的 schemaVersion 應為 3
2. 替目前的 backend image 加上 `pre-v4` 標籤（`sudo docker tag helpdesk-backend:latest helpdesk-backend:pre-v4`），再依第 5.2 節載入並啟動新 image
3. 以 `sudo docker compose logs --tail=100 backend | grep 'storage\.'` 確認 `storage.ready` 的 schemaVersion 為 4，再執行 `sudo docker compose exec -T backend node scripts/leave-log.js` 列出紀錄；回填的列會標示「升級時回填」

這一版的 `leave_log` 與 `scripts/leave-log.js` 已在結構版本 5 移除（見第 5.12 節）；還沒升級到版本 4 的主機可以直接依第 5.12 節升級，途中會先經過版本 4 再移除

回滾到 `pre-v4`：舊 image 只支援到版本 3，遇到版本 4 會記錄 `storage.failed`（reason `SCHEMA_TOO_NEW`）；先停止 backend，以 `before-v4` 備份依第 6.3 節還原，再只把 backend 換回舊 image（`sudo docker tag helpdesk-backend:pre-v4 helpdesk-backend:latest`，其餘指令同第 5.6 節）；升級後新增的工作單、簽核、人資調整與人員調整（`scripts/personnel.js` 的新增、停用、調整部門與 `grant`）會遺失；這個升級與回滾流程尚未在 Lightsail 演練


### 5.12 升級到「額度不在本系統異動」版（結構版本 8，2026-11-04）

這一版依使用者決定，AI 與需求單流程都不寫入額度資料：剩餘時數就是年度額度（`leave_entitlements`），請假單的送出、簽核、退回與取消只改變需求單本身；額度的扣除與調整由人資在公司既有的系統處理，不在本系統。結構版本 5 刪除 `leave_log`、版本 6 刪除人資調整紀錄 `leave_adjustments`（需求單與年度額度保留）、版本 7 在 `accounts` 加上部門的中文名稱 `department_name`（只供直接檢視資料庫，每次啟動依部門設定檔同步）、版本 8 改以員工編號 `employee_no` 關聯 `accounts`、`employees` 與 `leave_entitlements`（重建三張表，資料與順序不變），並移除 `scripts/leave-log.js` 與 `POST /api/leave/adjustments`；狀態追蹤頁改為「申請表單」「待辦表單」「已完成表單」三個分頁（內容見[API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.4、3.8、3.17 節）

1. 舊版執行時依第 6.2 節備份，檔名加上 `before-v8`；`storage.backup.completed` 的 schemaVersion 應為 4（或更舊的版本）
2. 替目前的 backend 與 web image 加上 `pre-v8` 標籤（例如 `sudo docker tag helpdesk-backend:latest helpdesk-backend:pre-v8`），再依第 5.2 節重新建置並更新兩個 image
3. 以 `sudo docker compose logs --tail=100 backend | grep 'storage\.'` 確認 `storage.ready` 的 schemaVersion 為 8
4. 開啟狀態追蹤頁，確認有「申請表單」「待辦表單」「已完成表單」三個分頁；升級前登錄過的人資調整會隨 `leave_adjustments` 一併刪除，剩餘時數改為年度額度

回滾到 `pre-v8`：舊 image 只支援到版本 4，遇到版本 5 以上會記錄 `storage.failed`（reason `SCHEMA_TOO_NEW`）；先停止 backend，以 `before-v8` 備份依第 6.3 節還原，再把 backend 與 web 換回舊 image；回滾後剩餘時數恢復為舊算法（扣除已核准與待簽核），人資調整紀錄也隨備份回來

## 6. 工作單清除、備份與還原

### 6.1 清除方式

使用既有管理頁的清除功能；清除的範圍、不受影響的資料與 WAL 截斷的行為見[API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.12 節

不要在執行中直接編輯、複製（包括 `docker compose cp`）或刪除 volume 內的 helpdesk.db、helpdesk.db-wal、helpdesk.db-shm；手動刪除、覆寫或搬移可能損毀資料，或遺失仍在 WAL 中的內容，直接複製可能漏掉 WAL 內容；備份與還原一律用第 6.2、6.3 節的維運腳本；volume 與主機上 tickets.json、`backend/data/` 檔案的關係見規格書第 3.4 節

### 6.2 備份（服務執行中）

`db-backup.js` 在後端執行中先以權限 600 建立備份檔，再另開唯讀連線以 VACUUM INTO 寫入一致的備份（含 WAL 中已提交的內容），完成後以唯讀方式檢查完整性，只輸出筆數與結構版本；WAL 模式下可與 API 同時進行，不阻擋寫入；輸出檔已存在時以 OUTPUT_EXISTS 拒絕覆寫，上層目錄不存在時為 DIRECTORY_MISSING；**不要直接 `docker compose cp` 執行中的 helpdesk.db**，仍在 -wal 檔中的已提交內容可能沒有帶到；在部署目錄執行：

```bash
# 備份：容器內產生一致的備份，複製到主機 backups/ 後刪除容器內暫存
cd ~/helpdesk_agent
mkdir -p backups
chmod 700 backups
TS=$(date +%Y%m%d-%H%M%S)
sudo docker compose exec -T backend node scripts/db-backup.js /tmp/helpdesk-$TS.db
sudo docker compose cp backend:/tmp/helpdesk-$TS.db backups/helpdesk-$TS.db
sudo docker compose exec -T backend rm -f /tmp/helpdesk-$TS.db
sudo chown "$(id -u):$(id -g)" backups/helpdesk-$TS.db
chmod 600 backups/helpdesk-$TS.db
```

預期日誌事件為 `storage.backup.completed`，含 tickets 筆數與 schemaVersion（目前為 8）；出現 `storage.backup.failed`（detail、sqliteCode；VACUUM INTO 失敗時會刪除預先建立的空檔）表示沒有產生可用備份，先排查；備份是整個資料庫，帳號、所屬部門、員工、假別額度與人資調整會一起保存（人員資料沒有其他副本，請定期備份，調整人員前也先備份），tickets 只代表工作單筆數；容器內的暫存備份複製後即刪除，避免工作單原文留在容器

將備份安全下載到 Mac；只放同一台 Lightsail 無法應對整台主機遺失。在 Mac 專案根目錄沿用第 4.3 節的 HELPDESK_KEY、HELPDESK_IP 執行（backups/ 已被 Git 忽略）：

```bash
HELPDESK_BACKUP_FILE='helpdesk-填入備份時間.db'
mkdir -p backups
scp -i "$HELPDESK_KEY" "ubuntu@$HELPDESK_IP:~/helpdesk_agent/backups/$HELPDESK_BACKUP_FILE" backups/
chmod 600 "backups/$HELPDESK_BACKUP_FILE"
```

先採課前／課後手動備份與每週離機保存，保留必要份數；有持續使用需求再評估自動備份及快照費用。私下另存 `.env`，工作單備份不包含登入秘密與設定，但含工作單原文，不提交 Git。升級前的 `tickets-*.json` 舊版備份只適用 JSON 版 image 或第一次匯入，不能交給 `db-restore.js`。

### 6.3 還原（維護時執行）

這會以備份取代目前所有工作單，以及帳號、所屬部門、啟用狀態、員工、假別額度與人資調整（以備份當時的內容為準，備份之後以 `personnel.js` 做的人員調整會消失，需要時重做；以新版 image 還原結構版本 1 的舊備份時，下次啟動會自動升級並重新寫入示範名冊，還原版本 2 的備份時依示範名冊補上帳號，都沒有該備份之後的人員與人資調整）。先依第 6.2 節另做目前資料備份，確認要還原的檔案是本系統 `db-backup.js` 產生的 .db，並已放在部署目錄的 backups/。還原只能在後端停止時執行：

```bash
# 還原：先停止後端，再以一次性容器執行還原，最後重新啟動
cd ~/helpdesk_agent
HELPDESK_RESTORE='helpdesk-填入備份時間.db'
sudo docker compose stop backend
sudo docker compose run --rm --no-deps -v "$PWD/backups:/backup:ro" backend node scripts/db-restore.js "/backup/$HELPDESK_RESTORE"
sudo docker compose up -d --no-build --pull never --wait
```

`db-restore.js` 的流程（已實作）共五步：

1. 以唯讀方式檢查備份的 integrity_check、檔案身分（application_id）、是否已初始化與結構版本；目前主檔或殘留的 -wal／-shm 存在時，再確認保留舊檔用的名稱 `helpdesk.db.before-restore-<YYYYMMDD-HHMMSS>`（UTC 時間，精確到秒；含加上相同字尾的 -wal／-shm）都不存在，不覆蓋先前保留的副本；同名檔已存在（例如同一秒內再次還原）時以 PREVIOUS_EXISTS 拒絕，不移動任何檔案，稍候再執行即可
2. 以唯讀連線開啟備份，用 VACUUM INTO 依內容（含備份旁 -wal 中已提交的資料）寫入同目錄預先建立的 `helpdesk.db.restore-tmp`（權限 600），再驗證暫存檔並比對兩邊的工作單筆數；不一致時以 BACKUP_NOT_SELF_CONTAINED 拒絕（例如來源是直接複製執行中資料庫的檔案），請改用 `db-backup.js` 的備份。備份以 `:ro` 唯讀掛載也可使用。任何驗證失敗都不動目前資料。
3. 目前資料庫存在時確認沒有其他連線開啟它；後端仍在執行時以 DATABASE_IN_USE 拒絕。此步驟不套用結構遷移，目前資料庫損毀或結構版本較新也能還原；可開啟時順便把 WAL 合併回主檔。
4. 把目前資料庫連同存在的 -wal／-shm 改名為 `helpdesk.db.before-restore-<時間>`（-wal／-shm 加上相同字尾）留在 volume；若 helpdesk.db 不存在、旁邊卻殘留 helpdesk.db-wal／-shm，也會把殘留檔改名為 `helpdesk.db.before-restore-<時間>-wal`／`-shm` 保留（日誌 `strandedSidecars` 為移開的數量），避免 SQLite 把殘留的 WAL 套用到還原的備份上；這些改名保留的檔案都不刪除，可供事後檢查
5. 把暫存檔改名為 `helpdesk.db`；這一步失敗時會把第 4 步移開的檔案改回原名，DATABASE_FILE 不會處於不存在的狀態，避免下次啟動把舊的 tickets.json 重新匯入。

成功日誌為 `storage.restore.completed`（tickets、schemaVersion、keptPrevious、strandedSidecars：主檔不存在時改名保留的殘留 -wal／-shm 數量）；出現 `storage.restore.failed`（detail、sqliteCode）時先排查，不直接啟動或宣稱完成；若失敗日誌帶 `rollbackFailed: true`（連改回原名也失敗，另有 rollbackCode），正式位置可能沒有 helpdesk.db：已驗證的暫存檔保留不刪，路徑在 `stagedFile`；舊主檔在 `previousFile`（原本沒有主檔時為 null）；所有實際被移開、尚未改回的檔案（含殘留的 -wal／-shm）目前路徑在 `movedFiles`；**重新啟動 backend 前**先以一次性維護容器依這些路徑把檔案改回正確名稱，否則啟動時會建立新的資料庫，並在 volume 內有舊 tickets.json 時重新匯入它；啟動後查看 `storage.ready` 與工作單查詢結果，確認還原無誤前不要刪除改名保留的舊檔

維護容器一律以 image 預設的 node 使用者（UID／GID 1000）執行，不加 `--user 0:0`；否則 helpdesk.db 或新產生的 -wal／-shm 可能屬於 root，後端之後會在啟動時記錄 `storage.failed` 並反覆重啟，或在寫入時回 503。若已發生，停止 backend 後執行一次下列修正（這是唯一允許以 root 執行的維護指令；檔案不存在的錯誤可忽略），再啟動：

```bash
sudo docker compose stop backend
sudo docker compose run --rm --no-deps --user 0:0 backend chown 1000:1000 /app/storage/helpdesk.db /app/storage/helpdesk.db-wal /app/storage/helpdesk.db-shm
sudo docker compose up -d --no-build --pull never --wait
```

Lightsail Ubuntu 的 ubuntu 使用者通常也是 UID 1000，第 6.2 節改回擁有者且權限 600 的備份因此可被讀取；若 `id -u` 不是 1000，先確認維護容器能讀取備份檔，不改用 root。若更換基底 image，先確認 UID／GID。

## 7. 持續使用的限制與成本

- tickets volume 可跨容器重建保存，但主機、磁碟或 volume 被刪除仍可能遺失；`docker compose down -v` 也會刪除工作單與 Caddy 憑證資料；volume 不等於備份，詳見 [Docker volumes](https://docs.docker.com/engine/storage/volumes/)；必須另以第 6.2 節的 `db-backup.js` 備份；volume 名稱維持 `tickets`（沿用舊名，掛載整個 `/app/storage`，內含 `helpdesk.db` 與同目錄的 `-wal`、`-shm`，以及舊版若有留下的 tickets.json），不要改名，否則 Compose 會建立新的空 volume；Caddy 憑證另存在 caddy_data volume
- 配額與限流計數的保存方式、重啟後的行為與限制見[API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 2.2 節；不要用反覆重啟作為課堂清額操作
- 設定費用通知並查看 AI 用量（Claude Console 或 Gemini 專案）；AWS 通知不涵蓋 AI 費用，費用通知也不等於自動停機。NT$500 預算須包含稅金、網域年費攤提、備份與模型費用。
- 保留單一後端程序，不開 PM2 cluster、不增加副本（多個程序不會共用資料）；工作單只由這個程序的唯一連線寫入（見第 1 節並行存取設計）；日誌輪替每個服務最多 3 個 10 MB 檔（第 2.5 節）；主機更新、Docker 更新與應用程式部署可能短暫中斷，安排在課後
- 停止 Lightsail instance 不等於停止計費；課程結束時，先下載備份與設定，再依 AWS 計費規則處理不用的主機、快照、固定 IP 及其他資源，不能只按停止就當作已取消。參考 [Lightsail instance FAQ](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-instances.html)。

## 8. 常見問題

| 現象 | 排查方向 |
| --- | --- |
| 缺少 ADMIN_PASSWORD／DEMO_PASSWORD | 編輯的是根目錄 .env 嗎？值是否空白？兩個值是否不同？ |
| production 啟動失敗 | 檢查 AI_PROVIDER 與主要供應商的金鑰（預設 GEMINI_API_KEY）、CORS_ORIGIN、AUTH_SECRET；不貼出實際值 |
| 502／backend 不健康 | 查看 backend 日誌、環境參數與 health；健康等待約數十秒，不能只看 web 啟動 |
| backend 反覆重啟、日誌有 storage.failed | reason 為固定代碼，detail 為不含工作單內容的說明：NODE_TOO_OLD 看 Node 版本；DIRECTORY_MISSING、EACCES 或 SQLITE_CANTOPEN 看主機 compose.yaml 是否含 DATABASE_FILE=/app/storage/helpdesk.db（缺少時後端改用 image 內 root 擁有的 /app/data，reason 為 EACCES）、目錄與檔案是否可由 node 寫入；FOREIGN_DATABASE 表示 DATABASE_FILE 指到不是本服務的 SQLite 檔（application_id 不是 HDK1 且不是全新空檔），服務在任何寫入前就拒絕，不會改動該檔；SCHEMA_TOO_NEW 改用對應版本 image；LEGACY_UNREADABLE／LEGACY_INVALID／LEGACY_CONFLICT 檢查 tickets.json 權限、格式，或舊檔尚未匯入資料庫卻已有工作單；SQLITE_NOTADB 等 SQLite 代碼表示檔案無法當資料庫開啟。不刪資料檔，需要時依第 5.5 節回滾 image |
| 503 TICKET_STORE_UNAVAILABLE | 看 tickets.store.unavailable 的 operation 與 errorCode（SQLite 代碼或上列開啟時代碼）；檢查 /app/storage 與 helpdesk.db、-wal、-shm 是否屬於 node、磁碟是否已滿；不手動修改或刪除資料庫檔 |
| 維護後 storage.failed 或回 503、檔案屬於 root | 是否曾以 `--user 0:0` 執行維護？停止 backend 後以 `sudo docker compose run --rm --no-deps backend ls -ln /app/storage` 檢查擁有者應為 1000；依第 6.3 節的 chown 指令只把 helpdesk.db、-wal、-shm 改回 1000:1000，之後維護一律使用預設 node 使用者 |
| 日誌有 storage.legacy_warning | 依 legacyImport 判斷：legacy-changed 為 tickets.json 在匯入後被改動（例如回滾後或誤放檔案）；legacy-appeared 為「無舊檔」標記後才出現 tickets.json（不論資料庫是否已有工作單），確認要匯入且資料庫沒有工作單時依第 5.4 節以 `--import-late` 匯入；legacy-unreadable 為舊檔無法讀取（看 errorCode，回滾前修正權限）。服務都沿用資料庫、不自動匯入或合併，見第 5.4、5.5 節 |
| backend 一啟動就結束，日誌有 request_types.failed | 需求類型定義有誤：`detail` 列出檔名、鍵路徑與原因（例如未知的欄位型別或能力、佔位文字參照不存在的欄位、部門 id 不在 `data/departments.json`、目錄的檔名找不到）。在本機修正 `backend/data/requestTypes/` 後重新建置 backend image；急需恢復時先換回上一版 backend image（第 5.9 節） |
| backend 一啟動就結束，日誌沒有 storage.ready，訊息提到部門設定檔 | image 內的 `data/departments.json` 是否存在且格式正確？修正後重新建置 backend image |
| storage.failed，reason 為 PERSONNEL_UNMAPPED | 結構版本 2 資料庫有員工不在示範名冊，無法決定所屬部門；整步已回滾、資料庫仍是版本 2。依第 5.7 節換回舊 image，或以升級前備份處理後再升級 |
| storage.account_department_missing 警告 | 帳號所屬部門已不在 `data/departments.json`，該帳號不能登入也不能當處理人；修正部門設定，或以 `node scripts/personnel.js set-department <帳號> <部門 id>` 調整 |
| `scripts/personnel.js` 結束碼 1，日誌 storage.personnel.failed | 看 reason：PERSONNEL_INVALID 為格式不符（帳號必須全小寫「名.姓」、部門必須在 `data/departments.json`、一般帳號缺員工欄位或管理員帶了員工欄位、假別或年度或分鐘數不符）；PERSONNEL_NOT_FOUND 為帳號或員工資料不存在（管理員沒有額度），或 `list`／`--dry-run` 時資料庫檔不存在；PERSONNEL_CONFLICT 為帳號或員工編號已存在（停用的帳號改用 activate）；PERSONNEL_SCHEMA_OLD 為資料庫尚未升級到版本 3，先啟動新版 backend 一次。結束碼 2 為子指令或參數數量不符，stderr 會印出用法 |
| 調整人員後畫面沒有變化 | 服務每次請求都查詢資料庫，不需重啟；確認指令沒有帶 `--dry-run`、輸出的 `changed` 為 true，並在 backend 容器內執行（主機上的 `backend/storage/helpdesk.db` 不是容器使用的檔案）。已登入的使用者重新整理頁面即可看到新的處理人名單 |
| 換回舊 image 後 storage.failed，reason 為 SCHEMA_TOO_NEW | 資料庫已升級為較新的結構版本（目前為 4）；依第 5.6、5.7、5.11 節用升級前的備份還原，或改回新版 image |
| 「自動生成」回 404，或按下後顯示找不到 | 是否只更新了 web、backend 仍是舊版？backend 與 web image 要一起更新 |
| 「自動生成」顯示 AI 尚未啟用、額度用完或忙碌 | 這些情況請求仍成功，可直接在右側欄位填寫；兩家都沒有金鑰時為 AI_UNAVAILABLE，每日額度依 DRAFT_USER_DAILY_LIMIT／DRAFT_GLOBAL_DAILY_LIMIT 於台北午夜重置；後端日誌看 `ticket.draft.evaluated` 的 aiError 與 `ticket.draft.ai.failed` |
| 送出時頁面提示需求內容必須保留固定格式文字，或得到「需求內容與表單資料不一致」或 409 | 套用後是否改動了「自動生成」整理的固定文字？可在前後補充說明，但不能改動固定文字；重新按「自動生成」確認後再套用；409 的代碼來自需求類型定義：請假的 LEAVE_OVERLAP 為期間重疊、LEAVE_BALANCE_INSUFFICIENT 為剩餘時數不足；FORM_VERSION_CHANGED 為定義版本已更新（例如升級後仍以請假版本 1 送出） |
| 「自動生成」畫面或狀態追蹤卡片的欄位顯示異常、找不到 `types` | 是否只更新了其中一個 image？設定驅動版的 web 與 backend 要一起更新（第 5.8 節） |
| 管理監測顯示格式錯誤 | 是否只把 backend 換回舊版、web 仍是新版？新版管理頁要求 `ticketStore` 欄位，backend 與 web image 要一起回復 |
| 管理頁「需求單資料庫」顯示無法讀取 | 監測其餘部分仍會更新；查看 backend 的 tickets.store.unavailable 與 errorCode，依 503 列排查 |
| 日誌有 tickets.store.checkpoint_failed | 管理清除時有其他讀取連線（例如備份）占用，WAL 尚未截斷；清除已成功，WAL 會在之後的 checkpoint 截斷，避免在備份執行中清除 |
| db-restore.js 失敗 | 看 storage.restore.failed 的 detail 與代碼欄位（腳本沿用 sqliteCode 名稱）：DATABASE_IN_USE 表示後端未停止；BACKUP_NOT_SELF_CONTAINED 表示備份與複製結果筆數不一致（例如直接複製的執行中資料庫），改用 db-backup.js 的備份；PREVIOUS_EXISTS 表示同名的 before-restore 保留檔已存在，稍候再執行；這些情況目前資料不會被改動。帶 rollbackFailed 時依第 6.3 節的 stagedFile、previousFile、movedFiles 人工復原後才啟動 backend |
| backend 啟動失敗、日誌有 server.failed | reason 為 PORT_IN_USE（port 已被占用）或 LISTEN_FAILED；監聽失敗時不會記錄 server.started。容器內 PORT 固定 3000，通常是 compose.yaml 或映像被改動 |
| 日誌有 server.shutdown.failed 或 server.shutdown.forced | 停止時仍有工作超過 75 秒（DRAIN_FAILED_OR_TIMEOUT），或關機中又收到訊號（REPEATED_SIGNAL）而強制結束；兩者都會先關閉資料庫，已提交的工作單不會遺失 |
| 瀏覽器仍呼叫 localhost:3000 | 是否還在 localhost:5173，或正式 image／瀏覽器資產尚未更新？重新建置 web 並重新整理 |
| 舊書籤的頁面回 404 | 2026-11-01 起頁面移到 `/helpdesk/pages/...`；從 `/helpdesk/` 登入頁進入或更新書籤（見第 5.2 節） |
| 公開 HTTPS 失敗 | DNS A 是否指向固定 IP？80／443 是否開放？SITE_ADDRESS 是否仍為 http://localhost？查看 Caddy 日誌 |
| exec format error | image 架構與 Lightsail uname -m 不一致，依正確 platform 重建 |
| 本機 8080／8443 被占用 | 改根目錄 .env 的 port 與 CORS_ORIGIN；本機 SITE_ADDRESS 保持 http://localhost |
| 重建後看不到工作單 | 是否改了 project name、volume 名稱、主機或刪 volume？升級時 storage.ready 的 legacyImport 是否為 no-legacy-file？是否把本機 backend/data 的檔案當成容器資料？ |

本機故障先看 `docker compose ps` 與兩個服務的日誌。正式故障使用相同指令加 sudo；不要為了排錯開放 backend port、停用憑證檢查或公開環境檔。

## 9. 本次驗證範圍（2026-10-28）

本機已建立兩個 images，通過前端 62 項測試及 image 內的後端 51 項測試。另以假的測試帳密、獨立 Compose project 與新 volume 驗證網站資產、API 代理、登入、角色隔離、管理監測、工作單寫入、容器重建後保留、固定 JWT、偽造來源標頭不改變 IP 視窗、管理重置、備份與還原後繼續寫入。已確認後端 image 不含 .env、真實工作單或測試檔，且以非 root 執行；Caddy 本機與正式網域設定通過語法驗證。

建置時發現的 body-parser 與 qs 漏洞已在既有版本範圍內更新 lockfile，當次 npm audit 為 0；這是當時的檢查結果，不代表日後沒有新公告。測試未呼叫 Gemini，未修改本機原始工作單，未建立 AWS 資源；真正的 DNS、公開憑證、雲端容量與付費模型串接仍須依上述步驟驗收。

2026-10-29 的 /helpdesk 路徑更新已通過前端 62 項測試，以及獨立容器中的首頁轉址、深層資產、登入、管理授權、工作單寫入與查詢、查詢參數轉送、CORS、API no-store 與其他專案 404 驗證。正式網域的 Caddy 設定通過語法驗證。當時 Mac 的 Docker Hub 回傳 EOF，因此本機容器測試暫以既有 web image 加入新版檔案建立測試 image；之後操作者已在 Lightsail 依正式 Dockerfile 重新建置及更新，結果見下一節。本機隔離測試沒有變更 AWS、雲端環境檔或真實工作單，也沒有呼叫 Gemini。

2026-11-01 的 SQLite 儲存變更已通過後端 55 項測試（新增 backend/tests/ticketDatabase.test.js，測試使用 `:memory:` 或暫存檔）與前端 63 項測試；前端只有管理頁新增需求單資料庫監測區塊（測試涵蓋 `ticketStore` 驗證與顯示），業務頁面未修改。尚未在 Lightsail 執行第 5.4 節升級、第 6 節備份與還原，或第 5.5 節回滾演練；完成前不能當作雲端已驗收。

2026-11-01 的目錄重整（`backend/src/`、`frontend/pages/`、`frontend/styles/`、文件移到 `docs/`）與後續錯誤修正，已在本機 Node.js 22.23.4 以 `npm test` 通過後端 78 項、前端 79 項測試。這些測試不建置 Docker image、不呼叫 Gemini，也不連線 Lightsail；新的 backend／web image 建置、第 5.2 節更新與新頁面網址仍須依本文另行驗收。

2026-11-01 的「自動生成」與請假版（結構版本 2、16 組一般帳號）已在本機 Node.js 22.23.4 以 `npm test` 通過後端 94 項、前端 122 項測試（新增後端 leaveForms、draftFlow，前端 draftService、draftDialog、proposeDraft、formFormatters、formTickets 等測試）；另以暫存資料庫、只存在子程序的假密碼、未設定 Gemini 金鑰的真實後端，加上前端實際的 service 模組與視窗元件，完成一次本機端對端檢查（登入、請假手動填寫與送出、期間重疊、剩餘不足、代理人規則、本人簽核 403、人資簽核、轉單 409、對話確認部門送出）；當時有金鑰的 Gemini 路徑只有單元測試、沒有實際呼叫（之後已以有效金鑰在瀏覽器實測，見設定驅動需求類型版的紀錄）；尚未建置 Docker image，也尚未在 Lightsail 執行第 5.6 節升級或回滾

2026-11-01 的人員資料只存 SQLite 版（結構版本 3，刪除 `accounts.json`、`employees.json`）已在本機以 `npm test` 通過後端 100 項、前端 122 項測試（新增 backend/tests/personnel.test.js；前端只改兩處註解，行為不變）。另以暫存資料庫、只存在子程序的假密碼、未設定 Gemini 金鑰的真實後端確認：全新資料庫寫入 17／16／96 筆示範名冊；`set-department`、`deactivate` 不需重啟就改變處理人名單、代理人候選與登入結果；停用帳號的既有憑證回 401；`--dry-run` 不改動資料庫檔。也以本機版本 2 資料庫的複本升級到版本 3（保留 `alex.admin`、不寫入示範名冊，原檔未改動），並確認員工不在名冊時以 PERSONNEL_UNMAPPED 回滾。尚未建置 Docker image，也尚未在 Lightsail 執行第 5.7 節升級、容器內的 `personnel.js` 或回滾。

2026-11-01 的設定驅動需求類型版（`data/requestTypes/`、通用引擎 `src/services/requestTypes/`、設備申請與一般需求、AI 工具）已在本機以 `npm test` 通過後端 104 項、前端 128 項測試（新增後端 requestTypes 測試並改寫 draftFlow，含定義檔驗證失敗、請假規則不變、設備申請與一般需求流程、工具權限、引擎不含領域字串，以及只加 JSON 就能使用的新類型；前端新增依定義產生畫面的測試與領域字串掃描）。另以暫存資料庫、只存在子程序的假密碼、未設定 Gemini 金鑰的真實後端，加上前端實際的 service 模組，完成本機端對端檢查（請假：420 分鐘與剩餘時數摘要、代理人期間衝突、期間重疊 409、版本 1 送出 409、人資簽核與本人簽核 403、轉單 409；設備申請：數量與日期驗證、送達總務與硬體組、人資簽核 403、總務簽核；一般需求：選部門後送出）。之後又以有效金鑰與 `GEMINI_MODEL=gemini-3.5-flash`（暫存資料庫、假密碼）在瀏覽器實測有金鑰的 Gemini 路徑：請假主題分類為人力資源部並使用定義檔招呼語，對話中呼叫 colleagues 與 my_leave_balance 工具、填好全部欄位並算出 7 小時（事假剩餘 112 → 105 小時）並送達人力資源部；設備申請主題分類為總務與硬體組，一則訊息即填好品項、數量、用途、需要日期與送交地點，送出後由總務成員簽核並列在「已完成」。後端日誌無錯誤；含工具呼叫的回合約需十餘秒。當時 `gemini-2.5-flash` 回 404 MODEL_NOT_FOUND，因此程式預設與範本改為 `gemini-3.5-flash`。尚未建置 Docker image，也尚未在 Lightsail 執行第 5.8 節升級或回滾。

2026-11-02 的提出需求單頁調整（只透過「自動生成」送單、移除頁面層級的指定處理人、需求內容套用前唯讀、固定格式文字規則、左右排列的自動生成視窗、加寬的各部門業務範圍視窗）與本機登入簽章金鑰保存在 SQLite（畫面行為的現況見[API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.18 節），已在本機以 `npm test` 通過後端 106／106 項測試（新增 backend/tests/authSecret.test.js）；另以暫存資料庫與假密碼在瀏覽器確認：後端重新啟動後登入仍有效；自動生成視窗為左右排列；需求內容在 Apply 前唯讀；改動固定格式文字時阻擋送出；在固定文字後補充說明可以送出並送達人力資源部；沒有套用就送出時顯示「請先按「自動生成」…」並阻擋；各部門業務範圍視窗加寬；尚未建置 Docker image，也尚未在 Lightsail 更新

2026-11-02 的「提單人不能簽核自己的單」調整（`workflow.approver.not_requester` 預設改為 true、一般需求定義 `not_requester: true` 與 `transfer: true`、`DEPARTMENT` 單保存 `request_type`、沒有需求類型的舊流程單也不能本人簽核；狀態追蹤卡片對自己提出的單不顯示簽核、退回與轉單）已在本機以 `npm test` 通過後端 106／106 項、前端 128／128 項測試（改寫 draftFlow、ticketFlows、tickets 與前端 formFormatters、formTickets、ticketsPage 的相關斷言）；尚未在瀏覽器實測，也尚未建置 Docker image 或在 Lightsail 更新

2026-11-02 新增四種需求類型（打卡補登 `attendance.json`、VPN 申請 `vpn.json`、報修 `repair.json`、採購申請 `purchase.json`，只加 JSON 與目錄項目）與分類評測（`npm run eval:classify`、題庫 `backend/evals/classification-cases.json` 78 題），已在本機以 `npm test` 通過後端 114／114 項（新增 classificationEval 7 項與 requestTypes 的新類型測試）、前端 128／128 項測試；另以暫存資料庫與假密碼在瀏覽器確認：主題「會議室辦公椅故障」在沒有 AI 時以關鍵字選到報修，處理部門鎖定總務與硬體組，手動填完欄位後 Apply、送出（依表單規則送達），總務與硬體組的帳號在狀態追蹤頁看到逐列的報修欄位與轉單區塊並簽核成功；分類評測：關鍵字備援為類型準確度 47.4%（37／78）；AI 評測沒有完成，原因是 `backend/.env` 的 `GEMINI_MODEL=gemini-2.5-flash` 回 404，改用 `gemini-3.5-flash`（只在執行時以環境變數指定，沒有修改 `.env`）後，試跑的 3 題中 2 題回應且判斷正確（報修、VPN 申請），1 題為上游錯誤；接著這把金鑰回 429 `RATE_LIMIT_OR_QUOTA`，完整 78 題沒有結果；尚未建置 Docker image，也尚未在 Lightsail 更新

2026-11-02 的 Claude 版實作（新增 `claudeAssistant.js`、`ticketJudgeClaude.js`、`aiProviders.js`；當時預設供應商為 Claude，同日稍後改為 Gemini 為主、Claude 備援，見下一段）已在本機以 `npm test` 通過後端 120／120 項（新增 claudeProvider 5 項、env 的供應商設定 1 項）、前端 128／128 項測試；Claude 路徑以替身 client 驗證請求參數（effort low、`output_config.format`、伺服器端 fallback、不送 temperature 與強制 tool_choice）、工具流程與錯誤對應（Claude 呼叫參數的現況見規格書第 1 節「AI 供應商」）；之後在本機 `backend/.env` 設定 `ANTHROPIC_API_KEY` 實際呼叫 Claude（`claude-sonnet-5-5`）：分類評測 78 題 × 1 輪，類型與部門準確度都是 100%（78／78，邊界題 16／16，沒有呼叫失敗；同一份題庫的關鍵字備援為 47.4%）；另以暫存資料庫與假密碼在瀏覽器確認：主題「會議室的辦公椅椅腳斷了」（不含任何關鍵字）由 Claude 判斷為報修並送總務與硬體組；在對話補充位置、狀況與「可以指定誰處理？」後，Claude 呼叫一次 `department_members` 回答可指定的處理人（這個工具與指定處理人之後已從所有定義移除，見下方視窗精簡的紀錄），並填好全部欄位；套用後送出為「依表單規則送達」；部署前請先讀第 5.10 節

2026-11-02 稍後依使用者要求改為「Gemini 為主、Claude 備援」（合作夥伴主要使用 Gemini）：`AI_PROVIDER` 預設 `gemini`；Claude 有金鑰時，Gemini 在 3 秒內回 429 才改用 Claude，之後冷卻 60 秒；production 只要求主要供應商的金鑰，原本只設 Gemini 的主機不需改設定。已在本機以 `npm test` 通過後端 123／123 項（新增供應商順序、自動生成與 AI 判斷部門的切換測試 3 項）、前端 128／128 項。本機 `backend/.env` 同步改為 `AI_PROVIDER=gemini`，並把會回 404 的 `GEMINI_MODEL=gemini-2.5-flash` 改為 `gemini-3.5-flash`；以這份設定實際試跑 2 題分類，都由 `gemini-3.5-flash` 回答且正確。Gemini 實際回 429 再切換到 Claude 的過程只以替身測試驗證，沒有在真實額度用完時觀察到。

2026-11-02 的「自動生成」視窗精簡（不顯示判斷結果、需求內容預覽與指定處理人；處理部門只在一般需求這類沒有固定部門的類型顯示；全部定義移除 `handler` 與 `department_members` 工具，帶 `form` 送出時有 `handler_id` 回 400）、視窗放大到最大 1760×1200、訊息輸入框改為一列，以及前端 `npm run dev` 改用 `node scripts/dev-server.js`（回應帶 `Cache-Control: no-cache`，取代 Python 的 http.server；目前的啟動方式見 [README](../README.md)「本機啟動」），已在本機以 `npm test` 通過後端 124／124 項、前端 129／129 項；另以暫存資料庫、假密碼與暫用連接埠（3001、5174）在瀏覽器確認：請假的視窗不顯示判斷結果、處理部門、指定處理人與預覽；一般需求顯示處理部門下拉、沒有指定處理人；輸入框一列且與送出按鈕同高；這次實測 Gemini 對「座位調整」的第一回合回了未通過格式驗證的內容（`response.validate`，AI_INVALID_RESPONSE），畫面改由手動填寫，與這次修改無關；web 與 backend image 這次都要重新建置（前端頁面與後端定義檔都有變更）

2026-11-02 依使用者提供的後端日誌修正：使用者在請假對話問「我的病假剩幾天?」時，Gemini 的工具階段沒有呼叫查詢時數的工具，接著整理階段回 503（`UPSTREAM_UNAVAILABLE`），因為當時只有 429 會切換，畫面顯示「AI 助手暫時無法回應」。修正為 503、529 也改用備援，時限改為自動生成 8 秒、AI 判斷部門 4 秒；Gemini 輸出上限調高並記錄 `finishReason` 與 `thoughtUsage`。已在本機以 `npm test` 通過後端 124／124 項；另以暫存後端實際重現同一段對話：Gemini 完成第一回合分類（`STOP`，思考 488、輸出 80 token），第二回合 Gemini 回 429，自動改用 Claude，Claude 呼叫 `my_leave_balance` 並回答病假剩 240 小時 0 分鐘。Gemini 回 503 再切換的路徑以替身測試驗證；第一回合「回應格式異常」的原因尚未確認（這次分類沒有被截斷），之後可從 `gemini.generate.completed` 的 `finishReason` 判斷。

2026-11-02 依使用者要求改為「Gemini 任何失敗都改用 Claude」：有 Claude 金鑰時，使用者不應看到 Gemini 的錯誤訊息；有備援時 Gemini 期限 10 秒、Claude 15 秒（AI 判斷部門 6＋12 秒），兩段加起來仍在前端等待上限內（各期限的現況見規格書第 1 節「AI 供應商」）；已在本機以 `npm test` 通過後端 124／124 項；另以錯誤的 Gemini 模型名稱（回 404）啟動暫存後端，重跑「請假 → 我的病假剩幾天?」：第一回合 Gemini 404 後由 Claude 完成分類，第二回合在冷卻期間直接由 Claude 呼叫 `my_leave_balance` 並回答病假剩 240 小時 0 分鐘，兩回合共約 7.6 秒，沒有出現錯誤訊息；尚未建置 Docker image，也尚未在 Lightsail 更新

## 10. 公開部署驗收記錄（2026-10-29）

依操作者逐步提供的指令輸出、畫面與操作確認，已完成單台 Lightsail、Docker Compose、Caddy 與自訂網域部署：

| 項目 | 已確認結果 |
| --- | --- |
| 公開前端 | https://alex-lin-lab.com/helpdesk/ 可直接使用，不依賴 SSH 通道 |
| 公開 API 與憑證 | curl 未略過憑證驗證，/helpdesk/api/health 成功回傳 status=ok |
| DNS | Cloudflare A 記錄使用 DNS only，解析至 Lightsail 固定 IPv4 |
| 主機 | Ubuntu 24.04、linux/amd64；Docker 與 Compose 可正常執行 |
| 一般功能 | 公開 HTTPS 登入、指定處理人送單、查詢正常 |
| Gemini | 未指定處理人的送單完成 generate、judge、record.saved，同一次 requestId；當次模型為 gemini-3.5-flash-lite |
| 工作單持久化 | 重建 backend 後，原有工作單仍可查詢 |
| 管理功能 | 公開 HTTPS 管理員登入及監測自動更新正常；清除操作未在本次公開驗收中執行 |
| 更新方法 | 保留 Mac Docker Desktop 原設定，改於 Lightsail 建置新版 web image，通過 /helpdesk 路由驗證 |
| 離機備份 | 已從 volume 複製工作單至雲端備份，再下載到 Mac 的 backups/；本機驗證為可解析的 JSON 陣列、3181 bytes、權限 600，且被 Git 忽略（當時為 JSON 儲存版；目前的備份是第 6.2 節 `db-backup.js` 產生的 .db，JSON 只由 `export-tickets-json.js` 匯出供回滾 JSON 版 image） |

此次雲端還原演練尚未執行；JSON 格式有效不等於完整業務還原已驗收；改為 SQLite 後，第 6.3 節的還原也還沒有在 Lightsail 演練的紀錄；備份目前為手動操作，建議課前／課後與部署前執行，並保留必要的離機版本；應用程式秘密須另外私下保存，不放進工作單備份或本文件

目前沒有第二個專案的執行服務；/project-b/ 保留為未來規劃，回傳 404。仍為單台主機、單一後端程序；配額與限流計數於後端重啟時歸零。關閉舊的 localhost:8080 SSH 通道不會停止公開網站；關閉管理 SSH 終端機也不會停止以 Compose 背景模式啟動的容器。

## 11. 自動化測試範圍

這些測試在部署前於本機執行；以下項數為 2026-11-04 在 Node.js 22.23.4 實際執行的結果，之後新增測試時會變動

- 執行方式：在 `backend/` 與 `frontend/` 各執行 `npm test`（`node --test`），目前後端 129 項、前端 137 項，都不呼叫 Claude 或 Gemini
- 後端 `tests/` 涵蓋 API、環境參數、日誌、保護、限流、可靠性、管理本文限制、需求單、資料庫、人員資料、需求類型定義與引擎（requestTypes）、自動生成與各類型流程（draftFlow）、分類評測的題庫與計分（classificationEval）、本機登入簽章金鑰（authSecret）；測試使用 `:memory:` 或暫存檔，不會碰到 `data/helpdesk.db`，並以替身取代 Gemini 與 Claude；claudeProvider 測試 Claude 的請求參數、工具流程與錯誤對應
- 前端 `tests/` 含開發伺服器的路徑檢查（devServer.test.js），以 fetch 與 DOM 替身驗證請求合約、欄位驗證、錯誤提示、倒數、卡片動作狀態、頁面網址與頁面流程；瀏覽器替身為 `tests/helpers/fakeDom.js`（含自動生成視窗的節點與 DRAFT_DIALOG_IDS），注入的假服務為 `tests/helpers/draftFixtures.js`（含請假 v2、設備申請與一般需求的假定義與回應）；不驗證版面，也不呼叫付費 API 或真後端，自動生成視窗只用注入的假服務測試，實際串接要啟動後端並在頁面操作
- 前端「自動生成」相關測試：draftService.test.js（請求與回應整理，含 30 秒逾時）、draftDialog.test.js（視窗互動，含只靠定義就能顯示的設備申請與一個虛構的未來類型）、proposeDraft.test.js（與提出需求單頁的整合）、formFormatters.test.js（表單格式）、formTickets.test.js（表單需求單卡片）、ticketsPage.test.js（需求類型目錄的載入）
- 領域字串掃描：`backend/tests/requestTypes.test.js` 掃描後端程式，`frontend/tests/genericRequestTypes.test.js` 掃描前端 `src/` 與 `pages/` 的程式（不含註解）；出現任何類型的 id、欄位 key 或領域用語（例如請假或設備申請的欄位 key）就失敗，新增擴充點的程式同樣不可以出現
- 新增需求類型後：分類評測題庫在 `npm test` 會被檢查（類型與部門必須存在、主題不可重複、每種類型至少 8 題）；完成前確認本機啟動有 `request_types.ready`、實際操作送出並簽核一次、`npm test` 通過（部署步驟見第 5.9 節）
