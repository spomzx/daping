# shellcheck shell=bash
# 部署脚本共用变量（服务器路径）
STAGING_ROOT="/home/admin/daping-staging"
PROD_ROOT="/home/admin/daping-prod"
PM2_PROD="daping-prod"
PM2_STAGING="daping-staging"
PROD_HEALTH_URL="http://127.0.0.1:3080/api/health"
STAGING_HEALTH_URL="http://127.0.0.1:3081/api/health"

# rsync：staging → prod（不覆盖双方 .env，不同步依赖与构建产物）
RSYNC_DEPLOY_EXCLUDES=(
  --exclude 'node_modules'
  --exclude 'dist'
  --exclude '.git'
  --exclude '*.log'
  --exclude 'logs'
  --exclude 'backups'
  --exclude 'backend/.env'
  --exclude 'frontend/.env'
)
