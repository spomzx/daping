'use strict';

/**
 * @deprecated Legacy war-room only — not for SaaS.
 * 订单：MySQL 或 `DASHBOARD_DATA_SOURCE=cache` 时 orders-cache.json；
 * 汇率可 gmv-cache.json。SaaS 请用 `/api/dashboard/summary` 与 `/api/analytics/*`（MySQL Only）。
 */

const path = require('path');
const dayjs = require('dayjs');
const { optionalAuth } = require('../middlewares/optionalAuth');
const {
  normalizeBaseCurrency,
  normalizeTargetCurrency,
  getConversionRate,
  getFallbackRate,
} = require('../lib/rates');
const { readShops, readShopsFileInfo } = require('../tiktok-api/shops');
const { buildOrdersDashboardPayload } = require('../tiktok-api/ordersDashboardFromCache');
const { persistOrdersFromCache } = require('../modules/orders/orderPersistenceService');
const { persistOrderItemsFromCache } = require('../modules/orders/orderItemPersistenceService');
const {
  loadDashboardOrdersFromMysql,
  isMysqlPrimaryDashboard,
} = require('../modules/orders/mysqlDashboardOrdersService');
const { normalizeOrderFilter } = require('../lib/orderFilter');
const { resolveDashboardShopGate, orderMatchesEligibleMysqlGate } = require('../lib/dashboardShopGate');
const { isPlatformScope } = require('../lib/userScope');
const { readQueryTenantId } = require('../lib/effectiveTenant');
const { inferOrderCurrency, buildDashboardCurrencyRates, preloadUsdRates } = require('../lib/currency');

