'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const svc = require('./service');

function mysqlErr(res, e) {
  const code = e && e.code ? String(e.code) : '';
  if (code === 'mysql_unavailable' || code === 'MYSQL_REQUIRED') {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  if (code === 'not_found') {
    return res.status(404).json({ error: 'not_found' });
  }
  return res.status(500).json({ error: 'operation_logs_failed', message: String(e?.message || e) });
}

async function list(req, res) {
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  try {
    const out = await svc.listForActor(pool, req.auth, req.tenantId, req.query || {});
    return res.json({ ok: true, module: 'operation-logs', ...out });
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function stats(req, res) {
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  try {
    const out = await svc.statsForActor(pool, req.auth, req.tenantId, req.query || {});
    return res.json({ ok: true, module: 'operation-logs', ...out });
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function detail(req, res) {
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  try {
    const row = await svc.detailForActor(pool, req.auth, req.tenantId, id);
    return res.json({ ok: true, item: row });
  } catch (e) {
    return mysqlErr(res, e);
  }
}

module.exports = { list, stats, detail };
