'use strict';

const svc = require('./ordersListService');
const { mapSaasMysqlError } = require('../../middlewares/saasMysqlOnly');
const { withTimeWindow } = require('../analytics/timeWindowService');

function mysqlErr(res, e) {
  const blocked = mapSaasMysqlError(res, e);
  if (blocked) return blocked;
  const code = e && e.code ? String(e.code) : '';
  if (code === 'mysql_unavailable') {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  if (code === 'not_found') {
    return res.status(404).json({ error: 'order_not_found', message: String(e.message || e) });
  }
  return res.status(500).json({ error: 'orders_failed', message: String(e?.message || e) });
}

async function list(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.list(tenantId, req.query || {}, req.auth);
    res.json(withTimeWindow({ ok: true, module: 'orders', ...out }, tenantId, req.query || {}));
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function detail(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const key = req.params.id || req.query.id;
    const out = await svc.detail(tenantId, key, req.auth);
    res.json({ ok: true, module: 'orders', ...out });
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function stats(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.stats(tenantId, req.query || {}, req.auth);
    res.json(withTimeWindow({ ok: true, module: 'orders', ...out }, tenantId, req.query || {}));
  } catch (e) {
    return mysqlErr(res, e);
  }
}

module.exports = { list, detail, stats };
