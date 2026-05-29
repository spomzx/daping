#!/usr/bin/env bash
# =============================================================================
# 项目备份模板（仅示例）
#
# 复制为 backup-project.sh 后配置 APP_ROOT、BACKUP_DIR。
# 不执行真实删除；打包命令仅 echo 提示。
# =============================================================================

set -euo pipefail

: "${APP_ROOT:?请设置 APP_ROOT（项目根目录）}"
: "${BACKUP_DIR:=${APP_ROOT}/backups}"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
ARCHIVE_NAME="backup_${TIMESTAMP}.tar.gz"
ARCHIVE_PATH="${BACKUP_DIR}/${ARCHIVE_NAME}"

FRONTEND_DIR="${APP_ROOT}/frontend"
BACKEND_DIR="${APP_ROOT}/backend"
LEGACY_DIR="${APP_ROOT}/legacy"
DOCS_DIR="${APP_ROOT}/docs"

echo "=============================================="
echo " [TEMPLATE] 项目备份"
echo " APP_ROOT=${APP_ROOT}"
echo " BACKUP_DIR=${BACKUP_DIR}"
echo " 输出文件: ${ARCHIVE_NAME}"
echo " 完整路径: ${ARCHIVE_PATH}"
echo "=============================================="

echo ""
echo "将纳入备份的目录:"
echo "  - frontend/  (${FRONTEND_DIR})"
echo "  - backend/   (${BACKEND_DIR})"
echo "  - legacy/    (${LEGACY_DIR})"
echo "  - docs/      (${DOCS_DIR})"

echo ""
echo "[提示] 创建备份目录:"
echo "  [echo] mkdir -p \"${BACKUP_DIR}\""

echo ""
echo "[提示] 打包命令示例（在 APP_ROOT 的父目录或 APP_ROOT 内执行）:"
echo "  [echo] tar -czf \"${ARCHIVE_PATH}\" \\"
echo "    -C \"${APP_ROOT}\" frontend backend legacy docs \\"
echo "    --exclude='frontend/node_modules' \\"
echo "    --exclude='frontend/dist' \\"
echo "    --exclude='backend/node_modules' \\"
echo "    --exclude='backend/storage' \\"
echo "    --exclude='backend/storage.local.bak'"

echo ""
echo "[提示] 可选：单独备份数据库（按环境配置）:"
echo "  [echo] mysqldump -h \$DB_HOST -u \$DB_USER -p\$DB_PASS \$DB_NAME > \"${BACKUP_DIR}/db_${TIMESTAMP}.sql\""

echo ""
echo "[提示] 校验归档:"
echo "  [echo] tar -tzf \"${ARCHIVE_PATH}\" | head"

echo ""
echo "[提示] 保留策略（人工）:"
echo "  [echo] 仅保留最近 7 天备份；删除更旧文件前请二次确认"
echo "  [echo] rm -f \"${BACKUP_DIR}/backup_旧时间戳.tar.gz\"  # 模板不执行"

echo ""
echo "[TEMPLATE] 备份模板结束。预期产物: ${ARCHIVE_NAME}"
