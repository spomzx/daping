'use strict';

const { isPlatformScope } = require('./userScope');
const { normalizeRoleFromDb } = require('./roles');

/**
 * @typedef {'platform'|'tenant_all'|'tenant_assigned'|'none'} DataScopeMode
 * @typedef {{
 *   mode: DataScopeMode,
 *   tenantId: number|null,
 *   userId: number|null,
 *   role: string,
 *   shopIds: number[]|null,
 * }} UserDataScope
 */

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} userId
 */
async function loadAssignedShopIds(pool, userId) {
  if (!pool || !Number.isFinite(Number(userId))) return [];
  try {
    const [rows] = await pool.query(
      'SELECT shop_id FROM user_shop_permissions WHERE user_id = ?',
      [Number(userId)],
    );
    return (Array.isArray(rows) ? rows : [])
      .map((r) => Number(r.shop_id))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch (e) {
    if (e && e.code === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
}

/**
 * 统一数据范围（平台 / 租户全量 / 租户分配店铺）
 * @param {import('mysql2/promise').Pool|null} pool
 * @param {{ tenant_id?: number, user_id?: number, role?: string, scope?: string }|null} auth
 * @returns {Promise<UserDataScope>}
 */
async function getUserScope(pool, auth) {
  if (!auth || typeof auth !== 'object') {
    return { mode: 'none', tenantId: null, userId: null, role: '', shopIds: null };
  }
  const tenantId = Number.isFinite(Number(auth.tenant_id)) ? Number(auth.tenant_id) : null;
  const userId = Number.isFinite(Number(auth.user_id)) ? Number(auth.user_id) : null;
  const role = normalizeRoleFromDb(auth.role);

  if (isPlatformScope(auth)) {
    return { mode: 'platform', tenantId, userId, role, shopIds: null };
  }

  if (role === 'admin') {
    return { mode: 'tenant_all', tenantId, userId, role, shopIds: null };
  }

  const shopIds = pool && userId ? await loadAssignedShopIds(pool, userId) : [];
  return { mode: 'tenant_assigned', tenantId, userId, role, shopIds };
}

/**
 * @param {string} alias shops 表别名
 * @param {UserDataScope} scope
 * @param {{ includeDeleted?: boolean }} [opts]
 */
function buildShopScopeWhere(alias, scope, opts = {}) {
  const a = alias || 's';
  const parts = [];
  const params = [];

  if (!opts.includeDeleted) {
    parts.push(`${a}.status <> 'deleted'`);
  }

  if (!scope || scope.mode === 'none') {
    return { sql: ' AND 1=0', params: [], empty: true };
  }

  if (scope.mode === 'platform') {
    return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params, empty: false };
  }

  if (scope.tenantId == null) {
    return { sql: ' AND 1=0', params: [], empty: true };
  }

  parts.push(`${a}.tenant_id = ?`);
  params.push(scope.tenantId);

  if (scope.mode === 'tenant_assigned') {
    const ids = Array.isArray(scope.shopIds) ? scope.shopIds : [];
    if (!ids.length) {
      return { sql: ' AND 1=0', params: [], empty: true };
    }
    parts.push(`${a}.id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  return { sql: ` AND ${parts.join(' AND ')}`, params, empty: false };
}

/**
 * 订单范围（与 buildAnalyticsFilter 叠加：仅 tenant_assigned 追加 shop_id IN）
 * @param {string} alias orders 表别名
 * @param {UserDataScope} scope
 */
function buildOrderScopeWhere(alias, scope) {
  const a = alias || 'o';

  if (!scope || scope.mode === 'none') {
    return { sql: ' AND 1=0', params: [], empty: true };
  }

  if (scope.mode === 'platform' || scope.mode === 'tenant_all') {
    return { sql: '', params: [], empty: false };
  }

  if (scope.mode === 'tenant_assigned') {
    const ids = Array.isArray(scope.shopIds) ? scope.shopIds : [];
    if (!ids.length) {
      return { sql: ' AND 1=0', params: [], empty: true };
    }
    return {
      sql: ` AND ${a}.shop_id IN (${ids.map(() => '?').join(',')})`,
      params: [...ids],
      empty: false,
    };
  }

  return { sql: '', params: [], empty: false };
}

/**
 * @param {string} alias sync_shop_logs 表别名
 * @param {UserDataScope} scope
 */
function buildSyncScopeWhere(alias, scope) {
  const a = alias || 'l';
  const parts = [];
  const params = [];

  if (!scope || scope.mode === 'none') {
    return { sql: ' AND 1=0', params: [], empty: true };
  }

  if (scope.mode === 'platform') {
    return { sql: '', params: [], empty: false };
  }

  if (scope.tenantId == null) {
    return { sql: ' AND 1=0', params: [], empty: true };
  }

  parts.push(`${a}.tenant_id = ?`);
  params.push(scope.tenantId);

  if (scope.mode === 'tenant_assigned') {
    const ids = Array.isArray(scope.shopIds) ? scope.shopIds : [];
    if (!ids.length) {
      return { sql: ' AND 1=0', params: [], empty: true };
    }
    parts.push(`${a}.shop_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  return { sql: ` AND ${parts.join(' AND ')}`, params, empty: false };
}

function canManageShops(scope) {
  if (!scope) return false;
  return scope.mode === 'platform' || scope.mode === 'tenant_all';
}

function canManualSync(scope) {
  return canManageShops(scope);
}

module.exports = {
  getUserScope,
  loadAssignedShopIds,
  buildShopScopeWhere,
  buildOrderScopeWhere,
  buildSyncScopeWhere,
  canManageShops,
  canManualSync,
};
