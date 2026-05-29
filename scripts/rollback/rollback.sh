#!/usr/bin/env bash
# 从最新 backup_*.tar.gz 回滚：临时目录解压 → rsync 覆盖 → build → pm2 → health
# 用法: bash scripts/rollback/rollback.sh [staging|prod]
set -euo pipefail

ENV_NAME="${1:-staging}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ENV="${SCRIPT_DIR}/../deploy/deploy-env.sh"
if [[ -f "${DEPLOY_ENV}" ]]; then
  # shellcheck source=../deploy/deploy-env.sh
  source "${DEPLOY_ENV}"
fi

case "${ENV_NAME}" in
  staging|stag|s)
    APP_ROOT="${STAGING_ROOT:-/home/admin/daping-staging}"
    PM2_APP="${PM2_STAGING:-daping-staging}"
    HEALTH_URL="${STAGING_HEALTH_URL:-http://127.0.0.1:3081/api/health}"
    HEALTH_ENV="staging"
    ;;
  prod|production|p)
    APP_ROOT="${PROD_ROOT:-/home/admin/daping-prod}"
    PM2_APP="${PM2_PROD:-daping-prod}"
    HEALTH_URL="${PROD_HEALTH_URL:-http://127.0.0.1:3080/api/health}"
    HEALTH_ENV="prod"
    ;;
  *)
    echo "用法: $0 [staging|prod]"
    exit 1
    ;;
esac

BACKUP_DIR="${APP_ROOT}/backups"
FRONTEND_DIR="${APP_ROOT}/frontend"
BACKEND_DIR="${APP_ROOT}/backend"
HEALTH_SCRIPT="${SCRIPT_DIR}/../health/check-api.sh"

TEMP_DIR=""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_step()  { echo -e "${BLUE}[STEP]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

cleanup_temp() {
  if [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]]; then
    log_info "清理临时目录: ${TEMP_DIR}"
    rm -rf "${TEMP_DIR}"
    TEMP_DIR=""
  fi
}

on_err() {
  local exit_code=$?
  log_error "ROLLBACK FAILED (${ENV_NAME}, exit=${exit_code})"
  cleanup_temp
  exit "${exit_code}"
}

trap on_err ERR
trap cleanup_temp EXIT

RSYNC_EXCLUDES=(
  --exclude 'node_modules'
  --exclude 'dist'
  --exclude '.env'
  --exclude 'backups'
)

run_health_check() {
  sleep 3
  if [[ -f "${HEALTH_SCRIPT}" ]]; then
    bash "${HEALTH_SCRIPT}" "${HEALTH_ENV}"
    return $?
  fi
  curl -fsS --connect-timeout 10 --max-time 30 "${HEALTH_URL}" >/dev/null
}

health_fail() {
  trap - ERR
  log_error "健康检查失败: ${HEALTH_URL}"
  log_warn "---------- pm2 logs ${PM2_APP} (last 100 lines) ----------"
  pm2 logs "${PM2_APP}" --lines 100 --nostream 2>/dev/null || pm2 logs "${PM2_APP}" --lines 100 || true
  log_error "ROLLBACK FAILED"
  exit 1
}

log_info "=============================================="
log_info " 回滚: ${ENV_NAME}"
log_info " APP_ROOT=${APP_ROOT}"
log_info " BACKUP_DIR=${BACKUP_DIR}"
log_info " PM2_APP=${PM2_APP}"
log_info "=============================================="

if [[ ! -d "${BACKUP_DIR}" ]]; then
  log_error "备份目录不存在: ${BACKUP_DIR}"
  log_warn "请先执行 deploy-staging 以生成 backups/backup_*.tar.gz"
  exit 1
fi

log_step "[1/8] 选择最新备份（backup_YYYYMMDD_HHmmss.tar.gz）"
mapfile -t BACKUPS < <(ls -1t "${BACKUP_DIR}"/backup_*.tar.gz 2>/dev/null || true)

if [[ ${#BACKUPS[@]} -eq 0 ]]; then
  log_error "未找到 ${BACKUP_DIR}/backup_*.tar.gz"
  exit 1
fi

for i in "${!BACKUPS[@]}"; do
  echo "  [$i] $(basename "${BACKUPS[$i]}")"
done

LATEST="${BACKUPS[0]}"
log_info "使用最新备份: $(basename "${LATEST}")"

log_step "[2/8] 创建临时目录并解压备份"
TEMP_DIR="$(mktemp -d /tmp/daping-rollback-XXXXXX)"
log_info "TEMP_DIR=${TEMP_DIR}"
tar -xzf "${LATEST}" -C "${TEMP_DIR}"
log_info "解压完成: ${LATEST}"

log_step "[3/8] rsync 覆盖到 ${APP_ROOT}（排除 node_modules dist .env backups）"
rsync -a --delete \
  --no-owner \
  --no-group \
  --omit-dir-times \
  "${RSYNC_EXCLUDES[@]}" \
  "${TEMP_DIR}/" "${APP_ROOT}/"
log_info "rsync 完成"

log_step "[4/8] 清理临时目录"
cleanup_temp

log_step "[5/8] 前端 npm install + build"
cd "${FRONTEND_DIR}"
npm install
npm run build
log_info "前端构建完成"

log_step "[6/8] 后端 npm install"
cd "${BACKEND_DIR}"
npm install
log_info "后端依赖安装完成"

log_step "[7/8] 重启 PM2: ${PM2_APP}"
if pm2 describe "${PM2_APP}" >/dev/null 2>&1; then
  pm2 restart "${PM2_APP}"
else
  log_warn "PM2 进程不存在，尝试 start ..."
  pm2 start server.js --name "${PM2_APP}" --cwd "${BACKEND_DIR}"
fi
log_info "PM2 已重启"

log_step "[8/8] 健康检查: ${HEALTH_URL}"
if run_health_check; then
  :
else
  health_fail
fi

echo ""
log_info "ROLLBACK SUCCESS"
log_info "已回滚至: $(basename "${LATEST}")"
log_info "备份路径: ${LATEST}"
