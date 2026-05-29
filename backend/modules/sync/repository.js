'use strict';

const { buildShopScopeWhere, buildSyncScopeWhere } = require('../../lib/dataScope');
const { sqlBestAuthTokenJoin } = require('../../lib/shopTokenStatus');

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {import('../../lib/dataScope').UserDataScope} scope
 * @param {{ shop_id?: string, platform?: string, status?: string, date_from?: string, date_to?: string, limit?: number }} filters
 */
async function listSyncShopLogs(pool, scope, filters = {}) {
  const syncScope = buildSyncScopeWhere('l', scope);
  if (syncScope.empty) {
    return [];
  }

  const params = [...syncScope.params];
  let whereSql = `1=1${syncScope.sql}`;

  if (filters.shop_id) {
    const sid = String(filters.shop_id).trim();
    whereSql += ' AND (l.shop_id = ? OR l.platform_shop_id = ?)';
    params.push(sid, sid);
  }
  if (filters.platform) {
    whereSql += ' AND l.platform = ?';
    params.push(String(filters.platform).trim());
  }
  if (filters.status) {
    whereSql += ' AND l.status = ?';
    params.push(String(filters.status).trim());
  }
  if (filters.date_from) {
    whereSql += ' AND l.created_at >= ?';
    params.push(String(filters.date_from).trim());
  }
  if (filters.date_to) {
    whereSql += ' AND l.created_at <= ?';
    params.push(String(filters.date_to).trim());
  }

  const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));
  params.push(limit);

  const [rows] = await pool.query(
    `SELECT l.id, l.tenant_id, l.shop_id, l.platform_shop_id, l.platform, l.status,
            l.message, l.error_message,
            l.orders_fetched, l.fetched_orders_count, l.inserted_orders_count,
            l.updated_orders_count, l.failed_orders_count, l.duration_ms,
            l.started_at, l.finished_at, l.created_at,
            s.shop_name, s.market
     FROM sync_shop_logs l
     LEFT JOIN shops s ON s.id = l.shop_id
     WHERE ${whereSql}
     ORDER BY l.id DESC
     LIMIT ?`,
    params,
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {import('../../lib/dataScope').UserDataScope} scope
 * @param {number} requiredTenantId 必须为 req.auth.tenant_id，禁止跨 tenant
 */
async function listShopSyncStatus(pool, scope, requiredTenantId) {
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
      s.id AS resolved_shop_id,
      s.tenant_id,
      s.platform,
      s.platform_shop_id,
      s.shop_name,
      s.market,
      s.region,
      s.sync_enabled,
      s.hidden,
      s.status AS shop_status,
      s.last_sync_at,
      s.last_health_status,
      s.last_health_message,
      s.last_order_count,
      t.access_token,
      t.token_expire_at,
      t.refresh_token_expire_at,
      t.scope_json,
      t.raw_auth_json,
      (CASE WHEN t.access_token IS NOT NULL AND TRIM(t.access_token) <> '' THEN 1 ELSE 0 END) AS has_token,
      (CASE
        WHEN t.access_token IS NOT NULL AND TRIM(t.access_token) <> ''
             AND t.token_expire_at IS NOT NULL AND t.token_expire_at < NOW(3) THEN 'expired'
        WHEN t.access_token IS NULL OR TRIM(t.access_token) = '' THEN 'missing'
        ELSE 'active'
      END) AS token_status,
      l.id AS last_log_id,
      l.status AS last_log_status,
      l.fetched_orders_count AS last_fetched,
      l.inserted_orders_count AS last_inserted,
      l.error_message AS last_error,
      l.finished_at AS last_finished_at,
      l.duration_ms AS last_duration_ms,
      (
        SELECT COUNT(*) FROM orders o
        WHERE o.tenant_id = s.tenant_id
          AND (
            o.shop_id = s.id
            OR (
              TRIM(COALESCE(s.platform_shop_id, '')) <> ''
              AND LOWER(TRIM(o.platform_shop_id)) = LOWER(TRIM(s.platform_shop_id))
            )
          )
          AND COALESCE(o.paid_at, o.created_at_platform, o.created_at) >= DATE_SUB(NOW(3), INTERVAL 24 HOUR)
      ) AS today_orders_count
     FROM shops s
     ${tokenJoin}
     LEFT JOIN sync_shop_logs l ON l.id = (
       SELECT l2.id FROM sync_shop_logs l2
       WHERE l2.shop_id = s.id AND l2.tenant_id = s.tenant_id
       ORDER BY l2.id DESC LIMIT 1
     )
     WHERE s.platform = 'tiktok'
       AND s.status <> 'deleted'
       AND s.tenant_id = ?
       ${assignedSql}
     ORDER BY s.sort_order ASC, s.id ASC`,
    params,
  );
  return Array.isArray(rows) ? rows : [];
}

module.exports = { listSyncShopLogs, listShopSyncStatus };
