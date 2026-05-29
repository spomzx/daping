'use strict';

const {
  countUsersForTenant: countTenantMembers,
  COUNT_MODE_PLATFORM_LIST,
  COUNT_MODE_QUOTA,
} = require('../../lib/tenantUserMembership');
const {
  PLAN_PRESETS,
  normalizePlanType,
  getPlanPreset,
  planTypeHasPreset,
} = require('../../lib/tenantPlanTypes');
const { buildSystemTenantFilter } = require('../../lib/systemTenant');

const MSG_SHOP_LIMIT = '已达到套餐店铺上限';
const MSG_USER_LIMIT = '已达到套餐用户数量上限';
const MSG_PLAN_INACTIVE = '当前套餐已停用，请联系平台管理员';
const MSG_PLAN_EXPIRED = '套餐已到期，仅允许查看数据';

class PlanGuardError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   * @param {number} [status]
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, status = 403, details = {}) {
    super(message || code);
    this.code = code;
    this.message = message || code;
    this.status = status;
    this.details = details;
  }
}

function resolveShopLimit(row) {
  const fromPlan = Number(row?.shop_limit);
  if (Number.isFinite(fromPlan) && fromPlan > 0) return Math.floor(fromPlan);
  const legacy = Number(row?.max_shops);
  if (Number.isFinite(legacy) && legacy > 0) return Math.floor(legacy);
  return PLAN_PRESETS.basic.shop_limit;
}

function resolveMaxUsers(row) {
  const n = Number(row?.max_users);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return PLAN_PRESETS.basic.max_users;
}

function computePlanStatus(row) {
  if (!row) return 'disabled';
  const ts = String(row.status || '').toLowerCase();
  if (ts === 'disabled' || ts === 'deleted' || ts === 'orphaned') return 'disabled';
  if (isPlanExpired(row)) return 'expired';
  const is_active = !(row.is_active === 0 || row.is_active === false);
  if (!is_active) return 'disabled';
  if (row.expires_at) {
    const d = new Date(row.expires_at);
    if (!Number.isNaN(d.getTime())) {
      const ms = d.getTime() - Date.now();
      if (ms >= 0 && ms <= 7 * 24 * 60 * 60 * 1000) return 'expiring';
    }
  }
  return 'normal';
}

function mapPlanRow(row, counts = {}) {
  if (!row) return null;
  const plan_type = normalizePlanType(row.plan_type);
  const shop_limit = resolveShopLimit(row);
  const max_users = resolveMaxUsers(row);
  const is_active = !(row.is_active === 0 || row.is_active === false);
  const plan_status = computePlanStatus(row);
  return {
    id: Number(row.id),
    tenant_code: row.tenant_code,
    tenant_name: row.tenant_name,
    status: row.status,
    plan_type,
    shop_limit,
    max_users,
    max_shops: shop_limit,
    expires_at: row.expires_at ?? null,
    is_active: is_active ? 1 : 0,
    plan_remark: row.plan_remark ?? null,
    plan_status,
    shop_count: Number(counts.current_shops) || 0,
    active_shop_count: Number(counts.active_shop_count) || 0,
    current_shops: Number(counts.current_shops) || 0,
    current_users: Number(counts.current_users) || 0,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    deleted_at: row.deleted_at ?? null,
    updated_by: row.updated_by != null ? Number(row.updated_by) : null,
    primary_admin_username: row.primary_admin_username ?? null,
  };
}

/**
 * 租户主管理员登录名（展示用，优先客户 admin，其次 super_admin）
 * @param {import('mysql2/promise').Pool} pool
 * @param {Array<{ id: number }>} tenantRows
 */
