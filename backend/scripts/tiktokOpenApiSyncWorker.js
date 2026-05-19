/**
 * 仅运行 TikTok OpenAPI 订单同步，写入 storage/orders-cache.json。
 */
const path = require('path');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {}
require('dotenv').config();

const { startScheduler } = require('../tiktok-api/scheduler');

const { getOpenApiShopsSource, DB_SCHEMA_DOC } = require('../lib/readSyncShops');

const intervalSec = Math.max(300, Number(process.env.GMV_COLLECT_INTERVAL_SECONDS || 300));
const shopsSource = getOpenApiShopsSource();
console.log(
  `[openapi-sync] interval ${intervalSec}s shops_source=${shopsSource} target=orders-cache+mysql`,
);
if (shopsSource === 'mysql') {
  console.log('[openapi-sync] db schema:', JSON.stringify(DB_SCHEMA_DOC, null, 2));
}

startScheduler();
