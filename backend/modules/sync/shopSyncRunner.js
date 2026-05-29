'use strict';

const dayjs = require('dayjs');
const { shopCipherString } = require('../../tiktok-api/shops');
const { fetchTodayOrders } = require('../../tiktok-api/orders');
const { recordShopSync } = require('../../lib/syncMetrics');
const { persistOrdersFromCache } = require('../orders/orderPersistenceService');
const { persistOrderItemsFromCache } = require('../orders/orderItemPersistenceService');
const {
  loadShopsForOpenApiCollect,
  stampOrdersWithShopContext,
  patchMysqlShopSyncState,
  buildShopSyncResultLog,
} = require('../../lib/readSyncShops');
const { startShopSyncLog, endShopSyncLog } = require('./syncShopLogService');
const { logSyncPerfProbe } = require('../../lib/syncPerfProbe');
const { classifyOrderSyncApiFailure } = require('../../lib/openApiWorkerEligibility');
const { applyApiVerifiedHealthyState } = require('../../lib/staleAuthHealthRepair');

/**
 * @param {Record<string, unknown>} shop
 * @param {{ deadlineMs?: number }} [opts]
 */
async function syncOneShop(shop, opts = {}) {
  const deadlineMs = opts.deadlineMs ?? Date.now() + 55000;
  const logId = await startShopSyncLog(shop);
  const syncStarted = Date.now();

  const finish = async (patch) => {
    await endShopSyncLog(logId, shop, patch);
    return patch;
  };

  if (!shopCipherString(shop)) {
    const err = 'shop_cipher_missing';
    await patchMysqlShopSyncState(shop.internal_shop_id, {
      lastSyncOk: false,
      lastSyncError: err,
    });
    recordShopSync({
      shopId: shop.shopId,
      shopName: shop.shopName,
      durationMs: 0,
      orderCount: 0,
      ok: false,
      error: err,
    });
    const out = await finish({
      ok: false,
      status: 'failed',
      error_message: err,
      fetched_orders_count: 0,
      duration_ms: 0,
    });
    return { ...out, orders: [] };
  }

  const label = String(shop?.region || shop?.shopId || '').toUpperCase() || String(shop?.shopId || 'SHOP');
  const prefix = `[shop:${label}]`;

  try {
    const ret = await fetchTodayOrders(shop, { deadlineMs, logPrefix: prefix });
    const durationMs = Date.now() - syncStarted;
    const rawLen = Array.isArray(ret.data) ? ret.data.length : 0;
    const totalCount =
      ret.requestPages?.reduce((m, p) => Math.max(m, Number(p.orders_count_api || 0)), 0) ?? rawLen;

    if (!ret.ok) {
      const reason = ret.error?.message || ret.error?.type || 'fetch_failed';
      const httpStatus = Number(
        ret.debug?.status ?? ret.debug?.responseHttpStatus ?? ret.error?.httpStatus ?? 0,
      );
      const failure = classifyOrderSyncApiFailure(reason, httpStatus);
      const tokenBad = failure.kind === 'token';
      const scopeBad = failure.kind === 'scope';
      const errOut = scopeBad ? `scope_error: ${String(reason)}` : String(reason);
      await patchMysqlShopSyncState(shop.internal_shop_id, {
        lastSyncOk: false,
        lastSyncError: errOut,
        status: tokenBad ? 'expired' : undefined,
      });
      recordShopSync({
        shopId: shop.shopId,
        shopName: shop.shopName,
        durationMs,
        orderCount: 0,
        ok: false,
        error: errOut,
        tokenExpired: tokenBad,
        scopeError: scopeBad,
      });
      console.log(
        '[shop-sync-result]',
        JSON.stringify(
          buildShopSyncResultLog(shop, { ok: false, error: errOut, duration_ms: durationMs, failure_code: failure.code }),
          null,
          2,
        ),
      );
      const out = await finish({
        ok: false,
        status: 'failed',
        error_message: errOut,
        error_code: failure.code,
        fetched_orders_count: totalCount,
        duration_ms: durationMs,
      });
      return { ...out, orders: [] };
    }

    const { orders: stampedOrders, ctx } = stampOrdersWithShopContext(ret.data, shop);
    const shopContext = {
      internal_shop_id: shop.internal_shop_id ?? ctx.internal_shop_id ?? null,
      tenant_id: Number(shop.tenant_id ?? shop.tenantId) || null,
      platform_shop_id: ctx.platform_shop_id,
      shop_name: ctx.shop_name,
      market: ctx.market,
    };

    let persistStats = { inserted: 0, updated: 0, skipped: 0 };
    if (stampedOrders.length > 0) {
      try {
        persistStats = await persistOrdersFromCache(stampedOrders, {
          shopContext,
          preview: true,
          persistDebug: true,
          verifyAfterInsert: stampedOrders.length > 0 && stampedOrders.length <= 500,
        });
        if (persistStats.persist_debug) {
          console.log('[persist_debug]', JSON.stringify(persistStats.persist_debug));
        }
        await persistOrderItemsFromCache(stampedOrders);
      } catch (pe) {
        const perr = String(pe?.message || pe);
        await patchMysqlShopSyncState(shop.internal_shop_id, {
          lastSyncOk: false,
          lastSyncError: perr,
        });
        const out = await finish({
          ok: false,
          status: 'failed',
          error_message: `mysql_persist_failed: ${perr}`,
          fetched_orders_count: rawLen,
          inserted_orders_count: 0,
          updated_orders_count: 0,
          failed_orders_count: stampedOrders.length,
          duration_ms: durationMs,
        });
        return { ...out, orders: [] };
      }
    }

    const orderCount = stampedOrders.length;
    await patchMysqlShopSyncState(shop.internal_shop_id, {
      lastSyncOk: true,
      lastSyncError: '',
      todayOrderCount: orderCount,
      healthStatus: orderCount > 0 ? 'normal' : 'no_orders_today',
    });
    const pool = require('../../db/mysqlPool').getMysqlPool();
    const tid = Number(shop.tenant_id ?? shop.tenantId);
    const sid = Number(shop.internal_shop_id);
    if (pool && Number.isFinite(tid) && Number.isFinite(sid)) {
      await applyApiVerifiedHealthyState(pool, {
        tenantId: tid,
        shopId: sid,
        orderCount,
        source: 'shop_sync_runner',
      });
    }
    recordShopSync({
      shopId: shop.shopId,
      shopName: shop.shopName,
      durationMs,
      orderCount: stampedOrders.length,
      ok: true,
    });

    const mysqlWritten =
      persistStats.inserted +
      persistStats.updated +
      (persistStats.updated_unchanged || 0);
    const status =
      persistStats.skipped > 0 && mysqlWritten > 0
        ? 'partial_success'
        : 'success';

    console.log(
      '[shop-sync-result]',
      JSON.stringify(
        buildShopSyncResultLog(shop, {
          ok: true,
          total_count: totalCount,
          raw_orders_length: rawLen,
          saved_orders: stampedOrders.length,
          mysql_written: mysqlWritten,
          duration_ms: durationMs,
        }),
        null,
        2,
      ),
    );
    logSyncPerfProbe({
      phase: 'shop_sync_complete',
      tenant_id: shop.tenant_id,
      shop_id: shop.internal_shop_id,
      tiktok_api_ms: durationMs,
      fetched_orders: rawLen,
      inserted: persistStats.inserted,
      updated: persistStats.updated,
      skipped: persistStats.skipped,
      pages: Array.isArray(ret.requestPages) ? ret.requestPages.length : 0,
    });

    const out = await finish({
      ok: true,
      status,
      fetched_orders_count: rawLen,
      inserted_orders_count: persistStats.inserted,
      updated_orders_count: persistStats.updated,
      failed_orders_count: persistStats.skipped,
      duration_ms: durationMs,
      message: stampedOrders.length === 0 ? 'empty_api_ok' : undefined,
    });
    return { ...out, orders: stampedOrders };
  } catch (e) {
    const reason = String(e?.message || e);
    await patchMysqlShopSyncState(shop.internal_shop_id, {
      lastSyncOk: false,
      lastSyncError: reason,
      status: 'expired',
    });
    recordShopSync({
      shopId: shop.shopId,
      shopName: shop.shopName,
      durationMs: Date.now() - syncStarted,
      orderCount: 0,
      ok: false,
      error: reason,
      tokenExpired: true,
    });
    const out = await finish({
      ok: false,
      status: 'failed',
      error_message: reason,
      duration_ms: Date.now() - syncStarted,
    });
    return { ...out, orders: [] };
  }
}

/**
 * @param {number} tenantId
 * @param {string} shopKey internal id or platform_shop_id
 */
async function resolveShopForSync(tenantId, shopKey) {
  const shops = await loadShopsForOpenApiCollect(
    tenantId != null && Number.isFinite(tenantId) ? { tenantId } : {},
  );
  const key = String(shopKey || '').trim().toLowerCase();
  const found =
    shops.find((s) => String(s.internal_shop_id) === key) ||
    shops.find((s) => String(s.platform_shop_id || s.shopId || '').toLowerCase() === key);
  return found || null;
}

module.exports = { syncOneShop, resolveShopForSync };
