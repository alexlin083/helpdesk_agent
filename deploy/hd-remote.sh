#!/usr/bin/env bash
# hd-remote.sh：在 Lightsail 主機上執行的部署輔助腳本。
# 由本機的 deploy/hd 在每次 push／deploy／rollback／status 時上傳到 ~/<部署目錄>/.hd/hd-remote.sh 再透過 SSH 執行，
# 不需要手動安裝；請不要直接修改主機上的副本（下次執行時會被覆蓋）。
#
# 用法（由 deploy/hd 呼叫）：
#   hd-remote.sh <部署目錄> load <tag> <backend image ID> <web image ID>
#   hd-remote.sh <部署目錄> deploy <tag> [--yes] [--force]
#   hd-remote.sh <部署目錄> rollback [tag] [--yes]
#   hd-remote.sh <部署目錄> status
#
# 版本的規則：image 以 helpdesk-backend:<tag>、helpdesk-web:<tag> 保存；compose.yaml 固定使用 :latest，
# 部署就是把 <tag> 指到 latest，上一版指到 prod-rb（回滾用）；版本資訊來自 image 的 GIT_TAG 標籤。
set -euo pipefail

BACKEND=helpdesk-backend
WEB=helpdesk-web
TAG_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
KEEP_VERSIONS="${HD_KEEP_VERSIONS:-5}"

# 輸出訊息：info 一般步驟、warn 需要注意、die 中止並以非零結束。
info() { printf '  %s\n' "$*"; }
step() { printf '\n▶ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*" >&2; }
die() { printf '\n❌ %s\n' "$*" >&2; exit 1; }

# 詢問是否繼續；ASSUME_YES=1 時直接同意。預設答案由第二個參數決定（Y 或 N）。
confirm() {
  local question="$1" default="${2:-N}" answer
  if [ "${ASSUME_YES:-0}" = 1 ]; then return 0; fi
  if [ "$default" = Y ]; then read -r -p "  $question (Y/n) " answer || true; [ -z "$answer" ] || [[ "$answer" == [Yy]* ]]
  else read -r -p "  $question (y/N) " answer || true; [[ "$answer" == [Yy]* ]]; fi
}

# 檢查版本 tag 格式，避免把任意字串帶進 docker 指令。
valid_tag() { [[ "$1" =~ $TAG_PATTERN ]] || die "版本 tag 格式不正確：$1"; }

# 取得 image 的完整 ID；不存在時回空字串。
image_id() { sudo docker image inspect "$1" --format '{{.Id}}' 2>/dev/null || true; }

# 取得 image 的版本標籤（GIT_TAG）；沒有標籤的舊 image 回「未標記」。
image_version() {
  local value
  value="$(sudo docker image inspect "$1" --format '{{index .Config.Labels "GIT_TAG"}}' 2>/dev/null || true)"
  if [ -z "$value" ] || [ "$value" = '<no value>' ]; then echo '未標記'; else echo "$value"; fi
}

# 目前容器實際執行的 image ID（容器不存在時回空字串）。
running_id() { sudo docker inspect "$1" --format '{{.Image}}' 2>/dev/null || true; }

# 把來源 tag 指到目標 tag（backend 與 web 一起）。
retag_pair() {
  sudo docker tag "$BACKEND:$1" "$BACKEND:$2"
  sudo docker tag "$WEB:$1" "$WEB:$2"
}

# 以新的 latest 重建容器並等待健康檢查；失敗時回傳非零。
compose_up() {
  sudo docker compose up -d --no-build --pull never --wait --wait-timeout 180
}

# 從啟動後的日誌確認新版本：等待 server.started 出現（最多 60 秒），檢查版本與啟動失敗事件，並列出重點欄位。
# 參數：日誌起始時間（UTC ISO）與預期版本（未標記的舊版傳空字串，略過版本比對）。
verify_startup() {
  local since="$1" expected="$2" logs started version tries=0
  while :; do
    logs="$(sudo docker compose logs --no-log-prefix --since "$since" backend 2>/dev/null || true)"
    started="$(printf '%s\n' "$logs" | grep '"event":"server.started"' | tail -1 || true)"
    [ -n "$started" ] && break
    tries=$((tries + 1))
    [ "$tries" -ge 30 ] && { warn '60 秒內沒有看到 server.started，請執行 ./deploy/hd status 檢查'; return 1; }
    sleep 2
  done
  if printf '%s\n' "$logs" | grep -qE '"event":"(server|storage|request_types)\.failed"'; then
    warn '日誌出現啟動失敗事件：'
    printf '%s\n' "$logs" | grep -E '"event":"(server|storage|request_types)\.failed"' | tail -3 >&2
    return 1
  fi
  version="$(printf '%s' "$started" | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || true)"
  if [ -n "$expected" ] && [ "$version" != "$expected" ]; then
    warn "server.started 的版本是「${version:-未標記}」，預期是 $expected"
    return 1
  fi
  local field
  for field in version commit aiProvider model aiFallbackProvider nodeEnv corsOrigin; do
    info "$field: $(printf '%s' "$started" | grep -o "\"$field\":\"[^\"]*\"" | cut -d'"' -f4 || true)"
  done
  info "credentialsConfigured: $(printf '%s' "$started" | grep -o '"credentialsConfigured":[a-z]*' | cut -d: -f2 || true)"
  info "schemaVersion: $(printf '%s\n' "$logs" | grep '"event":"storage.ready"' | tail -1 | grep -o '"schemaVersion":[0-9]*' | cut -d: -f2 || true)"
  if printf '%s\n' "$logs" | grep -q '"event":"server.credentials.missing"'; then warn '出現 server.credentials.missing：主要 AI 供應商的金鑰沒有讀到'; fi
  return 0
}

