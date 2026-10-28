# Docker 與 Lightsail 部署操作手冊

本專案目前採用「單台 AWS Lightsail Linux 主機＋Docker Compose＋Caddy」。前後端使用同一個 HTTPS 網址，不需要 GitHub Pages、Elastic Beanstalk、CloudFront、ALB 或資料庫。只使用 local、production 兩種環境，後端為 Node.js 22 單一程序。建立雲端資源與購買網域由操作者依本文執行；加入設定檔不代表已完成雲端部署。

## 1. 先理解各元件

```text
瀏覽器 → Caddy（80／443；前端、HTTPS、/api 代理）
                ├─ HTML、CSS、JavaScript
                └─ backend:3000（Docker 內部，未發布主機 port）
                       ├─ Node.js 22：登入、工作單、管理、限量限流
                       ├─ Gemini API：只有未指定處理人時呼叫
                       └─ /app/storage/tickets.json → tickets volume
```

| 檔案／元件 | 用途與理由 |
| --- | --- |
| `backend/Dockerfile` | 固定 Node.js 22、以 lockfile 安裝依賴、使用非 root 帳號執行，直接接收關機訊號 |
| `backend/docker-healthcheck.js` | 檢查本容器 /api/health，不登入、不寫單、不呼叫 AI |
| `deploy/web.Dockerfile` | 將網站資產與 Caddy 設定包成另一個 image，沒有前端建置工具需求 |
| `deploy/Caddyfile` | 靜態網站與 /api 代理；正式網域可自動申請、更新 HTTPS 憑證 |
| `compose.yaml` | 定義兩個服務、內部網路、資料 volume、健康等待、日誌輪替、停止寬限 |
| 根目錄 `.env.example` | Docker 參數範本；複製成根目錄 `.env` 私下填寫，不提交 Git |

Compose 是一次管理兩個容器，不是把所有程式塞進同一個容器。前端 service、component 與 API 合約維持既有分工。資料與程式 image 分離，更新程式不必清除工作單。

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

用編輯器開啟根目錄 `.env`，私下填入兩組不同的 `DEMO_PASSWORD`、`ADMIN_PASSWORD`。不要把密碼或金鑰貼進 README、Git、截圖或聊天。若值含 `$` 或 `#`，以單引號包住整個值。

| 參數 | 本機設定與原因 |
| --- | --- |
| NODE_ENV | local；只區分 local／production |
| SITE_ADDRESS | http://localhost；本機先驗證 HTTP，不申請公開憑證 |
| CORS_ORIGIN | http://localhost:8080；與本機網站來源一致 |
| HTTP_BIND／HTTP_PORT | 127.0.0.1／8080；僅本機可進入 |
| HTTPS_BIND／HTTPS_PORT | 127.0.0.1／8443；本機 HTTP 模式不會提供正式 HTTPS |
| DEMO_PASSWORD | 十個一般帳號的共用密碼，必填，沒有預設值 |
| ADMIN_PASSWORD | 應用程式 alex.admin 的獨立密碼；不是 AWS 密碼 |
| AUTH_SECRET | 正式必填，至少 32 bytes；本機也建議設定，避免重啟失去登入 |
| GEMINI_API_KEY | 本機若只測指定處理人可留空；測 AI 與正式啟動都須填入有效金鑰 |
| GEMINI_MODEL | 填入你的金鑰已驗證可使用的模型，不保證範本模型在你的專案可用 |

可在私人的終端機產生 AUTH_SECRET，再存入未追蹤的 `.env`；指令輸出不要分享：

```bash
openssl rand -hex 32
```

原本 `backend/.env` 保留給 `npm start` 使用，Compose 不讀它。Compose 將根目錄 `.env` 的值注入容器；production 後端只讀程序環境，image 不包含 `.env`。這兩份檔案的修改不會互相同步。

### 2.3 檢查、建立及啟動

```bash
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
curl --fail http://localhost:8080/api/health
```

`config --quiet` 檢查 Compose 語法，不印出展開後的秘密。不要把一般 `docker compose config`、容器環境或 inspect 完整結果貼給他人。

第一次建立會下載 Node 與 Caddy image、安裝 npm 依賴，時間較長。`--wait` 等後端健康後才完成；預期 backend 為 healthy、web 為 running，health 回傳：

```json
{"success":true,"data":{"status":"ok"}}
```

健康端點只驗證 HTTP 程序，不能證明 Gemini 或工作單磁碟都正常。healthcheck 不會自動重啟卡住但未退出的程序。

瀏覽器開啟 **http://localhost:8080/**。不用另外執行後端 npm start 或前端 Python server。原本 localhost:5173 的開發方式仍保留，該模式連 localhost:3000；Docker 頁面則自動使用目前網站的 /api。

