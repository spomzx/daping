'use strict';

const { buildShopScopeWhere } = require('../../lib/dataScope');
const { sqlBestAuthTokenJoin } = require('../../lib/shopTokenStatus');
const { resolveTenantShop } = require('../../lib/resolveTenantShop');

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {import('../../lib/dataScope').UserDataScope} scope
 * @param {number} requiredTenantId req.auth.tenant_id
 */
async function listAuthorizations(pool, scope, requiredTenantId) {
  const tid = Number(requiredTenantId);
  if (!pool || !Number.isFinite(tid) || tid <= 0) {
    return [];
  }

  const params = [tid];
  let assignedSql = '';
  if (scope && scope.mode === 'tenant_assigned') {
    const ids = Array.isArray(scope.shopIds) ? scope.shopIds : [];
    if (!ids.length) return [];
    assignedSql = ` AND s.id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else if (!scope || scope.mode === 'none') {
    return [];
  }

  const tokenJoin = sqlBestAuthTokenJoin('s', 't');

  const [rows] = await pool.query(
    `SELECT
      s.id AS shop_id,
      s.tenant_id,
      s.platform,
      s.platform_shop_id,
      s.shop_name,
      s.market,
      s.region,
      s.status AS shop_status,
      s.last_sync_at,
      s.last_health_status,
      s.last_health_message,
      t.id AS token_id,
      t.access_token,
      t.token_expire_at,
      t.refresh_token_expire_at,
      t.raw_auth_json,
      t.updated_at AS token_updated_at,
      t.created_at AS token_created_at,
      (CASE WHEN t.access_token IS NOT NULL AND TRIM(t.access_token) <> '' THEN 1 ELSE 0 END) AS has_token,
      (CASE
        WHEN t.access_token IS NOT NULL AND TRIM(t.access_token) <> ''
             AND t.token_expire_at IS NOT NULL AND t.token_expire_at < NOW(3) THEN 'expired'
        WHEN t.access_token IS NULL OR TRIM(t.access_token) = '' THEN 'missing'
        ELSE 'active'
      END) AS token_status
     FROM shops s
     ${tokenJoin}
     WHERE s.status <> 'deleted'
       AND s.tenant_id = ?
       ${assignedSql}
     ORDER BY s.sort_order ASC, s.id ASC`,
    params,
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {import('../../lib/dataScope').UserDataScope} scope
 * @param {string} shopKey
 */
async function getAuthorizationDetail(pool, scope, shopKey) {
  const shopScope = buildShopScopeWhere('s', scope);
  if (shopScope.empty || scope.tenantId == null) return null;

  const key = String(shopKey || '').trim();
  const tid = Number(scope.tenantId);
  const numId = Number(key);
  const row =
    Number.isFinite(numId) && numId > 0 && String(numId) === key
      ? await resolveTenantShop(pool, tid, { shopId: numId })
      : await resolveTenantShop(pool, tid, { platformShopId: key });
  if (!row) return null;

  const safe = {
    shop_id: row.shop_id ?? row.internal_shop_id,
    tenant_id: row.tenant_id,
    platform: row.platform,
    platform_shop_id: row.platform_shop_id,
    shop_name: row.shop_name,
    market: row.market,
    region: row.region,
    last_sync_at: row.last_sync_at,
    token_expire_at: row.token_expire_at,
    refresh_token_expire_at: row.refresh_token_expire_at,
    token_updated_at: row.token_updated_at,
    raw_auth_json: row.raw_auth_json,
  };
  if (safe.raw_auth_json && typeof safe.raw_auth_json === 'object') {
    const raw = { ...safe.raw_auth_json };
    delete raw.access_token;
    delete raw.refresh_token;
    safe.raw_auth_json = raw;
  }
  safe.has_access_token = Boolean(row.access_token && String(row.access_token).trim());
  safe.has_refresh_token = Boolean(row.refresh_token && String(row.refresh_token).trim());

  return safe;
}

module.exports = { listAuthorizations, getAuthorizationDetail };
