#!/usr/bin/env bash
# =============================================================================
# 灰度 / 蓝绿部署 — Production 模板（仅示例）
#
# 使用前请复制为 deploy-prod.sh，并填写：
#   APP_ROOT、FRONTEND_DIR、BACKEND_DIR、API_BASE_URL
#
# 生产发布建议：先 staging 全量验收 → 备份 → 蓝绿切换 → 监控 → 保留回滚包
# 本模板不执行危险操作。
# =============================================================================

set -euo pipefail

: "${APP_ROOT:?请设置 APP_ROOT（项目根目录）}"
: "${FRONTEND_DIR:=${APP_ROOT}/frontend}"
: "${BACKEND_DIR:=${APP_ROOT}/backend}"
: "${API_BASE_URL:=https://your-prod-host.example}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "=============================================="
echo " [TEMPLATE] Production 部署流程"
echo " APP_ROOT=${APP_ROOT}"
echo " FRONTEND_DIR=${FRONTEND_DIR}"
echo " BACKEND_DIR=${BACKEND_DIR}"
echo " API_BASE_URL=${API_BASE_URL}"
echo "=============================================="

echo ""
echo "[CHECKLIST] 发布前确认（人工）"
echo "  - [ ] Staging 验收通过（见 docs/deployment/staging-workflow.md）"
echo "  - [ ] 变更说明 / 回滚方案已记录"
echo "  - [ ] 已创建 backup（见 scripts/backup/）"
echo "  - [ ] 维护窗口与通知已安排"

echo ""
echo "[STEP 0] 备份（提示）"
echo "  [echo] bash ${PROJECT_ROOT}/scripts/backup/backup-project.example.sh"
echo "  建议保留至少最近 N 个: backup_yyyyMMdd_HHmmss.tar.gz"

echo ""
echo "[STEP 1] 蓝绿 — 在非活跃槽位构建（提示）"
echo "  [echo] export DEPLOY_SLOT=green   # 或 blue，由运维定义"
echo "  [echo] cd \"\${APP_ROOT}-\${DEPLOY_SLOT}\" && git pull && ..."
echo "  说明: 活跃槽位继续服务，直到健康检查通过后切换流量"

echo ""
echo "[STEP 2] 构建前端"
echo "  [echo] cd \"${FRONTEND_DIR}\" && npm ci && npm run build"

echo ""
echo "[STEP 3] 安装后端依赖"
echo "  [echo] cd \"${BACKEND_DIR}\" && npm ci --omit=dev"

echo ""
echo "[STEP 4] 数据库迁移（提示 — 谨慎）"
echo "  [echo] cd \"${BACKEND_DIR}\" && node db/init.js"
echo "  生产建议: 先只读副本验证，再主库执行；保留回滚 SQL"

echo ""
echo "[STEP 5] 灰度流量（提示 — 在负载均衡/nginx 外配置）"
echo "  [echo] 5% → 20% → 50% → 100% 逐步放量"
echo "  [echo] 观察错误率、延迟、/api/health"

echo ""
echo "[STEP 6] 重启 / 切换（提示 — 不执行 pm2）"
echo "  [echo] pm2 reload <your-prod-app-name> --update-env"
echo "  蓝绿完成: [echo] 切换 upstream 至新槽位并下线旧槽位"

echo ""
echo "[STEP 7] 健康检查"
echo "  API_BASE_URL=${API_BASE_URL} bash ${PROJECT_ROOT}/scripts/health/check-api.example.sh"

echo ""
echo "[STEP 8] 发布后监控（提示）"
echo "  [echo] 检查日志、订单同步、租户配额、登录"
echo "  异常时: bash ${PROJECT_ROOT}/scripts/rollback/rollback.example.sh"

echo ""
echo "[TEMPLATE] Production 部署模板执行完毕（仅输出提示）。"
