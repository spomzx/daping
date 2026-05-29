'use strict';

/**
 * SaaS 租户安全锁：default tenant 与关键租户不可被自动 repair/cleanup 删除。
 */

/**
 * @param {{ id?: number|string, tenant_code?: string|null }|null|undefined} tenant
 */
function isProtectedTenant(tenant) {
  if (!tenant) return false;

  return Number(tenant.id) === 1 || String(tenant.tenant_code || '').trim().toLowerCase() === 'default';
}

/**
 * @param {Record<string, unknown>} payload
 */
function logTenantAudit(payload) {
  console.warn(
    '[tenant-audit]',
    JSON.stringify({
      timestamp: new Date().toISOString(),
      ...payload,
    }),
  );
}

/**
 * @param {{ id?: number|string, tenant_code?: string|null }} tenant
 * @param {{ action: string, reason: string, operator?: string }} meta
 */
function logBlockedProtectedTenant(tenant, meta) {
  console.warn('[tenant-safety] blocked delete protected tenant', tenant.id, tenant.tenant_code);
  logTenantAudit({
    tenant_id: tenant.id,
    tenant_code: tenant.tenant_code,
    operator: meta.operator || 'system',
    action: meta.action,
    reason: meta.reason,
  });
}

/**
 * @param {{ id?: number|string, tenant_code?: string|null }} tenant
 * @param {{ action: string, reason: string, operator?: string, note?: string }} meta
 */
function logTenantRepairSkipped(tenant, meta) {
  console.warn(
    '[tenant-safety] auto-delete skipped (repair)',
    tenant.id,
    tenant.tenant_code,
    meta.note || '',
  );
  logTenantAudit({
    tenant_id: tenant.id,
    tenant_code: tenant.tenant_code,
    operator: meta.operator || 'system',
    action: meta.action,
    reason: meta.reason,
  });
}

module.exports = {
  isProtectedTenant,
  logTenantAudit,
  logBlockedProtectedTenant,
  logTenantRepairSkipped,
};