async function attachPrimaryAdminUsernames(pool, tenantRows) {
  if (!Array.isArray(tenantRows) || tenantRows.length === 0) return tenantRows;
  const ids = tenantRows.map((r) => Number(r.id)).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return tenantRows;

  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT ut.tenant_id, u.username
     FROM user_tenants ut
     INNER JOIN users u ON u.id = ut.user_id
     WHERE ut.tenant_id IN (${placeholders})
       AND ut.status NOT IN ('disabled','deleted')
       AND u.status NOT IN ('disabled','deleted')
     ORDER BY ut.tenant_id,
       CASE
         WHEN ut.role IN ('admin','tenant_owner','tenant_admin') THEN 0
         WHEN ut.role IN ('super_admin','platform_admin') THEN 1
         ELSE 2
       END,
       u.id ASC`,
    ids,
  );

  const byTenant = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const tid = Number(r.tenant_id);
    if (!byTenant.has(tid)) byTenant.set(tid, r.username);
  }

  return tenantRows.map((row) => ({
    ...row,
    primary_admin_username: byTenant.get(Number(row.id)) ?? null,
  }));
}

function isPlanExpired(row) {
  if (!row?.expires_at) return false;
  const d = new Date(row.expires_at);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}

function isTenantPlanWritable(row) {
  if (!row) return false;
  if (row.is_active === 0 || row.is_active === false) return false;
  if (isPlanExpired(row)) return false;
  const ts = String(row.status || '').toLowerCase();
  if (ts === 'disabled' || ts === 'deleted' || ts === 'orphaned') return false;
  return true;
}

const TENANT_PLAN_SELECT = `id, tenant_code, tenant_name, status, plan_type, shop_limit, max_users, max_shops,
  expires_at, is_active, plan_remark, current_users, updated_by, base_currency, timezone, created_at, updated_at, deleted_at`;

async function countShopsForTenant(pool, tenantId) {
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS c FROM shops WHERE tenant_id = ? AND status <> 'deleted'",
    [tenantId],
  );
  return Number(rows?.[0]?.c) || 0;
}

async function countActiveShopsForTenant(pool, tenantId) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c FROM shops
     WHERE tenant_id = ? AND status = 'active' AND hidden = 0 AND sync_enabled = 1`,
    [tenantId],
  );
  return Number(rows?.[0]?.c) || 0;
}

/** @deprecated 请使用 lib/tenantUserMembership.countUsersForTenant */
async function countUsersForTenant(pool, tenantId, mode = COUNT_MODE_QUOTA) {
  return countTenantMembers(pool, tenantId, mode);
}

/**
 * 过期自动禁用；返回是否已过期
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {Record<string, unknown>} row
 */
