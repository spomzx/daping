'use strict';

const svc = require('./service');

function mysqlErr(res, e, next) {
  const code = e && e.code ? String(e.code) : '';
  if (code === 'mysql_unavailable') {
    return res.status(503).json({ error: 'database_unavailable', message: 'MySQL 不可用' });
  }
  if (code === 'not_found') {
    return res.status(404).json({ error: 'authorization_not_found', message: String(e.message || e) });
  }
  if (next) return next(e);
  return res.status(500).json({ error: 'authorizations_failed', message: String(e?.message || e) });
}

async function list(req, res, next) {
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.list(tenantId, req.auth);
    res.json({ ok: true, module: 'authorizations', ...out });
  } catch (e) {
    return mysqlErr(res, e, next);
  }
}

async function listAlias(req, res, next) {
  return list(req, res, next);
}

async function detail(req, res, next) {
  try {
    const tenantId = Number(req.tenantId);
    const key = req.params.id || req.params.shopId;
    const out = await svc.detail(tenantId, key, req.auth);
    res.json({ ok: true, module: 'authorizations', ...out });
  } catch (e) {
    return mysqlErr(res, e, next);
  }
}

module.exports = { list, listAlias, detail };