# 列出主機上所有版本 tag（依建立時間由新到舊）。
version_tags() {
  sudo docker image ls "$BACKEND" --format '{{.CreatedAt}}|{{.Tag}}' \
    | grep -E '\|[A-Za-z0-9][A-Za-z0-9._-]*-[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$' | sort -r | cut -d'|' -f2 || true
}

# 清理舊版本：保留最新 KEEP_VERSIONS 個版本，以及目前執行中（latest）與回滾用（prod-rb）的版本；
# 只移除 tag，image 沒有其他 tag 時 Docker 才會刪除；最後清掉沒有 tag 的懸空 image。
prune_versions() {
  local keep_latest keep_rb count=0 tag removed=0
  keep_latest="$(image_id "$BACKEND:latest")"
  keep_rb="$(image_id "$BACKEND:prod-rb")"
  for tag in $(version_tags); do
    count=$((count + 1))
    [ "$count" -le "$KEEP_VERSIONS" ] && continue
    local id; id="$(image_id "$BACKEND:$tag")"
    if [ "$id" = "$keep_latest" ] || [ "$id" = "$keep_rb" ]; then continue; fi
    sudo docker rmi "$BACKEND:$tag" "$WEB:$tag" >/dev/null 2>&1 || true
    rm -rf ".hd/releases/$tag"
    removed=$((removed + 1))
  done
  sudo docker image prune -f >/dev/null 2>&1 || true
  info "保留最近 $KEEP_VERSIONS 個版本，這次清除 $removed 個舊版本"
}

# load：解壓並載入 push 上傳的 image，核對 image ID 與本機建置的一致，成功後刪除壓縮檔以節省空間。
cmd_load() {
  local tag="$1" backend_id="$2" web_id="$3" archive
  valid_tag "$tag"
  archive=".hd/releases/$tag/images.tar.gz"
  [ -f "$archive" ] || die "找不到 $archive，上傳可能沒有完成"
  step "載入 image（$tag）"
  gunzip -c "$archive" | sudo docker load
  [ "$(image_id "$BACKEND:$tag")" = "$backend_id" ] || die "主機上 $BACKEND:$tag 的 ID 和本機建置的不同"
  [ "$(image_id "$WEB:$tag")" = "$web_id" ] || die "主機上 $WEB:$tag 的 ID 和本機建置的不同"
  rm -f "$archive"
  info "image ID 與本機一致：backend ${backend_id:7:12}、web ${web_id:7:12}"
}

