'use strict';

const dayjs = require('dayjs');

const TOKEN_RISK_SOON_SEC = 48 * 3600;

/** 超过该时长无成功 OpenAPI 调用则视为同步停滞（默认约 6 个采集周期，最少 30 分钟） */
function apiStaleSeconds() {
  const fromEnv = Number(process.env.SHOP_HEALTH_API_STALE_SECONDS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const interval = Number(process.env.GMV_COLLECT_INTERVAL_SECONDS || 300);
  return Math.max(1800, interval * 6);
}

const ABNORMAL_HEALTH = new Set([
  'auth_error',
  'permission_error',
  'region_error',
  'sync_stale',
  'sync_failed',
  'token_risk',
  'unknown',
]);

function parseSyncAtMs(value) {
  if (value == null || value === '') return 0;
  const t = dayjs(value).valueOf();
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * OpenAPI 同步状态（SaaS）：仅 MySQL shops，不读 shops.json。
 * @returns {Promise<Map<string, { lastSyncAtMs: number, lastSyncOk: boolean, lastSyncError: string, enabled: boolean }>>}
 */
async function loadOpenApiSyncStateByPlatformShopIdAsync() {
  const { loadOpenApiSyncStateFromMysql } = require('../../lib/openApiSyncShops');
  const { getMysqlPool } = require('../../db/mysqlPool');
  const pool = getMysqlPool();
  if (!pool) {
    console.warn('[shop-health] mysql unavailable — sync state empty (no shops.json fallback)');
    return new Map();
  }
  try {
    return await loadOpenApiSyncStateFromMysql();
  } catch (e) {
    console.warn('[shop-health] mysql sync state failed:', e?.message || e);
    return new Map();
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 */
async function loadTokenExpiryByShopId(pool, tenantId) {
  const [rows] = await pool.query(
    'SELECT shop_id, token_expire_at FROM shop_auth_tokens WHERE tenant_id = ?',
    [tenantId],
  );
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const sid = Number(r.shop_id);
    if (!Number.isFinite(sid)) continue;
    m.set(sid, r.token_expire_at ? new Date(r.token_expire_at).getTime() : null);
  }
  return m;
}

function classifySyncError(errMsg) {
  const e = String(errMsg || '').toLowerCase();
  if (!e) return 'sync_stale';
  if (e.includes('timeout') || e.includes('timed out') || e.includes('etimedout') || e.includes('deadline')) {
    return 'sync_stale';
  }
  if (e.includes('region')) return 'region_error';
  if (e.includes('permission') || e.includes('scope') || e.includes('forbidden')) {
    return 'permission_error';
  }
  if (
    e.includes('token') ||
    e.includes('expired') ||
    e.includes('refresh') ||
    e.includes('unauthorized') ||
    e.includes('access_denied') ||
    e.includes('invalid access')
  ) {
    return 'auth_error';
  }
  return 'sync_stale';
}

function staleApiMessage(staleSec) {
  const min = Math.floor(staleSec / 60);
  if (min >= 60) return `已超过 ${Math.floor(min / 60)} 小时未成功调用 OpenAPI`;
  return `已超过 ${min} 分钟未成功调用 OpenAPI`;
}

function computeHealthStatus(shopRow, syncByPlatformId, tokenExpireMs, nowMs) {
  const status = String(shopRow.status || '').toLowerCase();
  const hidden = shopRow.hidden === 1 || shopRow.hidden === true;
  const syncOn = !(shopRow.sync_enabled === 0 || shopRow.sync_enabled === false);
  const staleSec = apiStaleSeconds();
  const staleMs = staleSec * 1000;

  if (status === 'disabled') {
    return { last_health_status: 'disabled', last_health_message: '店铺已禁用' };
  }
  if (hidden) {
    return { last_health_status: 'hidden', last_health_message: '店铺已隐藏' };
  }

  if (tokenExpireMs != null && Number.isFinite(tokenExpireMs)) {
    const soon = nowMs + TOKEN_RISK_SOON_SEC * 1000;
    if (tokenExpireMs <= soon) {
      return {
        last_health_status: 'auth_error',
        last_health_message:
          tokenExpireMs <= nowMs ? '访问令牌已过期' : '访问令牌即将过期，请重新授权',
      };
    }
  }

  if (!syncOn) {
    return { last_health_status: 'sync_off', last_health_message: '订单同步已关闭' };
  }

  const pid = String(shopRow.platform_shop_id || '').trim().toLowerCase();
  const sync = pid && syncByPlatformId ? syncByPlatformId.get(pid) : null;

  if (!sync) {
    return {
      last_health_status: 'sync_stale',
      last_health_message: 'OpenAPI 同步未覆盖该店铺（MySQL sync_enabled/token/cipher 或 worker 未拉取）',
    };
  }

  if (!sync.enabled) {
    return {
      last_health_status: 'sync_stale',
      last_health_message: 'OpenAPI 侧店铺未启用，同步 worker 未遍历',
    };
  }

  if (sync.lastSyncOk) {
    if (sync.lastSyncAtMs > 0 && nowMs - sync.lastSyncAtMs > staleMs) {
      return {
        last_health_status: 'sync_stale',
        last_health_message: staleApiMessage(staleSec),
      };
    }
    return { last_health_status: 'normal', last_health_message: null };
  }

  const errStatus = classifySyncError(sync.lastSyncError);
  const errDetail = sync.lastSyncError ? String(sync.lastSyncError).slice(0, 240) : 'OpenAPI 请求失败';

  if (!sync.lastSyncAtMs) {
    return {
      last_health_status: errStatus,
      last_health_message: sync.lastSyncError ? errDetail : '尚未成功完成 OpenAPI 同步',
    };
  }

  if (nowMs - sync.lastSyncAtMs > staleMs) {
    return {
      last_health_status: errStatus === 'sync_stale' ? 'sync_stale' : errStatus,
      last_health_message: sync.lastSyncError ? errDetail : staleApiMessage(staleSec),
    };
  }

  return {
    last_health_status: errStatus,
    last_health_message: errDetail,
  };
}

function isAbnormalHealthStatus(status) {
  return ABNORMAL_HEALTH.has(String(status || ''));
}

/**
 * 租户店铺健康刷新（SaaS）：统计与健康判定均来自 MySQL（enrichShopRows），不读 orders-cache。
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {string} [_storageDir] 已废弃，保留参数兼容 import-cache 路由签名
 * @returns {Promise<{ checked: number, abnormal: number, stats_source: string }>}
 */
async function refreshTenantShopHealth(pool, tenantId, _storageDir) {
  const { refreshTenantShopHealthV2 } = require('./shopHealthRefreshService');
  return refreshTenantShopHealthV2(pool, tenantId);
}

/* -------------------------------------------------------------------------- */
/* Legacy / 脚本专用（禁止 SaaS API 调用）                                      */
/* -------------------------------------------------------------------------- */

const path = require('path');
const { readJsonWithRecovery } = require('../../lib/storageFile');

/** @deprecated legacy — 勿在 modules SaaS 路径使用 */
function readJsonSafe(filePath) {
  if (!filePath) return null;
  const r = readJsonWithRecovery(filePath, { restore: true });
  return r.data;
}

/** @deprecated 仅读 storage/shops.json；SaaS 请用 loadOpenApiSyncStateByPlatformShopIdAsync */
function loadOpenApiSyncStateFromJson() {
  const { readShops } = require('../../tiktok-api/shops');
  const shops = readShops();
  const map = new Map();
  for (const s of Array.isArray(shops) ? shops : []) {
    const pid = String(s?.shopId ?? '').trim().toLowerCase();
    if (!pid) continue;
    map.set(pid, {
      lastSyncAtMs: parseSyncAtMs(s.lastSyncAt),
      lastSyncOk: s.lastSyncOk === true,
      lastSyncError: String(s.lastSyncError || ''),
      enabled: s.enabled !== false,
    });
  }
  return map;
}

/** @deprecated 同步版仅读 shops.json；运维脚本 auditCavera / investigateCavera 等 */
function loadOpenApiSyncStateByPlatformShopId() {
  return loadOpenApiSyncStateFromJson();
}

function getTodayRangeByOffsetHours(offsetHours = 8) {
  const nowUtcMs = Date.now();
  const shiftedNow = new Date(nowUtcMs + offsetHours * 3600 * 1000);
  const y = shiftedNow.getUTCFullYear();
  const m = shiftedNow.getUTCMonth();
  const d = shiftedNow.getUTCDate();
  const startUtcMs = Date.UTC(y, m, d, 0, 0, 0) - offsetHours * 3600 * 1000;
  return {
    todayStartEpoch: Math.floor(startUtcMs / 1000),
    nowEpoch: Math.floor(nowUtcMs / 1000),
  };
}

function orderCreateEpoch(o) {
  if (!o || typeof o !== 'object') return 0;
  const raw =
    o.create_time ??
    o.createTime ??
    o.create_time_sec ??
    o.createTimeSec ??
    o._raw?.createTime ??
    o._raw?.create_time ??
    0;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    if (n > 1e12) return Math.floor(n / 1000);
    return Math.floor(n);
  }
  return 0;
}

function orderAmountBase(o) {
  if (!o || typeof o !== 'object') return 0;
  const v = o.orderAmountBase ?? o.totalAmount ?? o.order_amount_base ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @deprecated legacy orders-cache 聚合；SaaS 健康刷新已改用 MySQL（shopLiveStatsService）
 * @returns {Map<string, { lastEp: number, todayCount: number, todayGmv: number }>}
 */
function aggregateOrdersByShopId(ordersPack) {
  const orders = ordersPack && Array.isArray(ordersPack.orders) ? ordersPack.orders : [];
  const { todayStartEpoch, nowEpoch } = getTodayRangeByOffsetHours(8);
  const map = new Map();
  for (const o of orders) {
    if (!o || typeof o !== 'object') continue;
    const sid = String(o.shopId ?? o.shop_id ?? '').trim();
    if (!sid) continue;
    const ep = orderCreateEpoch(o);
    if (!ep) continue;
    const key = sid.toLowerCase();
    let g = map.get(key);
    if (!g) {
      g = { shopId: sid, lastEp: 0, todayCount: 0, todayGmv: 0 };
      map.set(key, g);
    }
    if (ep > g.lastEp) g.lastEp = ep;
    if (ep >= todayStartEpoch && ep <= nowEpoch) {
      g.todayCount += 1;
      g.todayGmv += orderAmountBase(o);
    }
  }
  return map;
}

module.exports = {
  refreshTenantShopHealth,
  isAbnormalHealthStatus,
  apiStaleSeconds,
  loadOpenApiSyncStateByPlatformShopIdAsync,
  computeHealthStatus,
  loadTokenExpiryByShopId,
  /** @deprecated legacy / scripts only */
  aggregateOrdersByShopId,
  getTodayRangeByOffsetHours,
  loadOpenApiSyncStateByPlatformShopId,
  loadOpenApiSyncStateFromJson,
  readJsonSafe,
};
