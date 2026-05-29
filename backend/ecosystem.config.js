/**
 * PM2 统一进程配置（支持未来多实例 API）
 *
 * 启动：
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *
 * 环境变量：
 *   PM2_API_INSTANCES — API 实例数（默认 1；>1 时启用 cluster）
 *   DASHBOARD_DATA_SOURCE — mysql | cache（默认 mysql）
 */
const path = require('path');

const apiInstances = Math.max(1, Number(process.env.PM2_API_INSTANCES || 1));
const useCluster = apiInstances > 1;

module.exports = {
  apps: [
    {
      name: 'daping-api',
      cwd: __dirname,
      script: 'server.js',
      interpreter: 'node',
      instances: apiInstances,
      exec_mode: useCluster ? 'cluster' : 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '768M',
      env: {
        NODE_ENV: 'production',
        DASHBOARD_DATA_SOURCE: process.env.DASHBOARD_DATA_SOURCE || 'mysql',
      },
      error_file: path.join(__dirname, 'logs', 'pm2-api-error.log'),
      out_file: path.join(__dirname, 'logs', 'pm2-api-out.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'tiktok-openapi-sync',
      cwd: __dirname,
      script: 'scripts/tiktokOpenApiSyncWorker.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: path.join(__dirname, 'logs', 'pm2-sync-error.log'),
      out_file: path.join(__dirname, 'logs', 'pm2-sync-out.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
