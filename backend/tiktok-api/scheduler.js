const path = require('path');
const dayjs = require('dayjs');
const { shopCipherString } = require('./shops');
const {
  atomicWriteJsonSync,
  readJsonWithRecovery,
  withStorageLock,
} = require('../lib/storageFile');
const { recordSyncRun } = require('../lib/syncMetrics');
const {
  loadShopsForOpenApiCollect,
  buildShopSyncLogPayload,
  buildOpenApiSyncShopListLog,
  getOpenApiShopsSource,
} = require('../lib/readSyncShops');
const { syncOneShop } = require('../modules/sync/shopSyncRunner');
const { isSyncQueueOnly } = require('../sync/services/syncEnv');
const { isDashboardMysqlOnly } = require('../lib/saasMysqlOnly');

const storageDir = path.join(__dirname, '..', 'storage');
const ORDERS_CACHE_PATH = path.join(storageDir, 'orders-cache.json');
const ORDERS_CACHE_LOCK = 'orders-cache.json';

let timer = null;
let collectRunning = false;

function readOrdersCache() {
  const r = readJsonWithRecovery(ORDERS_CACHE_PATH, { restore: true });
  return r.data;
}

function dedupeOrdersById(orders) {
  const map = new Map();
  for (const o of orders || []) {
    const id = String(o?.orderId || '');
    const shopId = String(o?.shopId || '').toLowerCase();
    const key = shopId ? `${shopId}:${id}` : id;
    if (!id) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, o);
      continue;
    }
    const prevTs = dayjs(prev.updateTime || prev.createTime || 0).valueOf();
    const nextTs = dayjs(o.updateTime || o.createTime || 0).valueOf();
    if (nextTs >= prevTs) map.set(key, o);
  }
  return [...map.values()];
}

function shouldSkipOrdersCacheWrite({ previousOrders, mergedOrders, allOrders, shops, shopsFailed }) {
  const prevCount = Array.isArray(previousOrders) ? previousOrders.length : 0;
  const mergedCount = Array.isArray(mergedOrders) ? mergedOrders.length : 0;
  const newCount = Array.isArray(allOrders) ? allOrders.length : 0;

  if (prevCount > 0 && mergedCount === 0) {
    return { skip: true, reason: 'anti_empty_overwrite' };
  }

  const shopCount = Array.isArray(shops) ? shops.length : 0;
  const allFailed = shopCount > 0 && Array.isArray(shopsFailed) && shopsFailed.length >= shopCount;
  if (allFailed && newCount === 0 && prevCount > 0) {
    return { skip: true, reason: 'sync_all_failed_keep_previous' };
  }

  if (prevCount > 0 && mergedCount < prevCount && newCount === 0) {
    return { skip: true, reason: 'sync_shrink_without_new_orders' };
  }

  return { skip: false, reason: '' };
}

/**
 * OpenAPI 同步：主写入 MySQL orders；并 **@deprecated** 合并写入 orders-cache.json（仅供 legacy / 运维，非 SaaS 数据源）。
 * 不触碰 gmv-cache / overview / product 侧车文件。
 */
function collectOnceSkippedQueueOnly() {
  console.log('[sync-queue-only] legacy collectOnce skipped');
  return {
    ok: true,
    skipped: true,
    queueOnly: true,
    meta: {
      dataSource: 'sync_queue_worker',
      collectMode: 'queue_only',
      message: 'collectOnce 已禁用；订单同步由 sync_jobs 队列 worker 执行，大屏仅读 MySQL',
    },
  };
}