# 比對 .env.example 與 .env 的設定名稱（不讀取值），列出 .env 缺少的項目；有缺少時詢問是否繼續。
check_env_keys() {
  local example="$1" missing
  [ -f .env ] || die '部署目錄沒有 .env'
  [ -f "$example" ] || { warn "找不到 $example，略過 .env 檢查"; return 0; }
  missing="$(grep -oE '^[A-Z][A-Z0-9_]*=' "$example" | tr -d '=' | sort -u | while read -r key; do
    grep -qE "^${key}=" .env || echo "$key"; done)"
  if [ -n "$missing" ]; then
    warn "這個版本的 .env.example 有以下設定，但主機的 .env 沒有（有預設值的可以不加）："
    printf '      %s\n' $missing >&2
    confirm '仍要繼續部署？' N || die '已取消。請先依文件更新主機的 .env'
  else
    info '.env 包含這個版本範本列出的所有設定名稱'
  fi
}

# compose.yaml 有變更時顯示差異，確認後備份舊檔再換上新版；備份檔名記在 COMPOSE_BACKUP，啟動失敗回滾時用來還原。
COMPOSE_BACKUP=''
sync_compose() {
  local incoming="$1" tag="$2"
  [ -f "$incoming" ] || { warn "找不到 $incoming，沿用目前的 compose.yaml"; return 0; }
  if cmp -s "$incoming" compose.yaml; then info 'compose.yaml 沒有變更'; return 0; fi
  warn '這個版本的 compose.yaml 與主機上的不同：'
  diff -u compose.yaml "$incoming" >&2 || true
  confirm '套用新的 compose.yaml？（會先備份舊檔）' N || die '已取消部署'
  cp compose.yaml "compose.before-$tag.yaml"
  COMPOSE_BACKUP="compose.before-$tag.yaml"
  cp "$incoming" compose.yaml
  info "已備份為 compose.before-$tag.yaml 並套用新版"
}

# 啟動失敗時的處理：顯示最近日誌，詢問是否立即回滾到 prod-rb；這次部署換過 compose.yaml 的話一併還原舊檔。
on_failure() {
  warn '新版本沒有正常啟動，最近的後端日誌：'
  sudo docker compose logs --tail=30 backend >&2 || true
  if [ -n "$(image_id "$BACKEND:prod-rb")" ] && confirm '要立即回滾到上一版（prod-rb）嗎？' Y; then
    if [ -n "$COMPOSE_BACKUP" ]; then cp "$COMPOSE_BACKUP" compose.yaml; info "已還原舊的 compose.yaml（$COMPOSE_BACKUP）"; fi
    retag_pair prod-rb latest
    compose_up && info "已回滾到 $(image_version "$BACKEND:latest")" || warn '回滾後仍無法啟動，請登入主機排查'
  fi
  exit 1
}

# deploy：把指定版本換成 latest 並重建容器；上一版保留為 prod-rb。
cmd_deploy() {
  local tag="$1" force="${2:-0}" current_backend current_web target_backend target_web since previous
  valid_tag "$tag"
  target_backend="$(image_id "$BACKEND:$tag")"; target_web="$(image_id "$WEB:$tag")"
  [ -n "$target_backend" ] && [ -n "$target_web" ] || die "主機上沒有 $tag 的 image，請先執行 ./deploy/hd push $tag"
  current_backend="$(running_id helpdesk-backend-1)"; current_web="$(running_id helpdesk-web-1)"
  if [ "$current_backend" = "$target_backend" ] && [ "$current_web" = "$target_web" ] && [ "$force" != 1 ]; then
    info "目前執行中的已經是 $tag，不需要部署（要強制重建請加 --force）"; exit 10
  fi
  previous="$(image_version "$BACKEND:latest")"

  step '檢查設定'
  check_env_keys ".hd/releases/$tag/.env.example"
  sync_compose ".hd/releases/$tag/compose.yaml" "$tag"

  step "部署 $tag（目前版本：$previous）"
  confirm "確定要把正式站換成 $tag？網站會中斷約十幾秒" Y || die '已取消部署'
  if [ -n "$(image_id "$BACKEND:latest")" ]; then retag_pair latest prod-rb; info "目前版本已保留為 prod-rb（$previous），可用 ./deploy/hd rollback 換回"; fi
  retag_pair "$tag" latest
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  compose_up || on_failure
  sudo docker compose ps

  step '確認啟動日誌'
  verify_startup "$since" "$tag" || on_failure
  echo "$tag" > .hd/current

  step '清理舊版本'
  prune_versions
  printf '\n✅ 正式站已更新為 %s\n' "$tag"
}

