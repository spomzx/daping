'use strict';

const svc = require('./service');
const { mapSaasMysqlError } = require('../../middlewares/saasMysqlOnly');

function mysqlErr(res, e) {
  const blocked = mapSaasMysqlError(res, e);
  if (blocked) return blocked;
  const code = e && e.code ? String(e.code) : '';
  if (code === 'mysql_unavailable') {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  return res.status(500).json({ error: 'dashboard_failed', message: String(e?.message || e) });
}

async function summary(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.getSummary(tenantId, req.query || {}, req.auth);
    res.json({ ok: true, deprecated: false, module: 'dashboard', ...out });
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function trend(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const list = await svc.getTrend(tenantId, req.query || {}, req.auth);
    res.json({
      ok: true,
      module: 'dashboard',
      source: 'mysql',
      list,
      data: list,
      series: list,
    });
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function ranking(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.getRanking(tenantId, req.query || {}, req.auth);
    res.json({ ok: true, module: 'dashboard', ...out });
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function orders(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const { getWarRoomRealtimeOrders } = require('./warRoomOrders');
    const out = await getWarRoomRealtimeOrders(tenantId, req.query || {}, req.auth);
    res.set({
      'Cache-Control': 'no-store',
      'X-Api-Tier': 'saas',
      'X-Data-Source': 'mysql',
    });
    res.json(out);
  } catch (e) {
    return mysqlErr(res, e);
  }
}

module.exports = { summary, trend, ranking, orders };
