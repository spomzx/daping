'use strict';

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} baseWhere SQL after WHERE (no leading WHERE)
 * @param {unknown[]} baseParams
 */
async function countUsers(pool, baseWhere, baseParams) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c
     FROM users u
     INNER JOIN user_tenants ut ON ut.user_id = u.id
     INNER JOIN tenants t ON t.id = ut.tenant_id
     WHERE ${baseWhere}`,
    baseParams,
  );
  return Number(rows?.[0]?.c) || 0;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 */
async function listUsersPaged(pool, baseWhere, baseParams, limit, offset) {
  const [rows] = await pool.query(
    `SELECT
       u.id,
       u.username,
       u.display_name,
       u.contact,
       u.status AS user_status,
       u.scope AS user_scope,
       u.last_login_at,
       u.created_at,
       ut.tenant_id,
       ut.role,
       ut.status AS membership_status,
       t.tenant_code,
       t.tenant_name,
       (SELECT COUNT(*) FROM user_shop_permissions usp WHERE usp.user_id = u.id) AS assigned_shop_count
     FROM users u
     INNER JOIN user_tenants ut ON ut.user_id = u.id
     INNER JOIN tenants t ON t.id = ut.tenant_id
     WHERE ${baseWhere}
     ORDER BY ut.tenant_id ASC, u.id ASC
     LIMIT ? OFFSET ?`,
    [...baseParams, limit, offset],
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} userId
 */
/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} userId
 * @param {number|null} [tenantId] 若提供则仅返回该租户店铺（tenant 隔离）
 */
async function getShopPermissionsByUserId(pool, userId, tenantId = null) {
  const params = [userId];
  let tenantSql = '';
  if (tenantId != null && Number.isFinite(Number(tenantId))) {
    tenantSql = ' AND s.tenant_id = ?';
    params.push(Number(tenantId));
  }
  const [rows] = await pool.query(
    `SELECT
       s.id AS shop_id,
       s.shop_name,
       s.platform,
       COALESCE(s.region, s.market) AS region,
       s.status,
       s.tenant_id
     FROM user_shop_permissions usp
     INNER JOIN shops s ON s.id = usp.shop_id
     WHERE usp.user_id = ?
       AND s.status <> 'deleted'${tenantSql}
     ORDER BY s.shop_name ASC, s.id ASC`,
    params,
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} whereSql fragment after WHERE (e.g. "s.status <> 'deleted' AND ...")
 * @param {unknown[]} params
 */
async function listAssignableShops(pool, whereSql, params) {
  const [rows] = await pool.query(
    `SELECT
       s.id AS shop_id,
       s.shop_name,
       s.platform,
       COALESCE(s.region, s.market) AS region,
       s.status,
       s.tenant_id
     FROM shops s
     WHERE ${whereSql}
     ORDER BY s.tenant_id ASC, s.shop_name ASC, s.id ASC
     LIMIT 2000`,
    params,
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number[]} shopIds
 * @param {string} whereSql
 * @param {unknown[]} params
 */
async function countShopsInScope(pool, shopIds, whereSql, params) {
  if (!shopIds.length) return 0;
  const placeholders = shopIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c FROM shops s WHERE ${whereSql} AND s.id IN (${placeholders})`,
    [...params, ...shopIds],
  );
  return Number(rows?.[0]?.c) || 0;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} userId
 * @param {number[]} shopIds
 */
async function replaceUserShopPermissions(pool, userId, shopIds) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM user_shop_permissions WHERE user_id = ?', [userId]);
    const ids = Array.isArray(shopIds) ? shopIds : [];
    for (const sid of ids) {
      const n = Number(sid);
      if (!Number.isFinite(n) || n <= 0) continue;
      await conn.execute(
        'INSERT INTO user_shop_permissions (user_id, shop_id) VALUES (?, ?)',
        [userId, n],
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  countUsers,
  listUsersPaged,
  getShopPermissionsByUserId,
  listAssignableShops,
  countShopsInScope,
  replaceUserShopPermissions,
};
