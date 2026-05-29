'use strict';

/**
 * @deprecated Legacy war-room only 鈥?not for SaaS.
 * 璁㈠崟涓?GMV锛歄NLY MySQL锛堢姝?orders-cache.json / gmv-cache.json fallback锛夈€? * SaaS 璇风敤 `/api/dashboard/summary` 绛夊绾︽帴鍙ｃ€? */

const path = require('path');
const dayjs = require('dayjs');
const { optionalAuth } = require('../middlewares/optionalAuth');
const { normalizeBaseCurrency, normalizeTargetCurrency } = require('../lib/rates');
const { readShops, readShopsFileInfo } = require('../tiktok-api/shops');
const { buildOrdersDashboardPayload } = require('../tiktok-api/ordersDashboardFromCache');
const { loadDashboardOrdersFromMysql } = require('../modules/orders/mysqlDashboardOrdersService');
const { parseDashboardFilterQuery } = require('../modules/dashboard/filterContract');
const { resolveDashboardShopGate } = require('../lib/dashboardShopGate');
const { isPlatformScope } = require('../lib/userScope');
const { readQueryTenantId } = require('../lib/effectiveTenant');
const { inferOrderCurrency, preloadUsdRates } = require('../lib/currency');
const { getMysqlPool } = require('../db/mysqlPool');
const { buildSaaSFxContext } = require('../lib/saasExchangeRates');

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
      message: '褰撳墠涓?TikTok Open API 璁㈠崟鏁版嵁婧愶紝鏈惎鐢?Seller Compass 閲囬泦銆?,
      collectMode: 'open_api_orders_cache',
      trendMessage: '绗竴闃舵鏆傛湭鍚敤瓒嬪娍鏁版嵁锛岀瓑寰呰鍗曞皬鏃惰仛鍚?,
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

const LEGACY_DASHBOARD_GONE_BODY = {
  error: 'legacy_dashboard_removed',
  message: 'Use /api/dashboard/summary and dashboard contract endpoints',
};

function sendLegacyDashboardGone(res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'X-Deprecated': 'gone',
    'X-Api-Tier': 'legacy-removed',
    'X-Legacy-Use': '/api/dashboard/summary',
  });
  res.status(410).json(LEGACY_DASHBOARD_GONE_BODY);
}

function registerLegacyWarRoomDashboard(app, storageDir) {
  const STORAGE_DIR = storageDir;

  for (const gonePath of ['/api/dashboard', '/api/gmv/current', '/api/dashboard/products']) {
    app.get(gonePath, optionalAuth, (_req, res) => sendLegacyDashboardGone(res));
  }

  app.get(
    ['/api/legacy-dashboard', '/api/legacy-gmv/current'],
    optionalAuth,
    async (req, res) => {
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Deprecated': 'true',
        'X-Api-Tier': 'legacy',
        'X-Legacy-Use': '/api/dashboard/summary (contract)',
      });
      try {
        if (req.auth && isPlatformScope(req.auth)) {
          const qTid = readQueryTenantId(req);
          if (!qTid) {
            return res.status(400).json({
              error: 'missing_selected_tenant',
              message: '璇烽€夋嫨绉熸埛鏌ョ湅鏁版嵁',
            });
          }
          req.tenantId = qTid;
        }

        const filterContract = parseDashboardFilterQuery(req.query, req.tenantId);
        const selectedShopId =
          req.query.shopId != null && String(req.query.shopId).trim() !== ''
            ? String(req.query.shopId).toLowerCase()
            : filterContract.shopId !== 'all'
              ? String(filterContract.shopId).toLowerCase()
              : 'all';
        const orderFilter = filterContract.orderFilter;
        const dashboardRange = filterContract.timeRange;
        const startDate = filterContract.startDate;
        const endDate = filterContract.endDate;
        const marketFilter = filterContract.market;
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

        const mysqlPack = await loadDashboardOrdersFromMysql({
          mysqlGate,
          auth: req.auth,
          tenantId: req.tenantId,
          range: dashboardRange,
          startDate,
          endDate,
          orderFilter,
          market: marketFilter,
          shopId: selectedShopId,
        });
        const rawOrders = mysqlPack.orders;
        const ordersPackUpdatedAt = String(mysqlPack.updatedAt || '');
        const dashboardDataSource = 'mysql';

        const currencySet = new Set();
        for (const o of rawOrders) {
          const c = inferOrderCurrency(o);
          if (c) currencySet.add(c);
        }
        currencySet.add(baseCurrency);
        currencySet.add(targetCurrency);

        const fx = await buildSaaSFxContext(getMysqlPool(), { baseCurrency, targetCurrency });
        const exchangeRate = fx.exchangeRate;
        const exchangeRateSource = fx.source || 'mysql_exchange_rates';
        const exchangeRateUpdatedAt = dayjs().format('YYYY-MM-DD HH:mm:ss');
        const currencyRates = fx.currencyRates;
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
          mysqlContractFiltered: dashboardDataSource === 'mysql',
        });

        const shopsInfo = readShopsFileInfo();
        out.meta = {
          ...(out.meta || {}),
          shopsFileExists: Boolean(shopsInfo?.shopsFileExists),
          shopsFromJsonCount: Array.isArray(shopsInfo?.shops) ? shopsInfo.shops.length : 0,
          ordersCachePath: null,
          dashboardDataSource,
          dataSourcePolicy: 'mysql_only',
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

        /** 绂佹鍐掑厖 [dashboard-contract] endpoint=summary锛涜鐢?GET /api/dashboard/summary */
        if (process.env.DASHBOARD_LEGACY_WAR_ROOM_LOG === '1') {
          const logContract = { ...filterContract, shopId: selectedShopId || 'all' };
          console.warn('[legacy-war-room][deprecated]', {
            endpoint: 'legacy-dashboard-aggregate',
            orderFilter: logContract.orderFilter,
            orders: out.summary?.todayOrders ?? 0,
            gmv: out.summary?.todayGmvTarget ?? 0,
          });
        }

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

  console.log(
    '[routes] legacy dashboard isolated under /api/legacy-dashboard (410: /api/dashboard /api/gmv/current /api/dashboard/products)',
  );
}

module.exports = { registerLegacyWarRoomDashboard };