async function syncTenantExpiry(pool, tenantId, row) {
  if (!row || !isPlanExpired(row)) return false;
  if (row.is_active !== 0 && row.is_active !== false) {
    await pool.execute(`UPDATE tenants SET is_active = 0, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [
      tenantId,
    ]);
    row.is_active = 0;
  }
  return true;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 */
async function syncCurrentUsersCache(pool, tenantId) {
  const n = await countTenantMembers(pool, tenantId, COUNT_MODE_QUOTA);
  await pool.execute(`UPDATE tenants SET current_users = ? WHERE id = ?`, [n, tenantId]);
  return n;
}

/** /api/tenants 展示：与平台 /users 列表同口径实时统计 */
async function countUsersForTenantDisplay(pool, tenantId) {
  return countTenantMembers(pool, tenantId, COUNT_MODE_PLATFORM_LIST);
}

async function fetchTenantRow(pool, tenantId) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) return null;
  const [rows] = await pool.query(`SELECT ${TENANT_PLAN_SELECT} FROM tenants WHERE id = ? LIMIT 1`, [tid]);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 */
async function getTenantPlan(pool, tenantId) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) return null;
  const row = await fetchTenantRow(pool, tid);
  if (!row) return null;
  if (String(row.status || '').toLowerCase() === 'deleted') return null;
  await syncTenantExpiry(pool, tid, row);
  const [current_shops, active_shop_count, current_users] = await Promise.all([
    countShopsForTenant(pool, tid),
    countActiveShopsForTenant(pool, tid),
    countTenantMembers(pool, tid, COUNT_MODE_QUOTA),
  ]);
  await syncCurrentUsersCache(pool, tid);
  return mapPlanRow(row, { current_shops, active_shop_count, current_users });
}

async function assertTenantActive(pool, tenantId) {
  const tid = Number(tenantId);
  const row = await fetchTenantRow(pool, tid);
  if (!row) {
    throw new PlanGuardError('tenant_not_found', '租户不存在', 404);
  }
  await syncTenantExpiry(pool, tid, row);
  if (isPlanExpired(row)) {
    throw new PlanGuardError('plan_expired', MSG_PLAN_EXPIRED, 403, { tenant_id: tid });
  }
  if (row.is_active === 0 || row.is_active === false) {
    throw new PlanGuardError('plan_inactive', MSG_PLAN_INACTIVE, 403, { tenant_id: tid });
  }
  const ts = String(row.status || '').toLowerCase();
  if (ts === 'disabled' || ts === 'deleted' || ts === 'orphaned') {
    throw new PlanGuardError('plan_inactive', MSG_PLAN_INACTIVE, 403, { tenant_id: tid });
  }
  return getTenantPlan(pool, tid);
}

async function assertShopLimit(pool, tenantId, opts = {}) {
  const { skipActiveCheck = false, unlimited = false } = opts;
  const plan = skipActiveCheck ? await getTenantPlan(pool, tenantId) : await assertTenantActive(pool, tenantId);
  if (!plan) {
    throw new PlanGuardError('tenant_not_found', '租户不存在', 404);
  }
  if (unlimited) return plan;
  if (plan.current_shops >= plan.shop_limit) {
    throw new PlanGuardError('shop_limit_reached', MSG_SHOP_LIMIT, 403, {
      shop_limit: plan.shop_limit,
      current_shops: plan.current_shops,
    });
  }
  return plan;
}

async function assertUserLimit(pool, tenantId) {
  const plan = await assertTenantActive(pool, tenantId);
  const quotaUsers = await countTenantMembers(pool, tenantId, COUNT_MODE_QUOTA);
  if (quotaUsers >= plan.max_users) {
    throw new PlanGuardError('user_limit_reached', MSG_USER_LIMIT, 403, {
      max_users: plan.max_users,
      current_users: quotaUsers,
    });
  }
  return { ...plan, current_users: quotaUsers };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 */
async function listTenantPlans(pool) {
  const result = await listTenantsPaged(pool, { page: 1, page_size: 500 });
  return result.list;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ page: number, page_size: number, keyword?: string, plan_type?: string, is_active?: number|null, plan_status?: string }} query
 */
async function listTenantsPaged(pool, query) {
  const page = Math.max(1, Number(query.page) || 1);
  const page_size = Math.min(100, Math.max(1, Number(query.page_size) || 20));
  const offset = (page - 1) * page_size;

  const where = [];
  const params = [];

  const systemFilter = buildSystemTenantFilter(Boolean(query.include_system));
  if (systemFilter.sql) {
    where.push(systemFilter.sql);
    params.push(...systemFilter.params);
  }

  const includeDeleted =
    query.include_deleted === 1 ||
    query.include_deleted === '1' ||
    query.includeDeleted === 1 ||
    query.includeDeleted === '1';
  if (!includeDeleted) {
    where.push("status <> 'deleted'");
  }

  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    where.push('(tenant_name LIKE ? OR tenant_code LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  const planType = normalizePlanType(query.plan_type);
  if (String(query.plan_type || '').trim()) {
    const raw = String(query.plan_type).trim().toLowerCase();
    if (raw === 'basic' || raw === 'enterprise' || raw === 'custom') {
      where.push('plan_type = ?');
      params.push(planType);
    }
  }

  if (query.is_active === 0 || query.is_active === 1) {
    where.push('is_active = ?');
    params.push(query.is_active);
  }

  const planStatus = String(query.plan_status || '').trim().toLowerCase();
  if (planStatus === 'expired') {
    where.push('expires_at IS NOT NULL AND expires_at < NOW()');
  } else if (planStatus === 'expiring') {
    where.push(
      'expires_at IS NOT NULL AND expires_at >= NOW() AND expires_at <= DATE_ADD(NOW(), INTERVAL 7 DAY) AND is_active = 1',
    );
  } else if (planStatus === 'disabled') {
    where.push("(is_active = 0 OR status IN ('disabled','deleted','orphaned'))");
  } else if (planStatus === 'normal') {
    where.push(
      "is_active = 1 AND status NOT IN ('disabled','deleted','orphaned') AND (expires_at IS NULL OR expires_at > DATE_ADD(NOW(), INTERVAL 7 DAY))",
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [countRows] = await pool.query(`SELECT COUNT(*) AS c FROM tenants ${whereSql}`, params);
  const total = Number(countRows?.[0]?.c) || 0;

  const [rows] = await pool.query(
    `SELECT ${TENANT_PLAN_SELECT} FROM tenants ${whereSql} ORDER BY id ASC LIMIT ? OFFSET ?`,
    [...params, page_size, offset],
  );

  const enrichedRows = await attachPrimaryAdminUsernames(pool, Array.isArray(rows) ? rows : []);

  const list = [];
  for (const row of enrichedRows) {
    const tid = Number(row.id);
    await syncTenantExpiry(pool, tid, row);
    const [current_shops, active_shop_count, current_users] = await Promise.all([
      countShopsForTenant(pool, tid),
      countActiveShopsForTenant(pool, tid),
      countUsersForTenantDisplay(pool, tid),
    ]);
    list.push(mapPlanRow(row, { current_shops, active_shop_count, current_users }));
  }

  return { list, total, page, page_size };
}

function buildUpdatePayload(body = {}, opts = {}) {
  const fields = [];
  const vals = [];
  const b = body || {};

  if (b.plan_type !== undefined) {
    fields.push('plan_type = ?');
    vals.push(normalizePlanType(b.plan_type));
  }
  if (b.shop_limit !== undefined) {
    const n = Math.max(1, Math.floor(Number(b.shop_limit)));
    fields.push('shop_limit = ?', 'max_shops = ?');
    vals.push(n, n);
  }
  if (b.max_users !== undefined) {
    fields.push('max_users = ?');
    vals.push(Math.max(1, Math.floor(Number(b.max_users))));
  }
  if (Object.prototype.hasOwnProperty.call(b, 'expires_at')) {
    const v = b.expires_at;
    if (v == null || v === '') {
      fields.push('expires_at = NULL');
    } else {
      fields.push('expires_at = ?');
      vals.push(v);
    }
  }
  if (b.is_active !== undefined) {
    const on = b.is_active === true || b.is_active === 1 || b.is_active === '1';
    fields.push('is_active = ?');
    vals.push(on ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'plan_remark')) {
    const remark = b.plan_remark == null ? null : String(b.plan_remark).trim().slice(0, 255) || null;
    fields.push('plan_remark = ?');
    vals.push(remark);
  }

  const updatedBy = opts.updated_by;
  if (updatedBy != null && Number.isFinite(Number(updatedBy)) && Number(updatedBy) > 0) {
    fields.push('updated_by = ?');
    vals.push(Math.floor(Number(updatedBy)));
  }

  return { fields, vals };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {Record<string, unknown>} body
 */
async function updateTenantPlan(pool, tenantId, body, opts = {}) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) {
    return { ok: false, status: 400, error: 'invalid_tenant_id' };
  }

  const existing = await getTenantPlan(pool, tid);
  if (!existing) {
    return { ok: false, status: 404, error: 'tenant_not_found' };
  }

  const patch = { ...body };
  const explicitShop = patch.shop_limit !== undefined;
  const explicitUsers = patch.max_users !== undefined;
  if (patch.plan_type !== undefined && !explicitShop && !explicitUsers) {
    const pt = normalizePlanType(patch.plan_type);
    if (planTypeHasPreset(pt)) {
      const preset = getPlanPreset(pt);
      if (preset) {
        patch.shop_limit = preset.shop_limit;
        patch.max_users = preset.max_users;
      }
    }
  }

  const { fields, vals } = buildUpdatePayload(patch, opts);
  if (fields.length === 0) {
    return { ok: true, plan: existing };
  }

  await pool.execute(`UPDATE tenants SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [
    ...vals,
    tid,
  ]);

  await syncCurrentUsersCache(pool, tid);
  const plan = await getTenantPlan(pool, tid);
  return { ok: true, plan };
}

function planErrorToHttp(e) {
  if (e instanceof PlanGuardError) {
    return {
      status: e.status || 403,
      body: { error: e.code, message: e.message, ...e.details },
    };
  }
  return null;
}

module.exports = {
  PLAN_PRESETS,
  PlanGuardError,
  MSG_SHOP_LIMIT,
  MSG_USER_LIMIT,
  MSG_PLAN_INACTIVE,
  MSG_PLAN_EXPIRED,
  getTenantPlan,
  updateTenantPlan,
  listTenantPlans,
  listTenantsPaged,
  assertShopLimit,
  assertUserLimit,
  assertTenantActive,
  countShopsForTenant,
  countUsersForTenant,
  countUsersForTenantDisplay,
  syncCurrentUsersCache,
  syncTenantExpiry,
  computePlanStatus,
  resolveShopLimit,
  resolveMaxUsers,
  planErrorToHttp,
  normalizePlanType,
};
