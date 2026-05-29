#!/usr/bin/env bash
# Staging 部署（服务器专用）— /home/admin/daping-staging
# 发布前自动备份 → build → pm2 restart → health
set -e

APP_ROOT="/home/admin/daping-staging"
FRONTEND_DIR="${APP_ROOT}/frontend"
BACKEND_DIR="${APP_ROOT}/backend"
BACKUP_DIR="${APP_ROOT}/backups"
PM2_APP="daping-staging"
HEALTH_URL="http://127.0.0.1:3081/api/health"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREATE_BACKUP="${SCRIPT_DIR}/../backup/create-deploy-backup.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_step()  { echo -e "${BLUE}[STEP]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

BACKUP_FILE=""

on_fail() {
  log_error "STAGING DEPLOY FAILED"
  if [[ -n "${BACKUP_FILE}" ]]; then
    log_warn "发布前备份仍在: $(basename "${BACKUP_FILE}")"
    log_warn "可回滚: bash ${SCRIPT_DIR}/../rollback/rollback.sh staging"
  fi
  exit 1
}

trap on_fail ERR

log_info "=============================================="
log_info " Staging 部署开始"
log_info " APP_ROOT=${APP_ROOT}"
log_info " BACKUP_DIR=${BACKUP_DIR}"
log_info " PM2_APP=${PM2_APP}"
log_info "=============================================="

if [[ ! -f "${CREATE_BACKUP}" ]]; then
  log_error "缺少备份脚本: ${CREATE_BACKUP}"
  exit 1
fi

log_step "[0/5] 发布前备份 → ${BACKUP_DIR}/"
BACKUP_FILE=$(bash "${CREATE_BACKUP}" "${APP_ROOT}")
log_info "备份已创建: $(basename "${BACKUP_FILE}")"
log_info "完整路径: ${BACKUP_FILE}"

log_step "[1/5] 构建前端: ${FRONTEND_DIR}"
cd "${FRONTEND_DIR}"
npm run build
log_info "前端构建完成"

log_step "[1b/5] 修复 frontend/dist 权限（nginx 可读）"
sudo chmod 755 /home/admin
sudo chmod 755 /home/admin/daping-staging
sudo chmod 755 /home/admin/daping-staging/frontend
sudo chmod 755 /home/admin/daping-staging/frontend/dist
sudo find /home/admin/daping-staging/frontend/dist -type d -exec chmod 755 {} \;
sudo find /home/admin/daping-staging/frontend/dist -type f -exec chmod 644 {} \;
log_info "dist 权限已修复"

log_step "[2/5] 安装后端依赖: ${BACKEND_DIR}"
cd "${BACKEND_DIR}"
npm install
log_info "后端依赖安装完成"

log_step "[3/5] 重启 PM2: ${PM2_APP}"
pm2 restart "${PM2_APP}"
log_info "PM2 已发送 restart"

log_step "[4/5] 等待服务就绪 (3s) ..."
sleep 3

log_step "[5/5] 健康检查: ${HEALTH_URL}"
if curl -fsS --connect-timeout 10 --max-time 30 "${HEALTH_URL}" >/dev/null; then
  log_info "健康检查通过"
  echo ""
  log_info "STAGING DEPLOY SUCCESS"
  log_info "发布前备份文件: $(basename "${BACKUP_FILE}")"
  log_info "发布前备份路径: ${BACKUP_FILE}"
  exit 0
else
  log_error "健康检查失败: ${HEALTH_URL}"
  on_fail
fi
