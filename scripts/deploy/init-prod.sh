#!/usr/bin/env bash
# 首次初始化正式环境：从 staging 克隆代码树，构建并启动 daping-prod
# 用法: bash /home/admin/daping-staging/scripts/deploy/init-prod.sh
# 注意: 不启动 tiktok-openapi-sync；不影响 daping-staging
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy-env.sh
source "${SCRIPT_DIR}/deploy-env.sh"

PROD_FRONTEND="${PROD_ROOT}/frontend"
PROD_BACKEND="${PROD_ROOT}/backend"
PROD_BACKUP_DIR="${PROD_ROOT}/backups"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_step()  { echo -e "${BLUE}[STEP]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

on_fail() {
  log_error "INIT PROD FAILED"
  exit 1
}

trap on_fail ERR

log_info "=============================================="
log_info " 正式环境初始化"
log_info " STAGING_ROOT=${STAGING_ROOT}"
log_info " PROD_ROOT=${PROD_ROOT}"
log_info " PM2_PROD=${PM2_PROD}"
log_info "=============================================="

if [[ ! -d "${STAGING_ROOT}" ]]; then
  log_error "Staging 目录不存在: ${STAGING_ROOT}"
  exit 1
fi

if [[ -d "${PROD_ROOT}" ]]; then
  log_warn "PROD 目录已存在，跳过 rsync 克隆（继续 build / pm2 / health）"
else
  log_step "[1/7] 从 Staging rsync 创建 ${PROD_ROOT}"
  mkdir -p "${PROD_ROOT}"
  rsync -a "${RSYNC_DEPLOY_EXCLUDES[@]}" "${STAGING_ROOT}/" "${PROD_ROOT}/"
  log_info "代码树已同步（已排除 .env / node_modules / dist / .git / logs / backups）"
fi

mkdir -p "${PROD_BACKUP_DIR}"

if [[ ! -f "${PROD_BACKEND}/.env" ]]; then
  log_warn "缺少 ${PROD_BACKEND}/.env — 请从 staging 复制后按生产修改，再重新执行本脚本或 deploy-prod.sh"
fi
if [[ ! -f "${PROD_FRONTEND}/.env" ]] && [[ -f "${STAGING_ROOT}/frontend/.env" ]]; then
  log_warn "缺少 ${PROD_FRONTEND}/.env（已刻意不同步 staging 的 frontend/.env）"
fi

log_step "[2/7] 前端依赖与构建"
cd "${PROD_FRONTEND}"
npm install
npm run build
log_info "前端构建完成"

log_step "[3/7] 后端依赖"
cd "${PROD_BACKEND}"
npm install
log_info "后端依赖安装完成"

log_step "[4/7] 脚本可执行权限"
chmod +x "${PROD_ROOT}"/scripts/deploy/*.sh 2>/dev/null || true
chmod +x "${PROD_ROOT}"/scripts/rollback/*.sh 2>/dev/null || true
chmod +x "${PROD_ROOT}"/scripts/health/*.sh 2>/dev/null || true
chmod +x "${PROD_ROOT}"/scripts/maintenance/*.sh 2>/dev/null || true

log_step "[5/7] PM2 启动 ${PM2_APP}（仅 API，不触碰 ${PM2_STAGING} / tiktok-openapi-sync）"
if pm2 describe "${PM2_PROD}" >/dev/null 2>&1; then
  pm2 restart "${PM2_PROD}"
else
  pm2 start server.js --name "${PM2_PROD}" --cwd "${PROD_BACKEND}"
fi
log_info "PM2 进程: ${PM2_PROD}"

log_step "[6/7] 等待服务就绪 (3s) ..."
sleep 3

log_step "[7/7] 健康检查: ${PROD_HEALTH_URL}"
if curl -fsS --connect-timeout 10 --max-time 30 "${PROD_HEALTH_URL}" >/dev/null; then
  echo ""
  log_info "INIT PROD SUCCESS"
  log_info "Staging 未改动: ${PM2_STAGING} @ ${STAGING_HEALTH_URL}"
  pm2 list | grep -E 'daping-prod|daping-staging|tiktok-openapi' || pm2 list
  exit 0
else
  log_error "健康检查失败: ${PROD_HEALTH_URL}"
  log_warn "请检查 ${PROD_BACKEND}/.env 与 PORT；日志: pm2 logs ${PM2_PROD} --lines 80"
  on_fail
fi