function readJsonSafe(filePath) {
  try {
    const fs = require('fs');
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function emptyPayload(baseCurrency, targetCurrency, shopId = 'all') {
  const updatedAt = dayjs().format('YYYY-MM-DD HH:mm:ss');
  return {
    selectedShopId: shopId,
    baseCurrency,
    targetCurrency,
    exchangeRate: 0,
    summary: {
      todayOrders: 0,
      todayGmvBase: 0,
      todayGmvTarget: 0,
      avgOrderValueBase: 0,
      avgOrderValueTarget: 0,
      itemSoldCount: 0,
      skuOrderCount: 0,
      status: 'normal',
      updatedAt,
    },
    shops: [],
    orders: [],
    productRankings: [],
    trend: [],
    meta: {
      dataSource: 'tiktok_open_api_orders',
      message: '当前为 TikTok Open API 订单数据源，未启用 Seller Compass 采集。',
      collectMode: 'open_api_orders_cache',
      trendMessage: '第一阶段暂未启用趋势数据，等待订单小时聚合',
      ordersLoadedCount: 0,
      ordersTodayCount: 0,
      orderStatusStats: {},
      refreshInterval: Number(process.env.GMV_COLLECT_INTERVAL_SECONDS || 300),
      updatedAt,
      legacy_api: true,
      deprecated: true,
    },
  };
}

function registerLegacyWarRoomDashboard(app, storageDir) {
  const STORAGE_DIR = storageDir;

  app.get(
    ['/api/gmv/current', '/api/dashboard', '/api/dashboard/products', '/api/dashboard/orders'],
    optionalAuth,
    async (req, res) => {
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Deprecated': 'true',
        'X-Api-Tier': 'legacy',
        'X-Legacy-Use': '/api/analytics/* or /api/dashboard/summary',
      });
      try {
        if (req.auth && isPlatformScope(req.auth)) {
          const qTid = readQueryTenantId(req);
          if (!qTid) {
            return res.status(400).json({
              error: 'missing_selected_tenant',
              message: '请选择租户查看数据',
            });
          }
          req.tenantId = qTid;
        }

        const selectedShopId = String(req.query.shopId || 'all').toLowerCase();
        const orderFilter = normalizeOrderFilter(req.query.orderFilter ?? req.query.orderStatus);
        const dashboardRange = String(
          req.query.range != null && String(req.query.range).trim() !== '' ? req.query.range : 'today',
        ).trim();
        const startDate = req.query.startDate != null ? String(req.query.startDate) : '';
        const endDate = req.query.endDate != null ? String(req.query.endDate) : '';
        const qMarket = req.query.market;
        const qRegion = req.query.region;
        const marketFilter = String(
          qMarket != null && String(qMarket).trim() !== ''
            ? qMarket
            : qRegion != null && String(qRegion).trim() !== ''
              ? qRegion
              : 'ALL',
        )
          .trim()
          .toUpperCase();
        const baseCurrency = normalizeBaseCurrency(req.query.baseCurrency);
        const targetCurrency = normalizeTargetCurrency(req.query.targetCurrency);

        const mysqlGate = await resolveDashboardShopGate(req);

        if (selectedShopId !== 'all') {
          if (mysqlGate) {
            const ok = mysqlGate.shopIdSet.has(selectedShopId);
            if (!ok) {
              return res.json(emptyPayload(baseCurrency, targetCurrency, selectedShopId));
            }
          } else if (!isPlatformScope(req.auth)) {
            return res.json(emptyPayload(baseCurrency, targetCurrency, selectedShopId));
          } else {
            const okShop = readShops()
              .filter((s) => s && s.enabled !== false)
              .some((s) => String(s.shopId || '').trim().toLowerCase() === selectedShopId);
            if (!okShop) {
              return res.json(emptyPayload(baseCurrency, targetCurrency, selectedShopId));
            }
          }
        }

        let rawOrders = [];
        let ordersPackUpdatedAt = '';
        let dashboardDataSource = 'mysql';

        if (isMysqlPrimaryDashboard()) {
          const mysqlPack = await loadDashboardOrdersFromMysql({
            mysqlGate,
            auth: req.auth,
            range: dashboardRange,
            startDate,
            endDate,
          });
          rawOrders = mysqlPack.orders;
          ordersPackUpdatedAt = String(mysqlPack.updatedAt || '');
          dashboardDataSource = mysqlPack.source || 'mysql';
        } else {
          const pack = readJsonSafe(path.join(STORAGE_DIR, 'orders-cache.json')) || {};
          rawOrders = Array.isArray(pack.orders) ? pack.orders : [];
          if (mysqlGate) {
            rawOrders = rawOrders.filter((o) => orderMatchesEligibleMysqlGate(o, mysqlGate));
          }
          ordersPackUpdatedAt = String(pack.updatedAt || '');
          dashboardDataSource = 'orders-cache.json';
        }

        const gmvCache = readJsonSafe(path.join(STORAGE_DIR, 'gmv-cache.json')) || {};
        const cachedBase = normalizeBaseCurrency(gmvCache?.baseCurrency);
        const cachedTarget = normalizeTargetCurrency(gmvCache?.targetCurrency);
        const cachedRate = Number(gmvCache?.exchangeRate || 0);
        let exchangeRateSource = '';
        let exchangeRateUpdatedAt = '';
        let exchangeRate = 0;

        if (baseCurrency === targetCurrency) {
          exchangeRate = 1;
          exchangeRateSource = 'fixed';
          exchangeRateUpdatedAt = dayjs().format('YYYY-MM-DD HH:mm:ss');
        } else if (
          cachedBase === baseCurrency &&
          cachedTarget === targetCurrency &&
          Number.isFinite(cachedRate) &&
          cachedRate > 0
        ) {
          exchangeRate = cachedRate;
          exchangeRateSource = 'storage_gmv_cache';
          exchangeRateUpdatedAt = String(
            gmvCache?.meta?.updatedAt || gmvCache?.summary?.updatedAt || gmvCache?.updatedAt || '',
          );
        } else {
          const ratePayload = await getConversionRate(baseCurrency, targetCurrency, false);
          const liveRate = Number(ratePayload?.rate || 0);
          if (Number.isFinite(liveRate) && liveRate > 0 && liveRate !== 1) {
            exchangeRate = liveRate;
          } else if (Number.isFinite(liveRate) && liveRate > 0 && liveRate === 1) {
            exchangeRate = Number(getFallbackRate(baseCurrency, targetCurrency) || 0);
          } else {
            exchangeRate = Number(getFallbackRate(baseCurrency, targetCurrency) || 0);
          }
          exchangeRateSource = String(ratePayload?.source || 'fallback');
          exchangeRateUpdatedAt = String(ratePayload?.updatedAt || '');
        }

        if (
          baseCurrency !== targetCurrency &&
          (!Number.isFinite(exchangeRate) || exchangeRate <= 0 || exchangeRate === 1)
        ) {
          exchangeRate = Number(getFallbackRate(baseCurrency, targetCurrency) || 0.198);
          exchangeRateSource = exchangeRateSource || 'fallback_guard';
        }

        const currencySet = new Set();
        for (const o of rawOrders) {
          const c = inferOrderCurrency(o);
          if (c) currencySet.add(c);
        }
        currencySet.add(baseCurrency);
        currencySet.add(targetCurrency);
        const currencyRates = await buildDashboardCurrencyRates(currencySet, baseCurrency, targetCurrency);
        const usdRates = await preloadUsdRates(currencySet);
        const cnyPerUsd = Number(usdRates.CNY || 0) || 0;

        const catalogShops = mysqlGate
          ? mysqlGate.catalogShops
          : readShops()
              .filter((s) => s && s.enabled !== false)
              .map((s) => ({
                shopId: String(s.shopId || '').trim().toLowerCase(),
                shopName: String(s.shopName || ''),
                region: String(s.region || '').trim(),
                market: s.market,
              }));

        if (!isMysqlPrimaryDashboard()) {
          void persistOrdersFromCache(rawOrders);
          void persistOrderItemsFromCache(rawOrders);
        }

        const out = buildOrdersDashboardPayload(rawOrders, {
          orderFilter,
          selectedShopId,
          marketFilter,
          selectedRegion: marketFilter,
          baseCurrency,
          targetCurrency,
          ordersPackUpdatedAt,
          exchangeRate,
          currencyRates,
          usdRates,
          cnyPerUsd,
          catalogShops,
          range: dashboardRange,
          startDate,
          endDate,
        });

        const shopsInfo = readShopsFileInfo();
        out.meta = {
          ...(out.meta || {}),
          shopsFileExists: Boolean(shopsInfo?.shopsFileExists),
          shopsFromJsonCount: Array.isArray(shopsInfo?.shops) ? shopsInfo.shops.length : 0,
          ordersCachePath: 'storage/orders-cache.json',
          dashboardDataSource,
          dashboardShopSource: mysqlGate ? 'mysql' : 'legacy_json',
          dashboardShopGateSkipped: mysqlGate ? false : isPlatformScope(req.auth),
          dashboardTenantId: mysqlGate ? mysqlGate.tenantId : req.auth?.tenant_id ?? null,
          eligibleMysqlShopCount: mysqlGate ? mysqlGate.shopIdSet.size : null,
          mysqlShopRowsTotal: mysqlGate ? mysqlGate.totalMysqlShops : null,
          tenantHasNoShops: Boolean(mysqlGate && mysqlGate.shopIdSet.size === 0),
          needsShopAuthorization: Boolean(mysqlGate && mysqlGate.shopIdSet.size === 0),
          exchangeRateSource,
          exchangeRateUpdatedAt,
          legacy_api: true,
          deprecated: true,
        };

        return res.json(out);
      } catch (e) {
        const out = emptyPayload(
          normalizeBaseCurrency(req.query.baseCurrency),
          normalizeTargetCurrency(req.query.targetCurrency),
          String(req.query.shopId || 'all').toLowerCase(),
        );
        out.meta = {
          ...(out.meta || {}),
          error: String(e?.message || e),
          updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        };
        res.json(out);
      }
    },
  );

  console.log('[routes] legacy war-room: /api/dashboard /api/gmv/current (deprecated)');
}

module.exports = { registerLegacyWarRoomDashboard };
