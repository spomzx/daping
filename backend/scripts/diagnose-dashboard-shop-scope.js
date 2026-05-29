#!/usr/bin/env node
'use strict';

/**
 * 大屏店铺可见范围诊断（对比店铺管理 dataScope）
 *
 *   node backend/scripts/diagnose-dashboard-shop-scope.js --user-id=12 --tenant-id=6
 *   node backend/scripts/diagnose-dashboard-shop-scope.js --username=cqchic --tenant-id=6
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const { getUserScope, buildShopScopeWhere } = require('../lib/dataScope');
const { enforceAuthTenantScope } = require('../lib/resolveTenantShop');
const { listDashboardEligibleShops } = require('../lib/dashboardEligibleShops');
const { isPlatformScope, normalizeUserScope } = require('../lib/userScope');
const { normalizeRoleFromDb } = require('../lib/roles');
const {
  findLoginDiagnosticByUsername,
  findLoginContextByUsername,
  getMeProfile,
} = require('../modules/users/service');

function parseArgs(argv) {
  let userId = null;
  let username = null;
  let tenantId = null;
  for (const a of argv) {
    if (a.startsWith('--user-id=')) userId = Number(a.split('=')[1]);
    else if (a.startsWith('--username=')) username = String(a.split('=')[1]).trim();
    else if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
  }
  return { userId, username, tenantId };
}

async function loadAssignedShopCount(pool, userId) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS c FROM user_shop_permissions WHERE user_id = ?',
    [userId],
  );
  return Number(rows?.[0]?.c) || 0;
}

/** 与登录/JWT 一致：users + user_tenants，角色来自 ut.role */
async function loadUserContext(pool, { userId, username, tenantId }) {
  let uid = Number.isFinite(userId) && userId > 0 ? userId : null;
  if (!uid && username) {
    const diag = await findLoginDiagnosticByUsername(pool, username);
    if (!diag?.user_id) return null;
    uid = Number(diag.user_id);
  }
  if (!uid) return null;

  let tid = Number.isFinite(tenantId) && tenantId > 0 ? tenantId : null;
  if (!tid) {
    if (username) {
      const ctx = await findLoginContextByUsername(pool, username);
      if (ctx?.tenant_id) tid = Number(ctx.tenant_id);
    }
    if (!tid) {
      const [mrows] = await pool.query(
        `SELECT tenant_id FROM user_tenants
         WHERE user_id = ? AND status NOT IN ('disabled','deleted')
         ORDER BY id ASC LIMIT 1`,
        [uid],
      );
      if (mrows?.[0]?.tenant_id) tid = Number(mrows[0].tenant_id);
    }
  }

  const assigned_shop_count = await loadAssignedShopCount(pool, uid);

  if (!tid) {
    const [urows] = await pool.query(
      'SELECT id, username, scope AS user_scope FROM users WHERE id = ? LIMIT 1',
      [uid],
    );
    const u = urows?.[0];
    if (!u) return null;
    return {
      id: u.id,
      username: u.username,
      user_scope: u.user_scope,
      tenant_id: null,
      role: null,
      membership_status: null,
      assigned_shop_count,
    };
  }

  const row = await getMeProfile(pool, uid, tid);
  if (!row) return null;
  return { ...row, assigned_shop_count };
}

async function resolveRoleName(pool, rawRole, canonicalRole) {
  const codes = [...new Set([String(rawRole || '').trim(), canonicalRole].filter(Boolean))];
  if (!codes.length) return null;
  try {
    const [rows] = await pool.query(
      `SELECT role_code, role_name FROM roles WHERE role_code IN (${codes.map(() => '?').join(',')})`,
      codes,
    );
    const list = Array.isArray(rows) ? rows : [];
    for (const code of codes) {
      const hit = list.find((r) => r.role_code === code);
      if (hit?.role_name) return hit.role_name;
    }
    return null;
  } catch (e) {
    if (e && e.code === 'ER_NO_SUCH_TABLE') return null;
    throw e;
  }
}

