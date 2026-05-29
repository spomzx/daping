'use strict';

const svc = require('./service');
const { withTimeWindow } = require('../analytics/timeWindowService');
const { mapSaasMysqlError } = require('../../middlewares/saasMysqlOnly');

function mysqlErr(res, e) {
  const blocked = mapSaasMysqlError(res, e);
  if (blocked) return blocked;
  const code = e && e.code ? String(e.code) : '';
  if (code === 'mysql_unavailable') {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  return res.status(500).json({ error: 'realtime_failed', message: String(e?.message || e) });
}

async function orders(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.listOrders(tenantId, req.query || {}, req.auth);
    res.set({ 'Cache-Control': 'no-store', 'X-Data-Source': 'mysql' });
    res.json(
      withTimeWindow(
        {
          ok: true,
          module: 'realtime',
          source: 'mysql',
          ...out,
        },
        tenantId,
        req.query || {},
      ),
    );
  } catch (e) {
    return mysqlErr(res, e);
  }
}

module.exports = { orders };
