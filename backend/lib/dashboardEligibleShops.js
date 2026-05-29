'use strict';

const { buildShopScopeWhere } = require('./dataScope');

/**
 * 大屏 eligible 店铺：active + 未隐藏 + dataScope（与店铺管理可见范围一致）
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {import('./dataScope').UserDataScope} dataScope
 * @param {{ market?: string }} [contract]
 */
async function listDashboardEligibleShops(pool, tenantId, dataScope, contract = {}) {
  if (!pool) return { shops: [], empty: true };

  const scope =
    dataScope && dataScope.mode !== 'none'
      ? dataScope
      : { mode: 'tenant_all', tenantId, userId: null, role: '', shopIds: null };

  const shopScope = buildShopScopeWhere('s', scope);
  if (shopScope.empty) {
    return { shops: [], empty: true };
  }

  const params = [...shopScope.params];
  let marketClause = '';
  const m = String(contract.market || 'ALL').trim().toUpperCase();
  if (m && m !== 'ALL') {
    marketClause = ' AND UPPER(COALESCE(NULLIF(TRIM(s.market), ""), NULLIF(TRIM(s.region), ""), "")) = ? ';
    params.push(m);
  }

  const [rows] = await pool.query(
    `SELECT
       s.id AS shop_id,
       s.platform_shop_id,
       COALESCE(NULLIF(TRIM(s.display_name), ''), NULLIF(TRIM(s.shop_name), ''), '') AS shop_name,
       UPPER(COALESCE(NULLIF(TRIM(s.market), ''), NULLIF(TRIM(s.region), ''), '')) AS market,
       s.status,
       s.hidden,
       s.sync_enabled
     FROM shops s
     WHERE s.status = 'active'
       AND (s.hidden = 0 OR s.hidden IS NULL)
       ${shopScope.sql}
       ${marketClause}
     ORDER BY s.sort_order ASC, s.id ASC`,
    params,
  );

  return { shops: Array.isArray(rows) ? rows : [], empty: false };
}

/**
 * 将排行 SQL 结果与 eligible 店铺合并（无单店铺 orders=0 gmv=0）
 * @param {Map<number, { shop_id: number, shop_name: string, market: string, orders: number, gmv_usd: number }>} shopMap
 * @param {Record<string, unknown>[]} eligibleRows
 */
function mergeRankingWithEligibleShops(shopMap, eligibleRows) {
  for (const r of Array.isArray(eligibleRows) ? eligibleRows : []) {
    const sid = Number(r.shop_id);
    if (!Number.isFinite(sid) || sid <= 0) continue;
    if (!shopMap.has(sid)) {
      shopMap.set(sid, {
        shop_id: sid,
        shop_name: String(r.shop_name || ''),
        market: String(r.market || ''),
        orders: 0,
        gmv_usd: 0,
      });
    }
  }
  return shopMap;
}

/**
 * @param {object|null|undefined} auth
 * @param {number} tenantId
 */
async function resolveDashboardDataScope(auth, tenantId) {
  const { getMysqlPool } = require('../db/mysqlPool');
  const { getUserScope } = require('./dataScope');
  const { enforceAuthTenantScope } = require('./resolveTenantShop');
  const pool = getMysqlPool();
  const scope = await getUserScope(pool, auth);
  return enforceAuthTenantScope(scope, auth, tenantId);
}

module.exports = {
  listDashboardEligibleShops,
  mergeRankingWithEligibleShops,
  resolveDashboardDataScope,
};