async function collectOnce() {
  if (isSyncQueueOnly()) {
    return collectOnceSkippedQueueOnly();
  }

  if (collectRunning) {
    return {
      ok: false,
      skipped: true,
      meta: {
        dataSource: 'tiktok_open_api_orders',
        collectMode: 'open_api_orders_cache',
        message: '上一轮 OpenAPI 同步仍在进行，已跳过本轮（幂等保护）',
      },
    };
  }

  collectRunning = true;
  try {
    return await withStorageLock(ORDERS_CACHE_LOCK, async () => {
      const runDeadline = Date.now() + 58000;
      const shops = await loadShopsForOpenApiCollect();

      console.log('[openapi-sync-shop-list]', JSON.stringify(buildOpenApiSyncShopListLog(shops), null, 2));

      const allOrders = [];
      const shopsFailed = [];
      let totalPersistedMysql = 0;

      for (const shop of shops) {
        if (Date.now() > runDeadline) {
          console.warn('[openapi-sync] deadline reached, remaining shops skipped:', {
            remaining: shops.length - shopsFailed.length,
          });
          break;
        }

        console.log('[shop-sync-start]', JSON.stringify(buildShopSyncLogPayload(shop), null, 2));

        const result = await syncOneShop(shop, { deadlineMs: runDeadline });
        const stampedOrders = Array.isArray(result.orders) ? result.orders : [];
        if (stampedOrders.length > 0) {
          allOrders.push(...stampedOrders);
          totalPersistedMysql +=
            (Number(result.inserted_orders_count) || 0) + (Number(result.updated_orders_count) || 0);
        }
        if (!result.ok) {
          shopsFailed.push({
            shopId: shop.shopId,
            reason: result.error_message || result.status || 'sync_failed',
          });
        }
      }

      const previousOrdersCache = readOrdersCache();
      const previousOrders = Array.isArray(previousOrdersCache?.orders) ? previousOrdersCache.orders : [];
      const mergedOrders = dedupeOrdersById([...previousOrders, ...allOrders]);
      const updatedAt = dayjs().format('YYYY-MM-DD HH:mm:ss');

      const guard = shouldSkipOrdersCacheWrite({
        previousOrders,
        mergedOrders,
        allOrders,
        shops,
        shopsFailed,
      });

      if (isDashboardMysqlOnly()) {
        recordSyncRun({
          ordersTotal: mergedOrders.length,
          shopsOk: shops.length - shopsFailed.length,
          shopsFail: shopsFailed.length,
        });
        return {
          ok: shopsFailed.length < shops.length || mergedOrders.length > 0 || totalPersistedMysql > 0,
          skippedWrite: true,
          meta: {
            dataSource: 'tiktok_open_api_orders',
            collectMode: 'mysql_only',
            message: '订单已写入 MySQL；orders-cache.json 写入已禁用 (DASHBOARD_MYSQL_ONLY=1)',
            updatedAt,
            shopsFailed,
            ordersTotal: mergedOrders.length,
            mysqlPersistedThisRun: totalPersistedMysql,
            openapiShopsSource: getOpenApiShopsSource(),
            refreshInterval: Number(process.env.GMV_COLLECT_INTERVAL_SECONDS || 300),
          },
          summary: {
            todayOrders: mergedOrders.length,
            updatedAt,
          },
        };
      }

      if (guard.skip) {
        console.warn('[orders] skip cache write:', guard.reason, {
          previous: previousOrders.length,
          merged: mergedOrders.length,
          new: allOrders.length,
        });
        return {
          ok: shopsFailed.length < shops.length || previousOrders.length > 0,
          skippedWrite: true,
          meta: {
            dataSource: 'tiktok_open_api_orders',
            collectMode: 'open_api_orders_cache',
            message: `同步未写盘：${guard.reason}；保留既有 orders-cache（${previousOrders.length} 条）`,
            updatedAt: previousOrdersCache?.updatedAt || updatedAt,
            shopsFailed,
            ordersTotal: previousOrders.length,
            mysqlPersistedThisRun: totalPersistedMysql,
            refreshInterval: Number(process.env.GMV_COLLECT_INTERVAL_SECONDS || 300),
          },
          summary: {
            todayOrders: previousOrders.length,
            updatedAt: previousOrdersCache?.updatedAt || updatedAt,
          },
        };
      }

      atomicWriteJsonSync(
        ORDERS_CACHE_PATH,
        { updatedAt, total: mergedOrders.length, orders: mergedOrders },
        { lockHeld: true, pretty: true },
      );
      console.log('[orders] saved:', mergedOrders.length);
      console.log('[orders] mysql persist per-shop done, total rows:', totalPersistedMysql);

      recordSyncRun({
        ordersTotal: mergedOrders.length,
        shopsOk: shops.length - shopsFailed.length,
        shopsFail: shopsFailed.length,
      });

      return {
        ok: shopsFailed.length < shops.length || mergedOrders.length > 0,
        meta: {
          dataSource: 'tiktok_open_api_orders',
          collectMode: 'open_api_orders_cache',
          message:
            mergedOrders.length > 0
              ? '订单已写入 orders-cache.json（Open API）；MySQL 已按店铺上下文逐店写入'
              : '本轮未拉到新订单，已合并写入 orders-cache.json',
          updatedAt,
          shopsFailed,
          shopsLoaded: [...new Set(mergedOrders.map((o) => o.platform_shop_id || o.shopId))],
          ordersTotal: mergedOrders.length,
          mysqlPersistedThisRun: totalPersistedMysql,
          openapiShopsSource: getOpenApiShopsSource(),
          refreshInterval: Number(process.env.GMV_COLLECT_INTERVAL_SECONDS || 300),
        },
        summary: {
          todayOrders: mergedOrders.length,
          updatedAt,
        },
      };
    });
  } finally {
    collectRunning = false;
  }
}

function startScheduler() {
  if (isSyncQueueOnly()) {
    console.log(
      '[sync-queue-only] openapi scheduler idle — SYNC_USE_QUEUE_ONLY=1; start: npm run sync:queue',
    );
    return;
  }

  const intervalMs = Math.max(30, Number(process.env.GMV_COLLECT_INTERVAL_SECONDS || 30)) * 1000;
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    collectOnce().catch((e) => {
      console.error('[scheduler] collect failed:', e?.message || e);
    });
  }, intervalMs);
  collectOnce().catch((e) => {
    console.error('[scheduler] startup collect failed:', e?.message || e);
  });
}

module.exports = {
  ORDERS_CACHE_PATH,
  collectOnce,
  startScheduler,
  readOrdersCache,
  dedupeOrdersById,
};
