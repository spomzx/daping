'use strict';

const { authTenantId } = require('./resolveTenantShop');
const { isPlatformScope } = require('./userScope');

/**
 * 从 query 读取 tenant_id（仅平台管理员可生效，由 resolveEffectiveTenantId 校验）
 * @param {import('express').Request} req
 */
function readQueryTenantId(req) {
  const q = req?.query || {};
  const raw = q.tenant_id ?? q.tenantId;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * @param {import('mysql2/promise').Pool | null | undefined} pool
 * @param {number} tenantId
 */
async function assertTenantExists(pool, tenantId) {
  if (!pool) return true;
  const [rows] = await pool.query(
    `SELECT id FROM tenants WHERE id = ? AND status NOT IN ('disabled','deleted') LIMIT 1`,
    [tenantId],
  );
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * 解析当前请求应使用的租户 ID（SaaS 读接口 + legacy dashboard）
 * @param {import('express').Request} req
 * @param {import('mysql2/promise').Pool | null} [pool]
 */
async function resolveEffectiveTenantId(req, pool = null) {
  const authTid = authTenantId(req.auth);
  const requested = readQueryTenantId(req);
  const platform = req.auth && isPlatformScope(req.auth);

  if (!platform) {
    if (requested != null && authTid != null && requested !== authTid) {
      return {
        ok: false,
        status: 403,
        error: 'forbidden',
        message: '无权查看其他租户数据',
      };
    }
    const tid = authTid;
    if (tid == null) {
      return { ok: false, status: 401, error: 'unauthorized' };
    }
    return { ok: true, tenantId: tid, override: false };
  }

  if (requested == null) {
    return {
      ok: false,
      status: 400,
      error: 'missing_selected_tenant',
      message: '请选择租户查看数据',
    };
  }

  const target = requested;
  if (!Number.isFinite(target) || target <= 0) {
    return { ok: false, status: 400, error: 'invalid_tenant', message: '请指定 tenant_id' };
  }

  const exists = await assertTenantExists(pool, target);
  if (!exists) {
    return { ok: false, status: 404, error: 'tenant_not_found' };
  }

  return {
    ok: true,
    tenantId: target,
    override: requested != null && requested !== authTid,
  };
}

module.exports = {
  readQueryTenantId,
  resolveEffectiveTenantId,
  assertTenantExists,
};
