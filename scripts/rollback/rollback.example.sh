#!/usr/bin/env bash
# =============================================================================
# 回滚模板（仅提示，不删除、不覆盖任何文件）
# =============================================================================

set -euo pipefail

: "${APP_ROOT:?请设置 APP_ROOT（项目根目录）}"
: "${BACKUP_DIR:=${APP_ROOT}/backups}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "=============================================="
echo " [TEMPLATE] 回滚指引"
echo " APP_ROOT=${APP_ROOT}"
echo " BACKUP_DIR=${BACKUP_DIR}"
echo "=============================================="

echo ""
echo "[STEP 1] 停止放量 / 切回旧槽位（蓝绿）"
echo "  [echo] 将负载均衡 / upstream 指回上一活跃槽位（blue 或 green）"
echo "  [echo] 确认旧槽位进程仍在运行"

echo ""
echo "[STEP 2] 恢复代码备份"
echo "  [echo] 在 ${BACKUP_DIR} 中选择目标: backup_yyyyMMdd_HHmmss.tar.gz"
echo "  [echo] tar -xzf \"${BACKUP_DIR}/backup_<timestamp>.tar.gz\" -C \"<恢复目标父目录>\""
echo "  [echo] 将解压后的 frontend/backend/legacy/docs 覆盖回 APP_ROOT（操作前请再次备份当前状态）"
echo "  注意: 本模板不执行 tar 解压或文件覆盖"

echo ""
echo "[STEP 3] 恢复数据库（若本次发布含迁移）"
echo "  [echo] mysql ... < \"${BACKUP_DIR}/db_<timestamp>.sql\""
echo "  若无 DB 备份: 按变更记录执行逆向 SQL"

echo ""
echo "[STEP 4] 重启应用（提示 — 不执行 pm2）"
echo "  [echo] pm2 restart <your-app-name>"
echo "  [echo] pm2 logs <your-app-name> --lines 100"

echo ""
echo "[STEP 5] 验证"
echo "  API_BASE_URL=<your-host> RUN_CURL=1 AUTH_TOKEN=<token> \\"
echo "    bash ${PROJECT_ROOT}/scripts/health/check-api.example.sh"

echo ""
echo "[STEP 6] 记录事故"
echo "  [echo] 记录回滚时间、backup 文件名、根因与跟进项"

echo ""
echo "[TEMPLATE] 回滚模板结束（未修改服务器任何文件）。"
