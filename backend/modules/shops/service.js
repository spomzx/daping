'use strict';

const { getTenantById } = require('../tenants/service');
const { assertShopLimit, assertTenantActive, PlanGuardError } = require('../tenants/planService');
const { buildShopScopeWhere } = require('../../lib/dataScope');
const {
  listShopSyncStatusByShopIds,
  mergeStatusIntoShopRow,
} = require('../../sync/services/shopSyncStatusService');

function coerceTiny(v) {
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  return undefined;
}

async function countShopsForTenant(pool, tenantId) {
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS c FROM shops WHERE tenant_id = ? AND status <> 'deleted'",
    [tenantId],
  );
  const n = rows && rows[0] && rows[0].c != null ? Number(rows[0].c) : 0;
  return Number.isFinite(n) ? n : 0;
}

async function listShops(pool, tenantId) {
  const [rows] = await pool.query(
    `SELECT id, tenant_id, platform, platform_shop_id, shop_name, display_name, market, region, currency,
            sort_order, hidden, sync_enabled, remarks, imported_from_cache, last_cache_sync_at,
            status, auth_status, last_sync_at,
            last_order_seen_at, last_order_count, last_gmv_amount,
            last_health_status, last_health_message, last_health_checked_at,
            created_at, updated_at
     FROM shops WHERE tenant_id = ? AND status <> 'deleted'
     ORDER BY sort_order ASC, id ASC`,
    [tenantId],
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * 分页列表（统一 dataScope）
 * @param {import('mysql2/promise').Pool} pool
 * @param {import('../../lib/dataScope').UserDataScope} scope
 * @param {Record<string, unknown>} query
 */
async function listShopsPaged(pool, scope, query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.page_size || query.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const shopScope = buildShopScopeWhere('s', scope);
  if (shopScope.empty) {
    return { list: [], total: 0, page, page_size: pageSize };
  }

  const params = [...shopScope.params];
  let whereSql = `1=1${shopScope.sql}`;

  const keyword = String(query.keyword || query.q || '').trim();
  if (keyword) {
    whereSql += ' AND (s.shop_name LIKE ? OR s.display_name LIKE ? OR s.platform_shop_id LIKE ?)';
    const like = `%${keyword}%`;
    params.push(like, like, like);
  }
  const platform = String(query.platform || '').trim();
  if (platform) {
    whereSql += ' AND s.platform = ?';
    params.push(platform.slice(0, 32));
  }
  const region = String(query.region || query.market || '').trim().toUpperCase();
  if (region && region !== 'ALL') {
    whereSql += ' AND UPPER(COALESCE(s.market, s.region, "")) = ?';
    params.push(region);
  }
  const status = String(query.status || '').trim().toLowerCase();
  if (status && ['active', 'disabled', 'deleted'].includes(status)) {
    whereSql += ' AND s.status = ?';
    params.push(status);
  }

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS c FROM shops s WHERE ${whereSql}`,
    params,
  );
  const total = Number(countRows?.[0]?.c) || 0;

  const [rows] = await pool.query(
    `SELECT s.id, s.tenant_id, s.platform, s.platform_shop_id, s.shop_name, s.display_name, s.market, s.region, s.currency,
            s.sort_order, s.hidden, s.sync_enabled, s.remarks, s.imported_from_cache, s.last_cache_sync_at,
            s.status, s.auth_status, s.last_sync_at,
            s.last_order_seen_at, s.last_order_count, s.last_gmv_amount,
            s.last_health_status, s.last_health_message, s.last_health_checked_at,
            s.created_at, s.updated_at,
            t.tenant_name, t.tenant_code
     FROM shops s
     LEFT JOIN tenants t ON t.id = s.tenant_id
     WHERE ${whereSql}
     ORDER BY s.tenant_id ASC, s.sort_order ASC, s.id ASC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return {
    list: Array.isArray(rows) ? rows : [],
    total,
    page,
    page_size: pageSize,
  };
}

/**
 * 合并 shop_sync_status（tenant + shop_id 隔离）
 * @param {import('mysql2/promise').Pool} pool
 * @param {Record<string, unknown>[]} list
 */
async function enrichShopsWithSyncStatus(pool, list) {
  if (!Array.isArray(list) || !list.length) return list;
  const byTenant = new Map();
  for (const row of list) {
    const tid = Number(row.tenant_id);
    const sid = Number(row.id);
    if (!Number.isFinite(tid) || !Number.isFinite(sid)) continue;
    if (!byTenant.has(tid)) byTenant.set(tid, []);
    byTenant.get(tid).push(sid);
  }
  const statusByTenant = new Map();
  for (const [tid, ids] of byTenant) {
    statusByTenant.set(tid, await listShopSyncStatusByShopIds(pool, tid, ids));
  }
  return list.map((row) => {
    const tid = Number(row.tenant_id);
    const sid = Number(row.id);
    const statusMap = statusByTenant.get(tid);
    return mergeStatusIntoShopRow(row, statusMap?.get(sid));
  });
}

async function listAllShops(pool) {
  const [rows] = await pool.query(
    `SELECT s.id, s.tenant_id, s.platform, s.platform_shop_id, s.shop_name, s.display_name, s.market, s.region, s.currency,
            s.sort_order, s.hidden, s.sync_enabled, s.remarks, s.imported_from_cache, s.last_cache_sync_at,
            s.status, s.auth_status, s.last_sync_at,
            s.last_order_seen_at, s.last_order_count, s.last_gmv_amount,
            s.last_health_status, s.last_health_message, s.last_health_checked_at,
            s.created_at, s.updated_at,
            t.tenant_name, t.tenant_code
     FROM shops s
     LEFT JOIN tenants t ON t.id = s.tenant_id
     WHERE s.status <> 'deleted'
     ORDER BY s.tenant_id ASC, s.sort_order ASC, s.id ASC`,
  );
  return Array.isArray(rows) ? rows : [];
}

async function getShopByIdGlobal(pool, id) {
  const [rows] = await pool.query('SELECT * FROM shops WHERE id = ? LIMIT 1', [id]);
  const list = Array.isArray(rows) ? rows : [];
  return list[0] || null;
}

async function getShopById(pool, tenantId, id) {
  const [rows] = await pool.query('SELECT * FROM shops WHERE id = ? AND tenant_id = ? LIMIT 1', [id, tenantId]);
  const list = Array.isArray(rows) ? rows : [];
  return list[0] || null;
}

async function createShop(pool, tenantId, body) {
  const platform = String(body.platform || 'tiktok').slice(0, 32) || 'tiktok';
  const platform_shop_id = String(body.platform_shop_id || body.platformShopId || '').trim().slice(0, 128);
  const shop_name = String(body.shop_name || body.shopName || '').trim().slice(0, 255);
  if (!platform_shop_id || !shop_name) {
    const err = new Error('validation_error');
    err.code = 'validation_error';
    throw err;
  }
  const tenant = await getTenantById(pool, tenantId);
  if (!tenant) {
    const err = new Error('tenant_not_found');
    err.code = 'tenant_not_found';
    throw err;
  }
  try {
    await assertShopLimit(pool, tenantId);
  } catch (e) {
    if (e instanceof PlanGuardError) throw e;
    throw e;
  }
  const market = body.market != null ? String(body.market).slice(0, 32) : null;
  const region = body.region != null ? String(body.region).slice(0, 32) : null;
  const currency = body.currency != null ? String(body.currency).slice(0, 8) : null;
  const auth_status = body.auth_status != null ? String(body.auth_status).slice(0, 64) : null;
  const display_name =
    body.display_name != null || body.displayName != null
      ? String(body.display_name ?? body.displayName ?? '')
          .trim()
          .slice(0, 255) || null
      : null;
  const remarks = body.remarks != null ? String(body.remarks).slice(0, 16000) : null;
  const sort_order = body.sort_order != null ? Number(body.sort_order) : 0;

  const [result] = await pool.execute(
    `INSERT INTO shops (
       tenant_id, platform, platform_shop_id, shop_name, display_name, market, region, currency,
       status, auth_status, sort_order, hidden, sync_enabled, imported_from_cache
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, 1, 0)`,
    [
      tenantId,
      platform,
      platform_shop_id,
      shop_name,
      display_name,
      market,
      region,
      currency,
      auth_status,
      Number.isFinite(sort_order) ? sort_order : 0,
    ],
  );
  const insertId = Number(result.insertId);
  return getShopById(pool, tenantId, insertId);
}

async function updateShop(pool, tenantId, id, body) {
  const existing = await getShopById(pool, tenantId, id);
  if (!existing) return null;
  if (String(existing.status) === 'deleted') return null;
  const b = body || {};
  const hasHidden = Object.prototype.hasOwnProperty.call(b, 'hidden');
  const hasSync =
    Object.prototype.hasOwnProperty.call(b, 'sync_enabled') || Object.prototype.hasOwnProperty.call(b, 'syncEnabled');
  if (hasSync) {
    await assertTenantActive(pool, tenantId);
  }
  if (hasHidden && hasSync) {
    const err = new Error('cannot_patch_hidden_and_sync_together');
    err.code = 'validation_error';
    throw err;
  }
  const fields = [];
  const vals = [];
  if (body.shop_name !== undefined || body.shopName !== undefined) {
    fields.push('shop_name = ?');
    vals.push(String(body.shop_name ?? body.shopName ?? '').trim().slice(0, 255));
  }
  if (body.display_name !== undefined || body.displayName !== undefined) {
    fields.push('display_name = ?');
    const v = body.display_name ?? body.displayName;
    vals.push(v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 255));
  }
  if (body.market !== undefined) {
    fields.push('market = ?');
    vals.push(body.market == null ? null : String(body.market).slice(0, 32));
  }
  if (body.region !== undefined) {
    fields.push('region = ?');
    vals.push(body.region == null ? null : String(body.region).slice(0, 32));
  }
  if (body.currency !== undefined) {
    fields.push('currency = ?');
    vals.push(body.currency == null ? null : String(body.currency).slice(0, 8));
  }
  if (body.auth_status !== undefined || body.authStatus !== undefined) {
    fields.push('auth_status = ?');
    const v = body.auth_status ?? body.authStatus;
    vals.push(v == null ? null : String(v).slice(0, 64));
  }
  if (body.platform_shop_id !== undefined || body.platformShopId !== undefined) {
    fields.push('platform_shop_id = ?');
    vals.push(String(body.platform_shop_id ?? body.platformShopId ?? '').trim().slice(0, 128));
  }
  if (body.platform !== undefined) {
    fields.push('platform = ?');
    vals.push(String(body.platform || 'tiktok').slice(0, 32));
  }
  if (body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    fields.push('sort_order = ?');
    vals.push(Number.isFinite(n) ? n : 0);
  }
  if (body.hidden !== undefined) {
    const h = coerceTiny(body.hidden);
    if (h !== undefined) {
      fields.push('hidden = ?');
      vals.push(h);
    }
  }
  if (body.sync_enabled !== undefined || body.syncEnabled !== undefined) {
    const s = coerceTiny(body.sync_enabled ?? body.syncEnabled);
    if (s !== undefined) {
      fields.push('sync_enabled = ?');
      vals.push(s);
    }
  }
  if (body.remarks !== undefined) {
    fields.push('remarks = ?');
    vals.push(body.remarks == null ? null : String(body.remarks).slice(0, 16000));
  }
  if (!fields.length) return existing;
  vals.push(id, tenantId);
  await pool.execute(`UPDATE shops SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`, vals);
  return getShopById(pool, tenantId, id);
}

async function updateShopStatus(pool, tenantId, id, status) {
  const s = String(status || '').trim().toLowerCase();
  if (!['active', 'disabled'].includes(s)) {
    const err = new Error('invalid_status');
    err.code = 'invalid_status';
    throw err;
  }
  const existing = await getShopById(pool, tenantId, id);
  if (!existing || String(existing.status) === 'deleted') return null;
  await pool.execute('UPDATE shops SET status = ? WHERE id = ? AND tenant_id = ?', [s, id, tenantId]);
  return getShopById(pool, tenantId, id);
}

async function softDeleteShop(pool, tenantId, id) {
  const existing = await getShopById(pool, tenantId, id);
  if (!existing || String(existing.status) === 'deleted') return null;
  await pool.execute("UPDATE shops SET status = 'deleted' WHERE id = ? AND tenant_id = ?", [id, tenantId]);
  return getShopById(pool, tenantId, id);
}

module.exports = {
  listShops,
  listShopsPaged,
  enrichShopsWithSyncStatus,
  listAllShops,
  getShopById,
  getShopByIdGlobal,
  createShop,
  updateShop,
  updateShopStatus,
  softDeleteShop,
  countShopsForTenant,
};
