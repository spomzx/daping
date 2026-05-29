'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { isPlatformScope } = require('../../lib/userScope');
const planSvc = require('./planService');
const svc = require('./service');
const { auditFromRequest } = require('../operation-logs/audit');

function parseTenantId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseUpdatedBy(req) {
  const n = Number(req.auth?.user_id);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function list(req, res, next) {
  try {
    const pool = getMysqlPool();
    if (!pool) {
      return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
    }
    const result = await svc.listTenants(pool, req.query || {});
    return res.json({ ...result, tenants: result.list });
  } catch (e) {
    return next(e);
  }
}

async function getPlan(req, res, next) {
  try {
    const pool = getMysqlPool();
    if (!pool) {
      return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
    }
    const id = parseTenantId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_id' });
    const platform = isPlatformScope(req.auth);
    if (!platform && Number(req.auth.tenant_id) !== id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const plan = await planSvc.getTenantPlan(pool, id);
    if (!plan) return res.status(404).json({ error: 'tenant_not_found' });
    return res.json({ plan });
  } catch (e) {
    return next(e);
  }
}

async function getMyPlan(req, res, next) {
  try {
    const pool = getMysqlPool();
    if (!pool) {
      return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
    }
    const id = Number(req.auth.tenant_id);
    const plan = await planSvc.getTenantPlan(pool, id);
    if (!plan) return res.status(404).json({ error: 'tenant_not_found' });
    return res.json({ plan });
  } catch (e) {
    return next(e);
  }
}

async function patchTenant(req, res, next) {
  try {
    const pool = getMysqlPool();
    if (!pool) {
      return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
    }
    const id = parseTenantId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_id' });
    const beforePlan = await planSvc.getTenantPlan(pool, id);
    const out = await svc.updateTenant(pool, id, req.body || {}, parseUpdatedBy(req));
    if (!out.ok) {
      return res.status(out.status || 500).json({ error: out.error });
    }
    await auditFromRequest(pool, req, {
      tenantId: id,
      action: 'update_tenant_plan',
      module: 'tenants',
      targetType: 'tenant',
      targetId: id,
      beforeData: beforePlan,
      afterData: out.plan,
      status: 'success',
    });
    return res.json({ ok: true, plan: out.plan });
  } catch (e) {
    return next(e);
  }
}

async function patchPlan(req, res, next) {
  return patchTenant(req, res, next);
}

module.exports = { list, getPlan, getMyPlan, patchTenant, patchPlan };
