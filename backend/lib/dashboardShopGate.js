'use strict';

const { getMysqlPool } = require('../db/mysqlPool');
const { orderMarketRegion } = require('../tiktok-api/ordersDashboardFromCache');
const { refreshAuthScopeFromDb } = require('./authScopeRefresh');
const { isPlatformScope } = require('./userScope');
const { readQueryTenantId } = require('./effectiveTenant');

function getDashboardTenantId() {
  const n = Number(process.env.DASHBOARD_TENANT_ID || 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function normalizePid(v) {
  return String(v ?? '').trim().toLowerCase();
}

function normalizeCompactName(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** 与订单侧 shopName + market/region 对齐的复合键 */
function buildNameMarketKey(displayOrShopName, marketOrRegion) {
  const n = normalizeCompactName(displayOrShopName);
  const m = String(marketOrRegion ?? '')
    .trim()
    .toUpperCase();
  if (!n || !m) return '';
  return `${n}|${m}`;
}

/**
 * 缓存订单可能使用 shopId / platform_shop_id / 店铺名 + 市场 等不同字段，须与 MySQL  eligible 店铺对齐。
 * @param {object} order
 * @param {{ shopIdSet: Set<string>, nameMarketKeySet: Set<string> } | null} gate
 */
function orderMatchesEligibleMysqlGate(order, gate) {
  if (!gate || !gate.shopIdSet) return true;

  const candidates = [
    order?.shopId,
    order?.shop_id,
    order?.platform_shop_id,
    order?.shop?.shop_id,
    order?.shop?.platform_shop_id,
    order?._raw?.shop_id,
  ];
  for (const c of candidates) {
    const pid = normalizePid(c);
    if (pid && gate.shopIdSet.has(pid)) return true;
  }

  const shopLabel =
    order?.shopName ??
    order?.shop_name ??
    order?.shop?.shop_name ??
    order?.shop?.display_name ??
    '';
  const mr = orderMarketRegion(order);
  const keys = [
    buildNameMarketKey(shopLabel, mr || order?.market || order?.region),
    buildNameMarketKey(shopLabel, order?.region),
    buildNameMarketKey(shopLabel, order?.market),
  ];
  for (const k of keys) {
    if (k && gate.nameMarketKeySet.has(k)) return true;
  }

  return false;
}

/** 租户无店铺或 MySQL 不可用时：拒绝 orders-cache / legacy shops 全量泄漏 */
function createEmptyMysqlShopGate(tenantId) {
  return {
    tenantId,
    totalMysqlShops: 0,
    shopIdSet: new Set(),
    nameMarketKeySet: new Set(),
    catalogShops: [],
    eligibleShopIds: [],
    excludedShopIds: [],
    reasonMap: {},
  };
}

/**
 * 指定租户的大屏店铺 gate（与 loadMysqlDashboardShopGate 逻辑一致，仅 tenant 来源不同）。
 * @param {number} tenantId
 * @param {{ skipDashboardLog?: boolean }} [options]
 */
async function loadMysqlShopGateForTenant(tenantId, options = {}) {
  const pool = getMysqlPool();
  if (!pool) return null;

  const [allRows] = await pool.query(
    `SELECT id, platform_shop_id, shop_name, display_name, market, region, status, hidden, sync_enabled
     FROM shops
     WHERE tenant_id = ? AND status <> 'deleted'
     ORDER BY id ASC`,
    [tenantId],
  );
  const rows = Array.isArray(allRows) ? allRows : [];
  const totalMysqlShops = rows.length;

  const [eligibleRows] = await pool.query(
    `SELECT id, platform_shop_id, shop_name, display_name, market, region, currency, sort_order, status, hidden, sync_enabled
     FROM shops
     WHERE tenant_id = ?
       AND status = 'active'
       AND hidden = 0
     ORDER BY sort_order ASC, id ASC`,
    [tenantId],
  );
  const eligList = Array.isArray(eligibleRows) ? eligibleRows : [];

  const shopIdSet = new Set();
  const nameMarketKeySet = new Set();
  const catalogShops = [];
  const eligibleShopIds = [];

  for (const r of eligList) {
    const pid = normalizePid(r.platform_shop_id);
    if (!pid) continue;
    eligibleShopIds.push(pid);
    shopIdSet.add(pid);

    const label = String(r.display_name || '').trim() || String(r.shop_name || '').trim();
    const region = String(r.region || r.market || '').trim();
    const marketU = r.market != null ? String(r.market).trim().toUpperCase() : '';

    const km = buildNameMarketKey(label, r.market != null ? r.market : r.region);
    if (km) nameMarketKeySet.add(km);
    const kr = buildNameMarketKey(label, r.region);
    if (kr && kr !== km) nameMarketKeySet.add(kr);

    catalogShops.push({
      shopId: pid,
      shopName: label || pid,
      region,
      market: marketU || undefined,
    });
  }

  const eligiblePidSet = new Set(eligibleShopIds);
  const reasonMap = {};
  const excludedShopIds = [];

  for (const r of rows) {
    const pid = normalizePid(r.platform_shop_id);
    if (!pid) continue;
    if (eligiblePidSet.has(pid)) continue;

    const st = String(r.status || '').trim().toLowerCase();
    let reason = 'not_eligible';
    if (st === 'deleted') reason = 'deleted';
    else if (st !== 'active') reason = 'not_active';
    else if (r.hidden === 1 || r.hidden === true) reason = 'hidden';

    reasonMap[pid] = reason;
    excludedShopIds.push(pid);
  }

  const logPayload = {
    tenantId,
    totalMysqlShops,
    eligibleShopIds,
    excludedShopIds,
    reasonMap,
  };
  if (eligibleShopIds.length > 400 || excludedShopIds.length > 400 || Object.keys(reasonMap).length > 400) {
    logPayload.eligibleShopIds = {
      length: eligibleShopIds.length,
      head: eligibleShopIds.slice(0, 120),
    };
    logPayload.excludedShopIds = {
      length: excludedShopIds.length,
      head: excludedShopIds.slice(0, 120),
    };
    const entries = Object.entries(reasonMap);
    logPayload.reasonMap = {
      length: entries.length,
      head: Object.fromEntries(entries.slice(0, 120)),
    };
  }

  if (!options.skipDashboardLog) {
    console.log('[dashboard-shop-gate]', logPayload);
  }

  return {
    tenantId,
    totalMysqlShops,
    shopIdSet,
    nameMarketKeySet,
    catalogShops,
    eligibleShopIds,
    excludedShopIds,
    reasonMap,
  };
}

/**
 * 大屏参与店铺：status = active 且未隐藏；sync_enabled 仅影响采集/健康，不参与大屏过滤。
 * 每次请求直连 MySQL；pool 未配置时返回 null（走 legacy readShops）。
 * @deprecated 请使用 resolveDashboardShopGate(req)
 */
async function loadMysqlDashboardShopGate() {
  const pool = getMysqlPool();
  if (!pool) return null;
  return loadMysqlShopGateForTenant(getDashboardTenantId());
}

/**
 * 按登录角色解析大屏 shop gate：
 * - scope=platform / super_admin：null（全量 orders-cache + readShops）
 * - admin / viewer / tenant：当前 JWT tenant 的 eligible 店铺
 * - 无 JWT：DASHBOARD_TENANT_ID（兼容旧环境）
 * - MySQL 未配置：非平台用户返回空 gate（禁止回退全量 legacy）
 */
async function resolveDashboardShopGate(req) {
  const auth = req?.auth;
  if (auth?.user_id) {
    await refreshAuthScopeFromDb(auth);
  }
  if (auth && isPlatformScope(auth)) {
    const qTid =
      req?.tenantId != null && Number.isFinite(Number(req.tenantId)) && Number(req.tenantId) > 0
        ? Number(req.tenantId)
        : readQueryTenantId(req);
    if (Number.isFinite(qTid) && qTid > 0) {
      const pool = getMysqlPool();
      if (!pool) return createEmptyMysqlShopGate(qTid);
      return loadMysqlShopGateForTenant(qTid);
    }
    if (String(process.env.DEBUG_AUTH_SCOPE || '').trim() === '1') {
      console.log('[dashboard-shop-gate] platform — no tenant_id, empty gate', {
        user_id: auth.user_id,
        scope: auth.scope,
      });
    }
    return createEmptyMysqlShopGate(0);
  }

  if (!auth) {
    return createEmptyMysqlShopGate(getDashboardTenantId());
  }

  const tenantId = Number(auth.tenant_id);
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return createEmptyMysqlShopGate(0);
  }

  const pool = getMysqlPool();
  if (!pool) return createEmptyMysqlShopGate(tenantId);
  return loadMysqlShopGateForTenant(tenantId);
}

/**
 * 当前登录用户可访问的 platform_shop_id 集合（大屏 / 排行等租户隔离入口）
 * @returns {Promise<{ platform: boolean, tenantId: number|null, shopIds: string[]|null }>}
 */
async function getAccessibleShopIds(auth) {
  if (!auth) {
    return { platform: false, tenantId: null, shopIds: [] };
  }
  if (isPlatformScope(auth)) {
    return { platform: true, tenantId: Number(auth.tenant_id) || null, shopIds: null };
  }
  const tenantId = Number(auth.tenant_id);
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return { platform: false, tenantId: null, shopIds: [] };
  }
  const pool = getMysqlPool();
  if (!pool) {
    return { platform: false, tenantId, shopIds: [] };
  }
  const gate = await loadMysqlShopGateForTenant(tenantId, { skipDashboardLog: true });
  return {
    platform: false,
    tenantId,
    shopIds: gate ? [...gate.shopIdSet] : [],
  };
}

module.exports = {
  loadMysqlDashboardShopGate,
  resolveDashboardShopGate,
  loadMysqlShopGateForTenant,
  createEmptyMysqlShopGate,
  getAccessibleShopIds,
  getDashboardTenantId,
  orderMatchesEligibleMysqlGate,
};
