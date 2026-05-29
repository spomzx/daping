#!/usr/bin/env bash
# 正式环境发布：Staging 代码 → Prod 构建 → 重启 daping-prod
# 用法: bash /home/admin/daping-prod/scripts/deploy/deploy-prod.sh
#       或 bash /home/admin/daping-staging/scripts/deploy/deploy-prod.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy-env.sh
source "${SCRIPT_DIR}/deploy-env.sh"

PROD_FRONTEND="${PROD_ROOT}/frontend"
PROD_BACKEND="${PROD_ROOT}/backend"
PROD_BACKUP_DIR="${PROD_ROOT}/backups"
ROLLBACK_SCRIPT="${PROD_ROOT}/scripts/rollback/rollback.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_step()  { echo -e "${BLUE}[STEP]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

fail_deploy() {
  log_error "PRODUCTION DEPLOY FAILED"
  log_warn "建议立即回滚:"
  log_warn "  bash ${ROLLBACK_SCRIPT} prod"
  exit 1
}

trap fail_deploy ERR

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
ARCHIVE_NAME="backup_${TIMESTAMP}.tar.gz"
ARCHIVE_PATH="${PROD_BACKUP_DIR}/${ARCHIVE_NAME}"

log_info "=============================================="
log_info " Production 发布（Staging → Prod）"
log_info " STAGING_ROOT=${STAGING_ROOT}"
log_info " PROD_ROOT=${PROD_ROOT}"
log_info " PM2_PROD=${PM2_PROD}"
log_info "=============================================="

if [[ ! -d "${STAGING_ROOT}" ]]; then
  log_error "Staging 不存在: ${STAGING_ROOT}"
  exit 1
fi
if [[ ! -d "${PROD_ROOT}" ]]; then
  log_error "Prod 未初始化，请先执行: bash ${STAGING_ROOT}/scripts/deploy/init-prod.sh"
  exit 1
fi

log_step "[1/7] 备份当前 Prod → ${ARCHIVE_PATH}"
mkdir -p "${PROD_BACKUP_DIR}"
tar -czf "${ARCHIVE_PATH}" \
  -C "${PROD_ROOT}" \
  --exclude='frontend/node_modules' \
  --exclude='frontend/dist' \
  --exclude='backend/node_modules' \
  --exclude='backend/storage' \
  --exclude='backend/storage.local.bak' \
  --exclude='backups' \
  frontend backend docs scripts legacy 2>/dev/null || \
tar -czf "${ARCHIVE_PATH}" \
  -C "${PROD_ROOT}" \
  --exclude='frontend/node_modules' \
  --exclude='frontend/dist' \
  --exclude='backend/node_modules' \
  --exclude='backend/storage' \
  --exclude='backend/storage.local.bak' \
  --exclude='backups' \
  frontend backend docs scripts
log_info "备份完成: ${ARCHIVE_NAME}"

log_step "[2/7] rsync Staging → Prod（保留 Prod .env）"
rsync -a --delete "${RSYNC_DEPLOY_EXCLUDES[@]}" "${STAGING_ROOT}/" "${PROD_ROOT}/"
log_info "代码已同步"

log_step "[3/7] 前端 npm install && build"
cd "${PROD_FRONTEND}"
npm install
npm run build
log_info "前端构建完成"

log_step "[4/7] 后端 npm install"
cd "${PROD_BACKEND}"
npm install
log_info "后端依赖完成"

log_step "[5/7] 重启 PM2: ${PM2_PROD}（不重启 ${PM2_STAGING}）"
if pm2 describe "${PM2_PROD}" >/dev/null 2>&1; then
  pm2 restart "${PM2_PROD}"
else
  log_warn "未找到 ${PM2_PROD}，尝试 start ..."
  pm2 start server.js --name "${PM2_PROD}" --cwd "${PROD_BACKEND}"
fi

log_step "[6/7] 等待服务就绪 (3s) ..."
sleep 3

log_step "[7/7] 健康检查: ${PROD_HEALTH_URL}"
if curl -fsS --connect-timeout 10 --max-time 30 "${PROD_HEALTH_URL}" >/dev/null; then
  echo ""
  log_info "PRODUCTION DEPLOY SUCCESS"
  log_info "备份: ${ARCHIVE_PATH}"
  log_info "Staging 仍在运行: ${PM2_STAGING}"
  exit 0
else
  log_error "健康检查失败"
  log_warn "回滚: bash ${ROLLBACK_SCRIPT} prod"
  fail_deploy
fi
