#!/usr/bin/env bash
# =============================================================================
# 灰度 / 蓝绿部署 — Staging 模板（仅示例，勿直接用于生产）
#
# 使用前请复制为 deploy-staging.sh，并按环境填写变量：
#   export APP_ROOT="/path/to/your/app"
#   export FRONTEND_DIR="${APP_ROOT}/frontend"
#   export BACKEND_DIR="${APP_ROOT}/backend"
#
# 本模板不执行危险操作（无 rm -rf、无真实 pm2 调用）。
# =============================================================================

set -euo pipefail

: "${APP_ROOT:?请设置 APP_ROOT（项目根目录）}"
: "${FRONTEND_DIR:=${APP_ROOT}/frontend}"
: "${BACKEND_DIR:=${APP_ROOT}/backend}"

# 可选：健康检查基址（按实际 staging 域名修改）
: "${API_BASE_URL:=https://your-staging-host.example}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "=============================================="
echo " [TEMPLATE] Staging 部署流程"
echo " APP_ROOT=${APP_ROOT}"
echo " FRONTEND_DIR=${FRONTEND_DIR}"
echo " BACKEND_DIR=${BACKEND_DIR}"
echo " API_BASE_URL=${API_BASE_URL}"
echo "=============================================="

# --- 0. 发布前备份（建议在服务器上执行真实 backup 脚本）---
echo ""
echo "[STEP 0] 发布前备份（提示）"
echo "  建议执行: bash ${PROJECT_ROOT}/scripts/backup/backup-project.example.sh"
echo "  （复制为 backup-project.sh 并配置 APP_ROOT 后使用）"

# --- 1. 拉取代码（蓝绿：当前槽位目录由运维定义，此处仅提示）---
echo ""
echo "[STEP 1] 同步代码（提示）"
echo "  [echo] cd \"${APP_ROOT}\" && git fetch && git checkout <branch> && git pull"
echo "  蓝绿建议: 在 inactive 槽位目录完成构建，通过流量切换再激活"

# --- 2. 构建前端 ---
echo ""
echo "[STEP 2] 构建前端"
echo "  [echo] cd \"${FRONTEND_DIR}\" && npm ci && npm run build"
echo "  产物目录通常为: ${FRONTEND_DIR}/dist"

# --- 3. 后端依赖 ---
echo ""
echo "[STEP 3] 安装后端依赖"
echo "  [echo] cd \"${BACKEND_DIR}\" && npm ci --omit=dev"
echo "  若需迁移: [echo] node db/init.js  （按你们环境变量配置 DB_*）"

# --- 4. 数据库 / 配置（仅提示）---
echo ""
echo "[STEP 4] 配置与环境（提示）"
echo "  [echo] 确认 ${BACKEND_DIR}/.env 已更新且未提交密钥"
echo "  [echo] 对比 staging 与 prod 环境变量清单"

# --- 5. 重启进程（不执行 pm2）---
echo ""
echo "[STEP 5] 重启应用（提示 — 不执行 pm2）"
echo "  [echo] pm2 restart <your-staging-app-name>"
echo "  或蓝绿: [echo] pm2 start ecosystem.config.js --only staging-green"
echo "  然后: [echo] 切换 nginx/负载均衡 upstream 至新槽位（由运维在 nginx 外完成）"

# --- 6. 健康检查 ---
echo ""
echo "[STEP 6] 健康检查（提示）"
echo "  建议执行: API_BASE_URL=${API_BASE_URL} bash ${PROJECT_ROOT}/scripts/health/check-api.example.sh"
echo "  手动示例:"
echo "    curl -fsS \"${API_BASE_URL}/api/health\""
echo "    curl -fsS -H \"Authorization: Bearer <token>\" \"${API_BASE_URL}/api/auth/me\""
echo "    curl -fsS -H \"Authorization: Bearer <token>\" \"${API_BASE_URL}/api/tenants?page=1&page_size=5\""

# --- 7. 回滚提示 ---
echo ""
echo "[STEP 7] 若验收失败 — 回滚（提示）"
echo "  建议执行: bash ${PROJECT_ROOT}/scripts/rollback/rollback.example.sh"
echo "  或恢复 backup 后: [echo] pm2 restart <your-staging-app-name>"

echo ""
echo "[TEMPLATE] Staging 部署模板执行完毕（仅输出提示，未改动服务器文件）。"