# rollback：沒有指定版本時換回 prod-rb（再執行一次會換回原本的版本）；指定版本時換成該版本。
cmd_rollback() {
  local target="${1:-prod-rb}" target_version current_id since
  [ "$target" = prod-rb ] || valid_tag "$target"
  [ -n "$(image_id "$BACKEND:$target")" ] && [ -n "$(image_id "$WEB:$target")" ] || die "主機上沒有 $target 的 image"
  target_version="$(image_version "$BACKEND:$target")"
  current_id="$(image_id "$BACKEND:latest")"
  [ "$current_id" != "$(image_id "$BACKEND:$target")" ] || { info "目前已經是 $target_version"; return 0; }
  step "回滾：$(image_version "$BACKEND:latest") → $target_version"
  confirm '確定要回滾？網站會中斷約十幾秒' Y || die '已取消回滾'
  retag_pair latest hd-rollback-tmp
  retag_pair "$target" latest
  retag_pair hd-rollback-tmp prod-rb
  sudo docker rmi "$BACKEND:hd-rollback-tmp" "$WEB:hd-rollback-tmp" >/dev/null
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  compose_up || die '回滾後容器沒有通過健康檢查，請登入主機排查（sudo docker compose logs --tail=50 backend）'
  sudo docker compose ps
  step '確認啟動日誌'
  if [ "$target_version" = '未標記' ]; then verify_startup "$since" '' || true; else verify_startup "$since" "$target_version" || true; fi
  echo "$target_version" > .hd/current
  printf '\n✅ 已回滾到 %s；剛才的版本保留為 prod-rb\n' "$target_version"
}

# status：容器狀態、目前與回滾版本、主機上可用的版本與磁碟空間。
cmd_status() {
  step '容器狀態'
  sudo docker compose ps
  step '版本'
  info "執行中（latest）：$(image_version "$BACKEND:latest")"
  if [ -n "$(image_id "$BACKEND:prod-rb")" ]; then info "回滾用（prod-rb）：$(image_version "$BACKEND:prod-rb")"; else info '回滾用（prod-rb）：無'; fi
  local tags; tags="$(version_tags)"
  if [ -n "$tags" ]; then info '主機上可部署的版本（新到舊）：'; printf '      %s\n' $tags; else info '主機上沒有已上傳的版本'; fi
  step '磁碟空間'
  df -h / | sed 's/^/  /'
}

main() {
  local dir="${1:?缺少部署目錄}" action="${2:?缺少動作}"
  shift 2
  cd "$HOME/$dir" || die "找不到部署目錄 ~/$dir"
  mkdir -p .hd/releases
  local args=() force=0 arg
  for arg in "$@"; do
    case "$arg" in
      --yes|-y) ASSUME_YES=1 ;;
      --force) force=1 ;;
      *) args+=("$arg") ;;
    esac
  done
  case "$action" in
    load) cmd_load "${args[@]}" ;;
    deploy) cmd_deploy "${args[0]:?缺少版本 tag}" "$force" ;;
    rollback) cmd_rollback "${args[0]:-}" ;;
    status) cmd_status ;;
    *) die "不支援的動作：$action" ;;
  esac
}

main "$@"
