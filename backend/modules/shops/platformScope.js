'use strict';

const { isPlatformScopeUser } = require('../../lib/userScope');

/**
 * 解析 import-cache / refresh-health 的目标租户范围。
 * @param {import('express').Request} req
 * @returns {{ ok: true, mode: 'single' | 'all', tenantIds: number[] } | { ok: false, status: number, error: string }}
 */
function resolveShopWriteScope(req) {
  const superAdmin = isPlatformScopeUser(req.auth);
  const scope = String(req.query.scope || req.body?.scope || '').trim().toLowerCase();
  const tenantIdRaw = req.query.tenant_id ?? req.query.tenantId ?? req.body?.tenant_id ?? req.body?.tenantId;
  const tenantIdParam = tenantIdRaw != null && tenantIdRaw !== '' ? Number(tenantIdRaw) : null;
  const ownTenantId = Number(req.tenantId);

  if (!superAdmin) {
    if (scope === 'all') {
      return { ok: false, status: 403, error: 'forbidden' };
    }
    if (tenantIdParam != null && Number.isFinite(tenantIdParam) && tenantIdParam !== ownTenantId) {
      return { ok: false, status: 403, error: 'forbidden' };
    }
    if (!Number.isFinite(ownTenantId) || ownTenantId <= 0) {
      return { ok: false, status: 400, error: 'invalid_tenant' };
    }
    return { ok: true, mode: 'single', tenantIds: [ownTenantId] };
  }

  if (scope === 'all') {
    return { ok: true, mode: 'all', tenantIds: [] };
  }

  if (tenantIdParam != null && Number.isFinite(tenantIdParam) && tenantIdParam > 0) {
    return { ok: true, mode: 'single', tenantIds: [tenantIdParam] };
  }

  if (!Number.isFinite(ownTenantId) || ownTenantId <= 0) {
    return { ok: false, status: 400, error: 'invalid_tenant' };
  }
  return { ok: true, mode: 'single', tenantIds: [ownTenantId] };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<number[]>}
 */
async function listActiveTenantIds(pool) {
  const [rows] = await pool.query(
    `SELECT id FROM tenants WHERE status IS NULL OR status NOT IN ('deleted', 'archived') ORDER BY id ASC`,
  );
  return (Array.isArray(rows) ? rows : [])
    .map((r) => Number(r.id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

module.exports = { resolveShopWriteScope, listActiveTenantIds };
