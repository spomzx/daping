'use strict';

/** 系统租户：平台管理员归属，不在租户管理/切换器中展示 */
const SYSTEM_TENANT_CODE = 'default';

function isSystemTenantCode(tenantCode) {
  return String(tenantCode || '')
    .trim()
    .toLowerCase() === SYSTEM_TENANT_CODE;
}

function parseIncludeSystem(query = {}) {
  const v = query.include_system ?? query.includeSystem;
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

/**
 * @param {boolean} includeSystem
 * @returns {{ sql: string, params: unknown[] }}
 */
function buildSystemTenantFilter(includeSystem) {
  if (includeSystem) return { sql: '', params: [] };
  return { sql: `tenant_code <> ?`, params: [SYSTEM_TENANT_CODE] };
}

module.exports = {
  SYSTEM_TENANT_CODE,
  isSystemTenantCode,
  parseIncludeSystem,
  buildSystemTenantFilter,
};
