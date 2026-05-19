'use strict';

const shopsCtrl = require('../shops/controller');
const opsSvc = require('./service');
const { attachDeprecationBody } = require('../../middlewares/opsAccess');

function sendJson(res, payload, deprecatedReplacement) {
  if (deprecatedReplacement) {
    const body = attachDeprecationBody(payload, deprecatedReplacement);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      body.deprecated = true;
    }
    return res.json(body);
  }
  return res.json(payload);
}

async function importCachePreview(req, res, next) {
  try {
    return await shopsCtrl.importCachePreview(req, res, next);
  } catch (e) {
    if (e && e.code === 'MYSQL_REQUIRED') {
      return res.status(503).json({
        error: 'MYSQL_REQUIRED',
        message: String(e.message || 'legacy cache read blocked'),
        ops_only: true,
      });
    }
    return next(e);
  }
}

async function importCacheCommit(req, res, next) {
  try {
    return await shopsCtrl.importCacheCommit(req, res, next);
  } catch (e) {
    if (e && e.code === 'MYSQL_REQUIRED') {
      return res.status(503).json({
        error: 'MYSQL_REQUIRED',
        message: String(e.message || 'legacy cache read blocked'),
        ops_only: true,
      });
    }
    return next(e);
  }
}

async function ordersReconcile(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const hoursRaw = Number(req.query.hours);
    const windowHours =
      Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(720, Math.max(1, hoursRaw)) : undefined;
    const out = await opsSvc.runOrdersReconcile(tenantId, req.auth, { windowHours });
    const replacement = req.deprecatedOpsReplacement;
    return sendJson(res, out, replacement);
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    if (code === 'mysql_unavailable') {
      return res.status(503).json({ error: 'database_unavailable', message: 'MySQL 不可用', ops_only: true });
    }
    console.error('[ops/orders/reconcile]', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'reconcile_failed', message: String(e?.message || e), ops_only: true });
  }
}

async function ordersRebuildCache(req, res) {
  try {
    const tenantId = Number(req.tenantId);
    const hoursRaw = Number(req.query.hours);
    const windowHours =
      Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(720, Math.max(1, hoursRaw)) : undefined;
    const out = await opsSvc.runOrdersCacheRebuild(tenantId, req.auth, { windowHours });
    const replacement = req.deprecatedOpsReplacement;
    return sendJson(res, out, replacement);
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    if (code === 'mysql_unavailable') {
      return res.status(503).json({ error: 'database_unavailable', message: 'MySQL 不可用', ops_only: true });
    }
    console.error('[ops/orders/rebuild-cache]', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'cache_rebuild_failed', message: String(e?.message || e), ops_only: true });
  }
}

function ordersCachePaths(req, res) {
  res.json(opsSvc.getOrdersCachePathsInfo());
}

module.exports = {
  importCachePreview,
  importCacheCommit,
  ordersReconcile,
  ordersRebuildCache,
  ordersCachePaths,
};
