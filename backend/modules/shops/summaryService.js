'use strict';

const { isPlatformScopeUser } = require('../../lib/userScope');
const { buildShopScopeWhere } = require('../../lib/dataScope');
const { DEFAULT_TENANT_MAX_SHOPS } = require('../../lib/tenantShopLimit');
const { getTenantPlan } = require('../tenants/planService');

/**
 * 近 24h 有订单的店铺数（MySQL，SaaS 主路径）
 * @param {import('mysql2/promise').Pool} pool
 * @param {import('../../lib/dataScope').UserDataScope} scope
 */
async function aggregateTodayOrderShopsFromMysql(pool, scope) {
  const shopScope = buildShopScopeWhere('s', scope);
  if (shopScope.empty || !pool) return 0;

  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [rows] = await pool.query(
    `SELECT COUNT(DISTINCT o.shop_id) AS c
     FROM orders o
     INNER JOIN shops s ON s.id = o.shop_id
     WHERE o.created_at_platform >= ?
       AND s.status <> 'deleted'${shopScope.sql}`,
    [since, ...shopScope.params],
  );
  return Number(rows?.[0]?.c) || 0;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ tenant_id: number, role: string }} auth
 * @param {import('../../lib/dataScope').UserDataScope} [scopeIn]
 */
async function getShopsSummary(pool, auth, scopeIn) {
  const { getUserScope } = require('../../lib/dataScope');
  const scope = scopeIn || (await getUserScope(pool, auth));
  const shopScope = buildShopScopeWhere('s', scope);
  const superAdmin = isPlatformScopeUser(auth) && scope.mode === 'platform';
  const tenantId = Number(scope?.tenantId ?? auth?.tenant_id);

  let rows = [];
  if (!shopScope.empty) {
    const [r] = await pool.query(
      `SELECT id, tenant_id, platform_shop_id, shop_name, status, hidden, sync_enabled,
              auth_status, last_health_status, last_order_count
       FROM shops s WHERE 1=1${shopScope.sql}`,
      shopScope.params,
    );
    rows = Array.isArray(r) ? r : [];
  }

  const totalAuthorized = rows.length;

  const enabledCount = rows.filter((s) => {
    const st = String(s.status || '').toLowerCase();
    const hidden = s.hidden === 1 || s.hidden === true;
    const syncOn = !(s.sync_enabled === 0 || s.sync_enabled === false);
    return st === 'active' && !hidden && syncOn;
  }).length;

  const { isDisplayAbnormalHealthStatus } = require('./shopHealthRefreshService');
  const abnormalCount = rows.filter((s) => {
    const st = String(s.status || '').toLowerCase();
    if (st === 'deleted') return false;
    return isDisplayAbnormalHealthStatus(s.last_health_status);
  }).length;

  const fromHealth = rows.filter((s) => Number(s.last_order_count) > 0).length;
  const todayOrderShopCount =
    fromHealth > 0 ? fromHealth : await aggregateTodayOrderShopsFromMysql(pool, scope);

  if (superAdmin) {
    return {
      totalAuthorized,
      enabledCount,
      todayOrderShopCount,
      abnormalCount,
      scope: 'platform',
      scope_mode: scope.mode,
      max_shops: null,
      perTenantDefaultMaxShops: DEFAULT_TENANT_MAX_SHOPS,
      stats_source: 'mysql',
    };
  }

  let max_shops = DEFAULT_TENANT_MAX_SHOPS;
  let shop_limit = DEFAULT_TENANT_MAX_SHOPS;
  let max_users = 3;
  let current_users = 0;
  let plan_type = 'basic';
  if (Number.isFinite(tenantId) && tenantId > 0) {
    const plan = await getTenantPlan(pool, tenantId);
    if (plan) {
      shop_limit = plan.shop_limit;
      max_shops = plan.shop_limit;
      max_users = plan.max_users;
      current_users = plan.current_users;
      plan_type = plan.plan_type;
    }
  }

  return {
    totalAuthorized,
    enabledCount,
    todayOrderShopCount,
    abnormalCount,
    scope: 'tenant',
    scope_mode: scope.mode,
    max_shops,
    shop_limit,
    max_users,
    plan_type,
    currentShops: totalAuthorized,
    current_users,
    stats_source: 'mysql',
  };
}

module.exports = { getShopsSummary };
