#!/usr/bin/env bash
# 发布前项目备份（tar.gz，供 deploy-staging / rollback 使用）
# 用法: bash scripts/backup/create-deploy-backup.sh /home/admin/daping-staging
# 成功时 stdout 仅输出备份文件完整路径
set -euo pipefail

APP_ROOT="${1:?用法: $0 APP_ROOT}"

BACKUP_DIR="${APP_ROOT}/backups"
BACKUP_NAME="backup_$(date +%Y%m%d_%H%M%S).tar.gz"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[backup]${NC} $*" >&2; }
log_error() { echo -e "${RED}[backup]${NC} $*" >&2; }

if [[ ! -d "${APP_ROOT}" ]]; then
  log_error "APP_ROOT 不存在: ${APP_ROOT}"
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

TO_BACKUP=()
for name in frontend backend scripts docs package.json package-lock.json; do
  if [[ -e "${APP_ROOT}/${name}" ]]; then
    TO_BACKUP+=("${name}")
  fi
done

if [[ ${#TO_BACKUP[@]} -eq 0 ]]; then
  log_error "无可备份项（需要 frontend/ backend/ scripts/ docs/ 或 package.json）"
  exit 1
fi

log_info "打包 → ${BACKUP_PATH}"
log_info "纳入: ${TO_BACKUP[*]}"
log_info "排除: node_modules dist logs .git"

cd "${APP_ROOT}"
tar -czf "${BACKUP_PATH}" \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='logs' \
  --exclude='.git' \
  "${TO_BACKUP[@]}"

if [[ ! -f "${BACKUP_PATH}" ]]; then
  log_error "备份文件未生成: ${BACKUP_PATH}"
  exit 1
fi

BYTES=$(wc -c < "${BACKUP_PATH}" | tr -d ' ')
log_info "完成: $(basename "${BACKUP_PATH}") (${BYTES} bytes)"

echo "${BACKUP_PATH}"
