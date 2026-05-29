'use strict';

const { getUserScope, buildShopScopeWhere } = require('../../lib/dataScope');
const { isReadOnlyRole, isAdminFamily } = require('../../lib/roles');
const { getMembershipInTenant, actorHasPlatformPrivileges } = require('./serviceHelpers');
const repo = require('./repository');

function parsePositiveIds(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))];
}

/**
 * 仅租户账户管理员可为本租户普通用户管理店铺分配（平台管理员禁止）
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} auth
 * @param {number} targetUserId
 */
async function assertTenantAdminCanAssignViewerShops(pool, auth, targetUserId) {
  if (actorHasPlatformPrivileges(auth)) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      message: '平台管理员不能分配店铺，请由账户管理员操作',
    };
  }

  const actorRole = String(auth.role || '');
  if (isReadOnlyRole(actorRole)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  if (!isAdminFamily(actorRole)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  const tenantId = Number(auth.tenant_id);
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  const [rows] = await pool.query('SELECT id FROM users WHERE id = ? LIMIT 1', [targetUserId]);
  if (!Array.isArray(rows) || !rows[0]) {
    return { ok: false, status: 404, error: 'user_not_found' };
  }

  const m = await getMembershipInTenant(pool, targetUserId, tenantId);
  if (!m) {
    return { ok: false, status: 404, error: 'user_not_found' };
  }
  if (!isReadOnlyRole(m.role)) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      message: '只能为普通用户分配店铺',
    };
  }

  return { ok: true, tenantId };
}

/**
 * 可分配店铺范围：仅本租户（账户管理员）
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} auth
 */
async function getAssignableShopScope(pool, auth) {
  if (actorHasPlatformPrivileges(auth)) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      message: '平台管理员不能分配店铺',
    };
  }

  const actorRole = String(auth.role || '');
  if (isReadOnlyRole(actorRole)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  if (!isAdminFamily(actorRole)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  const scope = await getUserScope(pool, auth);
  if (scope.mode !== 'tenant_all' || scope.tenantId == null) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  const shopScope = buildShopScopeWhere('s', scope);
  const parts = [`s.status <> 'deleted'`];
  const params = [];
  if (shopScope.sql) {
    const frag = shopScope.sql.replace(/^\s*AND\s*/i, '');
    if (frag) parts.push(`(${frag})`);
    params.push(...shopScope.params);
  }
  if (shopScope.empty) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  return { ok: true, whereSql: parts.join(' AND '), params, scope };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} auth
 */
async function listAssignableShopsForActor(pool, auth) {
  const sc = await getAssignableShopScope(pool, auth);
  if (!sc.ok) return sc;
  const shops = await repo.listAssignableShops(pool, sc.whereSql, sc.params);
  return { ok: true, shops };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} auth
 * @param {number} targetUserId
 */
async function getUserShopPermissions(pool, auth, targetUserId) {
  const uid = Number(targetUserId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, status: 400, error: 'invalid_id' };
  }
  const gate = await assertTenantAdminCanAssignViewerShops(pool, auth, uid);
  if (!gate.ok) return gate;

  const shops = await repo.getShopPermissionsByUserId(pool, uid, gate.tenantId);
  return { ok: true, user_id: uid, shops };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} auth
 * @param {number} targetUserId
 * @param {number[]} shopIds
 */
async function setUserShopPermissions(pool, auth, targetUserId, shopIds) {
  const uid = Number(targetUserId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, status: 400, error: 'invalid_id' };
  }
  const gate = await assertTenantAdminCanAssignViewerShops(pool, auth, uid);
  if (!gate.ok) return gate;

  const ids = parsePositiveIds(shopIds);
  const sc = await getAssignableShopScope(pool, auth);
  if (!sc.ok) return sc;

  if (ids.length > 0) {
    const matched = await repo.countShopsInScope(pool, ids, sc.whereSql, sc.params);
    if (matched !== ids.length) {
      return { ok: false, status: 400, error: 'invalid_shop_ids', message: '部分店铺不在本租户可分配范围内' };
    }
  }

  await repo.replaceUserShopPermissions(pool, uid, ids);
  const shops = await repo.getShopPermissionsByUserId(pool, uid, gate.tenantId);
  return { ok: true, user_id: uid, shops };
}

module.exports = {
  listAssignableShopsForActor,
  getUserShopPermissions,
  setUserShopPermissions,
  assertTenantAdminCanAssignViewerShops,
};
