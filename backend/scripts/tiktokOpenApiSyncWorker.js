/**
 * TikTok OpenAPI 订单同步 worker（默认 target=mysql，不写 orders-cache.json）。
 */
require('../loadEnv');

const { startScheduler } = require('../tiktok-api/scheduler');
const { isSyncQueueOnly, describeSyncMode } = require('../sync/services/syncEnv');

const { getOpenApiShopsSource, DB_SCHEMA_DOC } = require('../lib/readSyncShops');
const { isDashboardMysqlOnly } = require('../lib/saasMysqlOnly');

const intervalSec = Math.max(300, Number(process.env.GMV_COLLECT_INTERVAL_SECONDS || 300));
const shopsSource = getOpenApiShopsSource();
const mysqlOnly = isDashboardMysqlOnly();
console.log('[openapi-sync] mode', JSON.stringify(describeSyncMode()));
console.log(
  `[openapi-sync] interval ${intervalSec}s shops_source=${shopsSource} target=${mysqlOnly ? 'mysql' : 'orders-cache+mysql'}`,
);

if (isSyncQueueOnly()) {
  console.log(
    '[sync-queue-only] tiktok-openapi-sync worker will NOT run collectOnce — use: npm run sync:queue',
  );
  process.exit(0);
}

if (shopsSource === 'mysql') {
  console.log('[openapi-sync] db schema:', JSON.stringify(DB_SCHEMA_DOC, null, 2));
}

startScheduler();
