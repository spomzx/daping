/** PM2：API 与 OpenAPI 同步分离 */
module.exports = {
  apps: [
    {
      name: 'daping-api',
      cwd: __dirname,
      script: 'server.js',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
    },
    {
      name: 'tiktok-openapi-sync',
      cwd: __dirname,
      script: 'scripts/tiktokOpenApiSyncWorker.js',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
    },
  ],
};
