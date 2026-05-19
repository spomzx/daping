'use strict';

/**
 * @deprecated legacy / ops only — 从 orders-cache / gmv-cache 导入 MySQL。
 * SaaS `/api/shops/*` 禁止调用；须 `req.allowLegacyCacheRead`（/api/ops/*）。
 */

const path = require('path');
const { resolveTenantMaxShops } = require('../../lib/tenantShopLimit');
const { readJsonWithRecovery } = require('../../lib/storageFile');
const { assertLegacyStorageReadAllowed } = require('../../lib/saasMysqlOnly');

function readJsonSafe(filePath, req) {
  assertLegacyStorageReadAllowed(req, filePath, 'importCacheShops.readJsonSafe');
  if (!filePath) return null;
  const r = readJsonWithRecovery(filePath, { restore: true });
  return r.data;
}

function normalizePlatform(p) {
  const s = String(p || 'tiktok').trim().toLowerCase();
  if (!s || s === 'tiktok shop' || s.includes('tiktok')) return 'tiktok';
  return s.slice(0, 32) || 'tiktok';
}

/**
 * 从 orders-cache.json 订单列表提取店铺
 * @returns {Array<{ platform_shop_id: string, shop_name: string, market: string | null, platform: string }>}
 */
function extractFromOrdersCache(pack) {
  const orders = pack && Array.isArray(pack.orders) ? pack.orders : [];
  const map = new Map();
  for (const o of orders) {
    if (!o || typeof o !== 'object') continue;
    const sid = String(o.shopId ?? o.shop_id ?? '').trim();
    if (!sid) continue;
    const key = sid.toLowerCase();
    const shopName = String(o.shopName ?? o.shop_name ?? sid).trim().slice(0, 255) || sid;
    const region = String(o.region ?? o.market ?? '').trim().toUpperCase();
    const market = region ? region.slice(0, 32) : null;
    const platform = normalizePlatform(o.platform);
    if (!map.has(key)) {
      map.set(key, { platform_shop_id: sid, shop_name: shopName, market, platform });
    }
  }
  return [...map.values()];
}

/**
 * 从 gmv-cache.json 提取店铺（结构兼容多种形态）
 * @returns {Array<{ platform_shop_id: string, shop_name: string, market: string | null, platform: string }>}
 */
function extractFromGmvCache(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const out = [];
  const candidates = [obj.shops, obj.shopList, obj.summary?.shops, obj.data?.shops];
  for (const shops of candidates) {
    if (!Array.isArray(shops)) continue;
    for (const s of shops) {
      if (!s || typeof s !== 'object') continue;
      const sid = String(s.shopId ?? s.id ?? s.shop_id ?? '').trim();
      if (!sid) continue;
      const shopName = String(s.shopName ?? s.name ?? s.shop_name ?? sid).trim().slice(0, 255) || sid;
      const region = String(s.region ?? s.market ?? '').trim().toUpperCase();
      const market = region ? region.slice(0, 32) : null;
      const platform = normalizePlatform(s.platform);
      out.push({ platform_shop_id: sid, shop_name: shopName, market, platform });
    }
  }
  return out;
}

function mergeByShopId(items) {
  const m = new Map();
  for (const it of items) {
    const k = String(it.platform_shop_id).trim().toLowerCase();
    if (!k) continue;
    if (!m.has(k)) {
      m.set(k, { ...it, platform_shop_id: String(it.platform_shop_id).trim() });
    } else {
      const ex = m.get(k);
      if ((!ex.shop_name || ex.shop_name === ex.platform_shop_id) && it.shop_name) ex.shop_name = it.shop_name;
      if (!ex.market && it.market) ex.market = it.market;
      if (it.platform) ex.platform = it.platform;
    }
  }
  return [...m.values()];
}

/**
 * @param {string} storageDir backend/storage 绝对路径
 */
function extractCacheShopsFromStorage(storageDir, req) {
  const ordersPack = readJsonSafe(path.join(storageDir, 'orders-cache.json'), req) || {};
  const gmvPack = readJsonSafe(path.join(storageDir, 'gmv-cache.json'), req) || {};
  const merged = mergeByShopId([...extractFromOrdersCache(ordersPack), ...extractFromGmvCache(gmvPack)]);
  return merged;
}

/**
 * 预览（不写库）
 * @param {string} storageDir
 */
function previewImport(storageDir, req) {
  const items = extractCacheShopsFromStorage(storageDir, req);
  return { count: items.length, items };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId 默认 1
 * @param {string} storageDir
 * @returns {Promise<{ inserted: number, updated: number, skipped: number, items: number }>}
 */
async function importFromCache(pool, tenantId, storageDir, req) {
  const items = extractCacheShopsFromStorage(storageDir, req);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let skipped_max_shops = 0;

  const [[trow]] = await pool.query('SELECT id FROM tenants WHERE id = ? LIMIT 1', [tenantId]);
  if (!trow || !trow.id) {
    const err = new Error('tenant_not_found');
    err.code = 'tenant_not_found';
    throw err;
  }

  const { assertTenantActive, resolveShopLimit } = require('../tenants/planService');
  const { getTenantById } = require('../tenants/service');
  await assertTenantActive(pool, tenantId);
  const tenantRow = await getTenantById(pool, tenantId);
  const maxShops = resolveShopLimit(tenantRow);

  for (const row of items) {
    const platform = String(row.platform || 'tiktok').slice(0, 32);
    const platform_shop_id = String(row.platform_shop_id || '').trim().slice(0, 128);
    const shop_name = String(row.shop_name || platform_shop_id).trim().slice(0, 255);
    const market = row.market != null ? String(row.market).slice(0, 32) : null;
    if (!platform_shop_id) {
      skipped += 1;
      continue;
    }

    const [found] = await pool.query(
      'SELECT id, imported_from_cache FROM shops WHERE tenant_id = ? AND platform = ? AND platform_shop_id = ? LIMIT 1',
      [tenantId, platform, platform_shop_id],
    );
    const existing = Array.isArray(found) && found[0] ? found[0] : null;

    if (existing) {
      await pool.execute(
        `UPDATE shops SET last_cache_sync_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [existing.id],
      );
      updated += 1;
      continue;
    }

    const [cntRows] = await pool.query(
      "SELECT COUNT(*) AS c FROM shops WHERE tenant_id = ? AND status <> 'deleted'",
      [tenantId],
    );
    const curCount = Number(cntRows[0]?.c ?? 0);
    if (curCount >= maxShops) {
      skipped += 1;
      skipped_max_shops += 1;
      continue;
    }

    await pool.execute(
      `INSERT INTO shops (
         tenant_id, platform, platform_shop_id, shop_name, market, region, currency,
         status, sort_order, hidden, sync_enabled, imported_from_cache, last_cache_sync_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', 0, 0, 1, 1, CURRENT_TIMESTAMP(3))`,
      [tenantId, platform, platform_shop_id, shop_name, market, market],
    );
    inserted += 1;
  }

  return {
    inserted,
    updated,
    skipped,
    skipped_max_shops,
    scanned: items.length,
    max_shops: maxShops,
  };
}

module.exports = {
  extractCacheShopsFromStorage,
  previewImport,
  importFromCache,
  readJsonSafe,
};