async function main() {
  const { userId, username, tenantId: tidArg } = parseArgs(process.argv.slice(2));
  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-dashboard-scope] 无 MySQL');
    process.exit(2);
  }

  const ctx = await loadUserContext(pool, { userId, username, tenantId: tidArg });
  if (!ctx) {
    console.error('[diagnose-dashboard-scope] 未找到用户或指定租户下无成员关系');
    process.exit(1);
  }

  const tenantId =
    Number.isFinite(tidArg) && tidArg > 0
      ? tidArg
      : ctx.tenant_id != null
        ? Number(ctx.tenant_id)
        : null;

  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    console.error('[diagnose-dashboard-scope] 需要有效 tenant_id（--tenant-id 或用户成员关系）');
    process.exit(1);
  }

  const rawRole = ctx.role;
  const role = normalizeRoleFromDb(rawRole);
  const role_name = await resolveRoleName(pool, rawRole, role);

  const auth = {
    user_id: ctx.id,
    username: ctx.username,
    role,
    scope: normalizeUserScope(ctx.user_scope),
    tenant_id: tenantId,
  };

  const scope = enforceAuthTenantScope(await getUserScope(pool, auth), auth, tenantId);
  const shopScope = buildShopScopeWhere('s', scope);
  const { shops: eligible } = await listDashboardEligibleShops(pool, tenantId, scope, { market: 'ALL' });

  const [allTenantRows] = await pool.query(
    `SELECT id, platform_shop_id, shop_name, display_name, market, region, status, hidden
     FROM shops WHERE tenant_id = ? AND status <> 'deleted' ORDER BY id`,
    [tenantId],
  );
  const all = Array.isArray(allTenantRows) ? allTenantRows : [];
  const eligibleIds = new Set(eligible.map((r) => Number(r.shop_id)));

  const excluded = [];
  for (const s of all) {
    const sid = Number(s.id);
    if (eligibleIds.has(sid)) continue;
    const st = String(s.status || '').toLowerCase();
    let excluded_reason = 'not_in_data_scope';
    if (st !== 'active') excluded_reason = `status=${st}`;
    else if (s.hidden === 1 || s.hidden === true) excluded_reason = 'hidden';
    else if (scope.mode === 'tenant_assigned') excluded_reason = 'not_assigned_to_user';
    else excluded_reason = 'filtered';
    excluded.push({
      shop_id: sid,
      platform_shop_id: s.platform_shop_id,
      shop_name: s.display_name || s.shop_name,
      market: s.market || s.region,
      excluded_reason,
    });
  }

  const [assigned] = await pool.query(
    `SELECT usp.shop_id, s.shop_name, s.display_name, s.platform_shop_id
     FROM user_shop_permissions usp
     INNER JOIN shops s ON s.id = usp.shop_id
     WHERE usp.user_id = ?`,
    [ctx.id],
  );

  const report = {
    user_id: ctx.id,
    username: ctx.username,
    role,
    role_code: rawRole != null ? String(rawRole) : null,
    role_name,
    scope: auth.scope,
    membership_status: ctx.membership_status ?? null,
    data_scope_mode: scope.mode,
    tenant_id: tenantId,
    shop_scope_sql_fragment: shopScope.sql,
    is_platform: isPlatformScope(auth),
    assigned_shop_count_db: Number(ctx.assigned_shop_count) || 0,
    assigned_shop_ids: (assigned || []).map((r) => Number(r.shop_id)),
    visible_eligible_count: eligible.length,
    tenant_total_not_deleted: all.length,
    excluded_count: excluded.length,
    visible_shops: eligible.map((r) => ({
      shop_id: r.shop_id,
      platform_shop_id: r.platform_shop_id,
      shop_name: r.shop_name,
      market: r.market,
    })),
    excluded_shops: excluded,
    notes: [
      '角色来自 user_tenants.role（与登录 JWT 一致），非 users.role',
      '大屏排行现已合并全部 eligible 店铺（无单显示 0），不再仅显示有订单的店',
      'admin/tenant_all：本租户全部 active 且未隐藏',
      'viewer/tenant_assigned：仅 user_shop_permissions 分配的店',
    ],
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error('[diagnose-dashboard-scope] fatal', e);
  process.exit(1);
});
