#!/usr/bin/env bash
# 修复 daping-staging 目录 root/admin 混用导致的权限问题
# 用法（在服务器上，建议 admin 用户执行，chown 需 sudo）:
#   bash scripts/maintenance/fix-permissions.sh
set -e

APP_ROOT="/home/admin/daping-staging"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_step()  { echo -e "${BLUE}[STEP]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

if [[ ! -d "${APP_ROOT}" ]]; then
  log_error "目录不存在: ${APP_ROOT}"
  exit 1
fi

log_info "=============================================="
log_info " 权限修复: ${APP_ROOT}"
log_info " 当前用户: $(whoami)"
log_info "=============================================="

log_step "[1/4] 归一 owner 为 admin:admin"
if [[ "$(whoami)" == "root" ]]; then
  chown -R admin:admin "${APP_ROOT}"
else
  sudo chown -R admin:admin "${APP_ROOT}"
fi
log_info "chown 完成（含 node_modules，不含单独跳过 .env 内容修改）"

log_step "[2/4] 目录权限 755"
find "${APP_ROOT}" -type d -exec chmod 755 {} \;
log_info "目录 chmod 755 完成"

log_step "[3/4] 文件权限 644"
find "${APP_ROOT}" -type f -exec chmod 644 {} \;
log_info "文件 chmod 644 完成"

log_step "[4/4] 部署/运维脚本可执行权限"
chmod +x "${APP_ROOT}"/scripts/deploy/*.sh 2>/dev/null || log_warn "scripts/deploy/*.sh 不存在或为空"
chmod +x "${APP_ROOT}"/scripts/rollback/*.sh 2>/dev/null || log_warn "scripts/rollback/*.sh 不存在或为空"
chmod +x "${APP_ROOT}"/scripts/health/*.sh 2>/dev/null || log_warn "scripts/health/*.sh 不存在或为空"
chmod +x "${APP_ROOT}"/scripts/maintenance/*.sh 2>/dev/null || log_warn "scripts/maintenance/*.sh 不存在或为空"
log_info "脚本 +x 完成"

log_info "=============================================="
log_info " 权限检查（ls -ld）"
log_info "=============================================="
ls -ld "${APP_ROOT}"
ls -ld "${APP_ROOT}/backend/node_modules" 2>/dev/null || log_warn "backend/node_modules 不存在"
ls -ld "${APP_ROOT}/scripts/deploy" 2>/dev/null || log_warn "scripts/deploy 不存在"

log_info "=============================================="
log_info " PERMISSION FIX SUCCESS"
log_info " 请使用 admin 用户执行: bash scripts/deploy/deploy-staging.sh"
log_info "=============================================="
