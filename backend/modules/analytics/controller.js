'use strict';

const svc = require('./service');
const compareSvc = require('./analyticsCompareService');
const { mapSaasMysqlError } = require('../../middlewares/saasMysqlOnly');

function mysqlErr(res, e) {
  const blocked = mapSaasMysqlError(res, e);
  if (blocked) return blocked;
  const code = e && e.code ? String(e.code) : '';
  if (code === 'mysql_unavailable') {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  return res.status(500).json({ error: 'analytics_failed', message: String(e?.message || e) });
}

async function topProducts(req, res) {
  const q = req.query || {};
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.getTopProducts(tenantId, q, req.auth);
    res.json(out);
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function shopTrend(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.getShopTrend(tenantId, req.query || {}, req.auth);
    res.json(out);
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function topShops(req, res) {
  const q = req.query || {};
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.getTopShops(tenantId, q, req.auth);
    res.json(out);
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function recentOrders(req, res) {
  const q = req.query || {};
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.getRecentOrders(tenantId, q, req.auth);
    res.json(out);
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function searchSku(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.searchSku(tenantId, req.query || {}, req.auth);
    res.json(out);
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function gmvCompare(req, res) {
  const raw = req.query || {};
  const q = {
    ...raw,
    shop_id: raw.shop_id ?? raw.shopId ?? raw.selectedShopId,
    groupBy: raw.groupBy ?? raw.group_by,
    status: raw.status ?? raw.orderFilter,
    orderFilter: raw.orderFilter ?? raw.status,
  };
  try {
    const tenantId = Number(req.tenantId);
    const out = await compareSvc.getGmvCompare(tenantId, q, {
      skipShopGate: false,
      skipTenant: false,
    });
    res.json(out);
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    if (code === 'mysql_unavailable') {
      return mysqlErr(res, e);
    }
    console.error('[gmv-compare] controller', e?.message || e);
    const hours = Math.min(720, Math.max(1, Number(raw.hours) || 24));
    const groupBy = String(raw.groupBy ?? raw.group_by ?? 'hour').toLowerCase() === 'day' ? 'day' : 'hour';
    res.json({
      today: [],
      yesterday: [],
      summary: { todayTotal: 0, yesterdayTotal: 0, changePercent: null },
      gmv_currency: 'USD',
      meta: {
        hours,
        groupBy,
        seriesEmpty: true,
        emptyReason: 'query_failed',
      },
    });
  }
}

async function statusDebug(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.getStatusDebugCounts(tenantId, req.query || {}, req.auth);
    res.json(out);
  } catch (e) {
    return mysqlErr(res, e);
  }
}

module.exports = {
  topProducts,
  shopTrend,
  topShops,
  recentOrders,
  searchSku,
  gmvCompare,
  statusDebug,
};