### 2.4 功能驗收

1. 一般帳號登入，先指定一位一般處理人送單，確認成功、查詢得到；這條路徑不呼叫 Gemini。
2. 重新建立後端容器：`docker compose up -d --force-recreate --wait backend`，重新整理查詢，工作單應保留。記憶體限量會重置；未設定固定 AUTH_SECRET 時須重新登入。
3. 設定有效 Gemini 金鑰後，不指定處理人送一張單，確認 AI 判斷與管理頁額度變化；這一步可能產生模型費用。
4. alex.admin 登入管理頁，確認監測能更新；清除測試工作單前確認資料可刪，再完整輸入確認文字操作。
5. 一般使用者不能呼叫管理 API；管理員不能進入工作單 API。

新 Docker volume 與本機 `backend/data/tickets.json` 無關。首次沒有檔案時視為空陣列，第一次成功寫入才產生 JSON，不會自動搬入既有工作單。

### 2.5 日常指令

```bash
docker compose logs --tail=100 backend
docker compose logs --tail=100 web
docker compose logs -f backend
docker compose stop
docker compose start
docker compose down
```

`logs -f` 用 Control+C 離開；不會停止服務。`stop` 保留容器與 volume；`down` 移除本專案容器與網路、保留 volume。不要加 `-v`，不要用 Docker Desktop 刪除資料 volume，也不要執行會清除 volume 的清理指令。Compose 的日誌輪替上限為每服務 3 個 10 MB 檔，不是總磁碟空間上限。

## 3. 第二階段：建立 Lightsail 主機

### 3.1 選擇方案

1. 用目前 AWS Console 身分開啟 Amazon Lightsail，區域選 Tokyo／ap-northeast-1。
2. 選 **Create instance → Linux/Unix → OS Only → Ubuntu 24.04 LTS**。這是虛擬主機，不是 Lightsail Container Service。
3. 選含公有 IPv4 的方案，先用 1 GB RAM。確認建立頁的實際月費及稅金，不把短期優惠當作永久價格。
4. 命名 `helpdesk-docker`，選擇 SSH key pair；保管可下載的私鑰。它用來連線 Linux，不是 AWS Access Key。
5. 第一次可先不啟用付費的自動快照，待第 7 節確認備份與成本後決定。建立主機即可能開始計費。

