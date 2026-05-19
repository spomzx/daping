'use strict';

const { PLAN_PRESETS, resolveShopLimit } = require('../modules/tenants/planService');

/** @deprecated 请读 tenants.shop_limit；保留常量供平台摘要默认展示 */
const DEFAULT_TENANT_MAX_SHOPS = PLAN_PRESETS.enterprise.shop_limit;

function resolveTenantMaxShops(valueOrRow) {
  if (valueOrRow != null && typeof valueOrRow === 'object') {
    return resolveShopLimit(valueOrRow);
  }
  const n = Number(valueOrRow);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return PLAN_PRESETS.basic.shop_limit;
}

module.exports = { DEFAULT_TENANT_MAX_SHOPS, resolveTenantMaxShops, resolveShopLimit };
