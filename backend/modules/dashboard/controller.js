'use strict';

const svc = require('./service');
const { mapSaasMysqlError } = require('../../middlewares/saasMysqlOnly');
const { parseDashboardFilterQuery } = require('./filterContract');
const { logDashboardContractResult } = require('./contractLog');
const { withTimeWindow } = require('../analytics/timeWindowService');
const realtimeService = require('../realtime/service');
const { attachDebugAuthority } = require('../../lib/dashboardQueryAuthority');

function mysqlErr(res, e) {
  try {
    const { mapExchangeRateHttpError } = require('../../modules/exchangeRateService');
    const fx = mapExchangeRateHttpError(res, e);
    if (fx) return fx;
  } catch {
    /* ignore */
  }
  const blocked = mapSaasMysqlError(res, e);
  if (blocked) return blocked;
  const code = e && e.code ? String(e.code) : '';
  if (code === 'mysql_unavailable') {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  return res.status(500).json({ error: 'dashboard_failed', message: String(e?.message || e) });
}

function contractFromReq(req) {
  return parseDashboardFilterQuery(req.query || {}, Number(req.tenantId));
}

async function summary(req, res) {
  const t0 = Date.now();
  try {
    const tenantId = Number(req.tenantId);
    const contract = contractFromReq(req);
    const out = await svc.getSummary(tenantId, req.query || {}, req.auth);
    const reason =
      out?.reason ||
      out?.debug?.reason ||
      logDashboardContractResult('summary', contract, {
        durationMs: Date.now() - t0,
        rows: out?.orders ?? 0,
        orders: out?.orders ?? 0,
        invalidShop: out?.debug?.invalidShop === true,
        filterHash: out?.debug?.filterHash,
        usedMarketField: out?.debug?.usedMarketField,
        usedStatusField: out?.debug?.usedStatusField,
        usedDateField: out?.debug?.usedDateField,
        sqlTag: 'summary_orders_distinct_id',
      });
    res.json(
      withTimeWindow(
        attachDebugAuthority(
          {
            ok: true,
            deprecated: false,
            module: 'dashboard',
            source: 'mysql',
            reason: reason || undefined,
            ...out,
          },
          contract,
          'summaryService.getUnifiedSummary',
        ),
        tenantId,
        req.query || {},
      ),
    );
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function trend(req, res) {
  const t0 = Date.now();
  try {
    const tenantId = Number(req.tenantId);
    const contract = contractFromReq(req);
    const { rows: list, debug } = await svc.getTrend(tenantId, req.query || {}, req.auth);
    const reason = logDashboardContractResult('trend', contract, {
      durationMs: Date.now() - t0,
      points: Array.isArray(list) ? list.length : 0,
      invalidShop: debug?.invalidShop === true,
    });
    res.json(withTimeWindow({
      ok: true,
      module: 'dashboard',
      source: 'mysql',
      reason: reason || undefined,
      list,
      data: list,
      series: list,
      debug,
    }, tenantId, req.query || {}));
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function ranking(req, res) {
  const t0 = Date.now();
  try {
    const tenantId = Number(req.tenantId);
    const contract = contractFromReq(req);
    const out = await svc.getRanking(tenantId, req.query || {}, req.auth);
    const items = Array.isArray(out?.items) ? out.items : [];
    const reason = logDashboardContractResult('ranking', contract, {
      durationMs: Date.now() - t0,
      rows: items.length,
      reason: out?.reason,
      filterHash: out?.debug?.filterHash,
      usedMarketField: out?.debug?.usedMarketField,
      usedStatusField: out?.debug?.usedStatusField,
      usedDateField: out?.debug?.usedDateField,
      sqlTag: 'ranking_shop_currency_group',
    });
    res.json(withTimeWindow({
      ok: true,
      module: 'dashboard',
      source: 'mysql',
      reason: reason || undefined,
      ...out,
    }, tenantId, req.query || {}));
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function orders(req, res) {
  const t0 = Date.now();
  try {
    const tenantId = Number(req.tenantId);
    const contract = contractFromReq(req);
    const out = await realtimeService.listOrders(tenantId, req.query || {}, req.auth);
    const rows = Array.isArray(out?.orders) ? out.orders.length : 0;
    const reason = logDashboardContractResult('orders', contract, {
      durationMs: Date.now() - t0,
      rows,
      invalidShop: rows === 0 && contract.shopId !== 'all',
    });
    res.set({
      'Cache-Control': 'no-store',
      'X-Api-Tier': 'saas',
      'X-Data-Source': 'mysql',
    });
    res.json(withTimeWindow({ ...out, source: 'mysql', reason: reason || undefined }, tenantId, req.query || {}));
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function productRanking(req, res) {
  const t0 = Date.now();
  try {
    const tenantId = Number(req.tenantId);
    const contract = contractFromReq(req);
    const out = await svc.getProductRanking(tenantId, req.query || {});
    const items = Array.isArray(out?.items) ? out.items : [];
    const reason = logDashboardContractResult('product-ranking', contract, {
      durationMs: Date.now() - t0,
      rows: items.length,
      filterHash: out?.debug?.filterHash,
      usedMarketField: out?.debug?.usedMarketField,
      usedStatusField: out?.debug?.usedStatusField,
      usedDateField: out?.debug?.usedDateField,
      sqlTag: 'product_ranking_items_join_group',
    });
    res.json(withTimeWindow({
      ok: true,
      module: 'dashboard',
      source: 'mysql',
      reason: reason || undefined,
      ...out,
    }, tenantId, req.query || {}));
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function orderVolume(req, res) {
  const t0 = Date.now();
  try {
    const tenantId = Number(req.tenantId);
    const contract = contractFromReq(req);
    const { rows: list, debug } = await svc.getOrderVolume(tenantId, req.query || {}, req.auth);
    const reason = logDashboardContractResult('order-trend', contract, {
      durationMs: Date.now() - t0,
      points: Array.isArray(list) ? list.length : 0,
      invalidShop: debug?.invalidShop === true,
    });
    res.json(withTimeWindow({
      ok: true,
      module: 'dashboard',
      source: 'mysql',
      reason: reason || undefined,
      list,
      data: list,
      series: list,
      debug,
    }, tenantId, req.query || {}));
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function gmvCompare(req, res) {
  const t0 = Date.now();
  try {
    const tenantId = Number(req.tenantId);
    const contract = contractFromReq(req);
    const out = await svc.getGmvCompare(tenantId, req.query || {});
    const points =
      (Array.isArray(out?.today) ? out.today.length : 0) +
      (Array.isArray(out?.yesterday) ? out.yesterday.length : 0);
    const reason = logDashboardContractResult('gmv-trend', contract, {
      durationMs: Date.now() - t0,
      points,
    });
    res.set({ 'Cache-Control': 'no-store', 'X-Data-Source': 'mysql' });
    res.json(withTimeWindow({
      ok: true,
      module: 'dashboard',
      source: 'mysql',
      reason: reason || undefined,
      ...out,
    }, tenantId, req.query || {}));
  } catch (e) {
    return mysqlErr(res, e);
  }
}

module.exports = { summary, trend, ranking, orders, productRanking, orderVolume, gmvCompare };