官方目前列出的含 IPv4 Linux 方案為 1 GB／40 GB SSD：US$7／月，2 GB／60 GB SSD：US$12／月。用 US$1≈NT$33 作規劃分別約 NT$231、NT$396，不含稅、網域、備份、額外傳輸及 Gemini。若總預算 NT$500 包含 AI，先用 1 GB 留下餘裕；實際課堂測試若記憶體不足再評估升級。參考 [Lightsail 價格](https://aws.amazon.com/lightsail/pricing/)。

Lightsail 的網路由 AWS 管理，不直接使用你先前建立的 helpdesk-vpc 與兩個 public subnet。這次不需要新增 NAT Gateway、ALB、EB 角色或資料庫；不會修改既有 VPC。參考 [AWS Lightsail 與 EC2 比較](https://repost.aws/knowledge-center/lightsail-differences-from-ec2)。

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

購買網域或使用已有網域的子網域，例如 `helpdesk.example.com`。到實際管理 DNS 的平台新增：

| 類型 | 名稱 | 值 |
| --- | --- | --- |
| A | helpdesk | Lightsail Static IPv4 |

若使用已有 DNS 平台，可直接在該平台新增記錄，不必另外付費建立 Route 53 hosted zone。首次先保持直接 DNS 指向主機，不啟用其他 CDN 代理。正式啟動前從 Mac 執行 `dig +short helpdesk.example.com A`，確認解析到 Static IP。網域名稱必須替換成實際值，example.com 只是範例。

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

images 不包含本機 .env 或 tickets.json。未使用 image registry，不必建立 ECR 權限或公開 image。之後每次更新都要重做建置與傳送，單純修改原始碼不會改變已執行容器。

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
SITE_ADDRESS=helpdesk.example.com
CORS_ORIGIN=https://helpdesk.example.com
HTTP_BIND=0.0.0.0
HTTP_PORT=80
HTTPS_BIND=0.0.0.0
HTTPS_PORT=443
```

再私下填入 GEMINI_API_KEY、已驗證的 GEMINI_MODEL、兩組不同密碼，以及至少 32 bytes 的固定 AUTH_SECRET。範例不提供任何可用密碼或金鑰。CORS_ORIGIN 不加結尾斜線或頁面路徑。SITE_ADDRESS 正式不加 `http://`，讓 Caddy 啟用自動 HTTPS。

Compose 固定後端 PORT=3000、TRUST_PROXY=1、ORIGIN_VERIFY_SECRET 為空、LIMIT_STORE=memory、TICKETS_FILE=/app/storage/tickets.json。不要把舊的 CloudFront 來源秘密帶入這個架構。只有 Caddy 對外，Caddy 依實際連線建立來源資訊；不要另加 backend ports，否則單跳信任條件失效。

### 4.5 正式啟動與驗收

```bash
sudo docker compose config --quiet
sudo docker compose up -d --no-build --pull never --wait
sudo docker compose ps
sudo docker compose logs --tail=100 web
sudo docker compose logs --tail=100 backend
```

`--no-build --pull never` 使用剛載入的 images，不在雲端重建或到 registry 找 helpdesk 私有程式。等待 DNS／憑證完成後，在 Mac 執行：

```bash
curl --fail https://helpdesk.example.com/api/health
curl -I http://helpdesk.example.com/
```

第一個預期成功回 health JSON；第二個應導向 HTTPS。不要用 `curl -k` 當作 TLS 驗收通過。HTTP health／Docker healthy 不代表公開憑證已成功。

正式驗收：

- 瀏覽器開 HTTPS 首頁，憑證有效、沒有 mixed content；Network 的 /api 請求送到同一網站，沒有送往同學的 localhost。
- 指定處理人送單、查詢、簽核／退回／轉單／取消正常，再用一張單驗證 Gemini。
- 管理員登入只進管理頁，監測輪詢正常；一般帳號的管理 API 為 403。
- 更換後端容器後工作單保留；固定 AUTH_SECRET 不變時憑證仍可驗證，保護計數重啟歸零。
- 從不同網路測試，再送入假的 X-Forwarded-For，確認不能藉偽造來源繞過 IP 限流；學校 Wi-Fi 共用出口仍會共享 IP 視窗，帳號配額維持分開。
- 3000 沒有主機 port mapping，也沒有在 Lightsail firewall 開放。

## 5. 上線後的更新與回復

先備份工作單與私下保存的設定，再於 Mac 重新建置正確架構的 images、匯出並用 scp 傳送。不要使用 Git 裡未提交的舊版本當成已上線版本；建議每次記下部署的 commit 與日期，並保留上一版 image 匯出檔於本機。

在 Lightsail 更新：

```bash
cd ~/helpdesk_agent
sudo docker load -i helpdesk-images.tar
sudo docker compose up -d --no-build --pull never --wait
```

同一個 ~/helpdesk_agent、同一份 Compose project name `helpdesk` 才會沿用原 volume。更新會短暫中斷，記憶體配額與頻率計數會歸零；不要使用多副本避免中斷，這個儲存設計不支援多程序。

只改 `.env` 時也執行上述 up 指令讓容器重建；`docker compose restart` 不會載入修改後的環境設定。回復程式則載入上一版 image 匯出檔再執行 up；若資料格式有變更，先確認備份與程式版本相容。

## 6. 工作單清除、備份與還原

### 6.1 清除方式

使用既有管理頁的清除功能，同步清空 JSON、程序快取與一般保護計數。不要直接在執行中的 volume 編輯 JSON；程序快取可能把舊資料寫回去。管理重置不會刪除備份或退還 Gemini 費用。

volume 位於 Docker 管理的儲存空間；主機原始碼目錄中的 backend/data/tickets.json 不是容器正在使用的檔案。

### 6.2 備份

至少成功寫入一張工作單後，在部署目錄執行：

```bash
mkdir -p backups
chmod 700 backups
HELPDESK_BACKUP="backups/tickets-$(date +%Y%m%d-%H%M%S).json"
sudo docker compose cp backend:/app/storage/tickets.json "$HELPDESK_BACKUP"
sudo chown "$(id -u):$(id -g)" "$HELPDESK_BACKUP"
chmod 600 "$HELPDESK_BACKUP"
```

程式以暫存檔改名原子替換，複製會取得某個完整版本，不包含尚未完成的請求。尚未產生 JSON 時 cp 會提示找不到檔案，不代表既有資料被刪除。將備份安全下載到 Mac；只放同一台 Lightsail 無法應對整台主機遺失。

先採課前／課後手動備份與每週離機保存，保留必要份數；有持續使用需求再評估自動備份及快照費用。私下另存 `.env`，工作單備份不包含登入秘密與設定。

### 6.3 還原（維護時執行）

這會覆寫所有目前工作單。先確認檔案正確並另做目前資料備份，再把要還原的檔案放成 `backups/tickets-restore.json`。用停止後端的方式排空既有工作並移除快取：

```bash
sudo docker compose stop backend
sudo docker compose run --rm --no-deps --user 0:0 \
  -v "$PWD/backups:/backup:ro" backend \
  node --input-type=module -e '
import { readFile, writeFile, rename, chown, chmod } from "node:fs/promises";
const text = await readFile("/backup/tickets-restore.json", "utf8");
if (!Array.isArray(JSON.parse(text))) throw new Error("備份必須是 JSON 陣列");
const file = process.env.TICKETS_FILE;
await writeFile(`${file}.tmp`, text, "utf8");
await rename(`${file}.tmp`, file);
await chown(file, 1000, 1000);
await chmod(file, 0o600);
'
sudo docker compose up -d --no-build --pull never --wait
```

這個一次性維護容器暫用 root 讀取私有備份，還原後將檔案交回官方 Node image 的 node 使用者（UID／GID 1000）並限制為 600；正式服務仍以非 root 執行。若更換基底 image，先確認 UID／GID。只檢查 JSON 陣列不是完整業務格式驗證，應使用本系統匯出、與目前版本相容的備份。若還原指令失敗，先排查，不直接宣稱完成；重新啟動前確認檔案內容與擁有者。

## 7. 持續使用的限制與成本

- tickets volume 可跨容器重建保存，但主機、磁碟或 volume 被刪除仍可能遺失。`docker compose down -v` 也會刪除工作單與 Caddy 憑證資料。volume 不等於備份，詳見 [Docker volumes](https://docs.docker.com/engine/storage/volumes/)。
- 所有配額、HTTP 頻率、登入失敗與並行租約仍存在記憶體。程序重啟後清零，不能當作金額硬上限；不要用反覆重啟作為課堂清額操作。
- 設定費用通知並查看 Gemini 用量；AWS 通知不涵蓋 Gemini，費用通知也不等於自動停機。NT$500 預算須包含稅金、網域年費攤提、備份與模型費用。
- 保留單一後端程序，不開 PM2 cluster、不增加副本。主機更新、Docker 更新與應用程式部署可能短暫中斷，安排在課後。
- 停止 Lightsail instance 不等於停止計費；課程結束時，先下載備份與設定，再依 AWS 計費規則處理不用的主機、快照、固定 IP 及其他資源，不能只按停止就當作已取消。參考 [Lightsail instance FAQ](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-instances.html)。

## 8. 常見問題

| 現象 | 排查方向 |
| --- | --- |
| 缺少 ADMIN_PASSWORD／DEMO_PASSWORD | 編輯的是根目錄 .env 嗎？值是否空白？兩個值是否不同？ |
| production 啟動失敗 | 檢查 GEMINI_API_KEY、CORS_ORIGIN、AUTH_SECRET；不貼出實際值 |
| 502／backend 不健康 | 查看 backend 日誌、環境參數與 health；健康等待約數十秒，不能只看 web 啟動 |
| 503 TICKET_STORE_UNAVAILABLE | 檢查 /app/storage 是否可由 node 使用者寫入、磁碟是否已滿；不手動清 JSON |
| 瀏覽器仍呼叫 localhost:3000 | 是否還在 localhost:5173，或正式 image／瀏覽器資產尚未更新？重新建置 web 並重新整理 |
| 公開 HTTPS 失敗 | DNS A 是否指向固定 IP？80／443 是否開放？SITE_ADDRESS 是否仍為 http://localhost？查看 Caddy 日誌 |
| exec format error | image 架構與 Lightsail uname -m 不一致，依正確 platform 重建 |
| 本機 8080／8443 被占用 | 改根目錄 .env 的 port 與 CORS_ORIGIN；本機 SITE_ADDRESS 保持 http://localhost |
| 重建後看不到工作單 | 是否改了 project name、主機或刪 volume？是否把本機原始 JSON 當成容器資料？ |

本機故障先看 `docker compose ps` 與兩個服務的日誌。正式故障使用相同指令加 sudo；不要為了排錯開放 backend port、停用憑證檢查或公開環境檔。

## 9. 本次驗證範圍（2026-10-28）

本機已建立兩個 images，通過前端 62 項測試及 image 內的後端 51 項測試。另以假的測試帳密、獨立 Compose project 與新 volume 驗證網站資產、API 代理、登入、角色隔離、管理監測、工作單寫入、容器重建後保留、固定 JWT、偽造來源標頭不改變 IP 視窗、管理重置、備份與還原後繼續寫入。已確認後端 image 不含 .env、真實工作單或測試檔，且以非 root 執行；Caddy 本機與正式網域設定通過語法驗證。

建置時發現的 body-parser 與 qs 漏洞已在既有版本範圍內更新 lockfile，當次 npm audit 為 0；這是當時的檢查結果，不代表日後沒有新公告。測試未呼叫 Gemini，未修改本機原始工作單，未建立 AWS 資源；真正的 DNS、公開憑證、雲端容量與付費模型串接仍須依上述步驟驗收。
