'use strict';

const svc = require('./service');
const { mapSyncApiMessage } = require('../../lib/syncApiMessages');
const { planErrorToHttp } = require('../tenants/planService');

function mysqlErr(res, e) {
  const planHttp = planErrorToHttp(e);
  if (planHttp) {
    return res.status(planHttp.status).json(planHttp.body);
  }
  const code = e && e.code ? String(e.code) : '';
  const reason = e && e.reason ? String(e.reason) : code;
  const message = mapSyncApiMessage(reason, e && e.message ? e.message : code);
  if (code === 'mysql_unavailable') {
    return res.status(503).json({ error: 'database_unavailable', message: 'MySQL 不可用' });
  }
  if (code === 'shop_not_found') {
    return res.status(404).json({ error: 'shop_not_found', message });
  }
  if (code === 'forbidden') {
    return res.status(403).json({ error: 'forbidden', message });
  }
  if (reason === 'rate_limited' || code === 'rate_limited') {
    return res.status(429).json({ error: 'rate_limited', message });
  }
  return res.status(500).json({ error: 'sync_failed', message });
}

async function status(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    res.json(await svc.getStatus(tenantId, req.auth));
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function logs(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.listLogs(tenantId, req.auth, req.query || {});
    res.json({ ok: true, module: 'sync', ...out });
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function runShop(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.runShop(tenantId, req.auth, req.params.shopId);
    res.json({ ok: true, module: 'sync', action: 'run', ...out });
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function retryShop(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.retryShop(tenantId, req.auth, req.params.shopId);
    res.json({ ok: true, module: 'sync', action: 'retry', ...out });
  } catch (e) {
    return mysqlErr(res, e);
  }
}

module.exports = { status, logs, runShop, retryShop };
