'use strict';

/**
 * 店铺健康 v2：仅用于 POST /api/shops/health/refresh。
 * 不接入 GET /api/shops 主列表；今日单按自然日 CURDATE。
 */

const dayjs = require('dayjs');
const { aggregateTodayStatsByShopId } = require('./shopTodayStats');
const {
  apiStaleSeconds,
  loadOpenApiSyncStateByPlatformShopIdAsync,
} = require('./shopHealthService');
const { migrateShops22HealthColumns } = require('../../db/migrateShops22Health');
const {
  mapSyncErrorToHealthAuth,
  isInfrastructureSyncError,
} = require('../../lib/shopAuthErrorClassifier');
const { ensureShopAccessTokenFresh } = require('../../lib/tiktokTokenRefresh');

const TOKEN_RISK_SOON_SEC = 48 * 3600;
const SYNC_FAIL_THRESHOLD = Number(process.env.SHOP_HEALTH_SYNC_FAIL_THRESHOLD || 3);
const PROTECTED_STATUS = new Set(['normal', 'no_orders_today', 'sync_stale']);

/** 计入「异常店」的状态（sync_stale / no_orders_today 不算） */
const DISPLAY_ABNORMAL = new Set(['auth_error', 'permission_error', 'sync_failed']);

let failCountColumnReady = false;

function formatDt(ms) {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return null;
  return dayjs(ms).format('YYYY-MM-DD HH:mm:ss.SSS');
}

function parseMs(value) {
  if (value == null || value === '') return 0;
  const t = dayjs(value).valueOf();
  return Number.isFinite(t) && t > 0 ? t : 0;
}

function isDisplayAbnormalHealthStatus(status) {
  return DISPLAY_ABNORMAL.has(String(status || ''));
}

function isTransientSyncError(errMsg) {
  const e = String(errMsg || '').toLowerCase();
  if (!e) return false;
  return (
    e.includes('timeout') ||
    e.includes('timed out') ||
    e.includes('etimedout') ||
    e.includes('econnreset') ||
    e.includes('econnrefused') ||
    e.includes('socket hang up') ||
    e.includes('aborted') ||
    e.includes('abort') ||
    e.includes('rate limit') ||
    e.includes('rate_limit') ||
    e.includes('too many request') ||
    e.includes('429') ||
    e.includes('503') ||
    e.includes('502') ||
    e.includes('busy') ||
    e.includes('overload') ||
    e.includes('temporarily unavailable')
  );
}

function classifySyncError(errMsg) {
  const e = String(errMsg || '').toLowerCase();
  if (!e) return 'sync_failed';
  if (isInfrastructureSyncError(errMsg)) return 'sync_failed';
  if (isTransientSyncError(errMsg)) return 'transient';
  if (e.includes('region')) return 'permission_error';
  if (e.includes('permission') || e.includes('scope') || e.includes('forbidden')) {
    return 'permission_error';
  }
  if (mapSyncErrorToHealthAuth(errMsg)) return 'auth_error';
  return 'sync_failed';
}

function authHealthReasonFromSyncError(errMsg) {
  const mapped = mapSyncErrorToHealthAuth(errMsg);
  if (mapped) return mapped.health_reason;
  return `授权失败：${String(errMsg || '令牌无效或已过期')}`;
}

function staleApiMessage(staleSec) {
  const min = Math.floor(staleSec / 60);
  if (min >= 60) return `已超过 ${Math.floor(min / 60)} 小时未成功同步`;
  return `已超过 ${min} 分钟未成功同步`;
}

async function ensureHealthFailCountColumn(pool) {
  if (failCountColumnReady) return;
  const conn = await pool.getConnection();
  try {
    await migrateShops22HealthColumns(conn);
    failCountColumnReady = true;
  } finally {
    conn.release();
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 */
/** @deprecated 使用 shopTodayStats.aggregateTodayStatsByShopId */
async function aggregateTodayOrdersByShopId(pool, tenantId) {
  const { byShopId } = await aggregateTodayStatsByShopId(pool, tenantId);
  return byShopId;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 */
async function loadTokenAuthByShopId(pool, tenantId) {
  const [rows] = await pool.query(
    `SELECT shop_id, token_expire_at, refresh_token, access_token
     FROM shop_auth_tokens WHERE tenant_id = ?`,
    [tenantId],
  );
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const sid = Number(r.shop_id);
    if (!Number.isFinite(sid)) continue;
    const expireMs = r.token_expire_at ? new Date(r.token_expire_at).getTime() : null;
    m.set(sid, {
      expireMs,
      token_expire_at: r.token_expire_at,
      refresh_token: r.refresh_token,
      access_token: r.access_token,
    });
  }
  return m;
}

/**
 * access 已过期或 48h 内将过期时尝试 refresh；失败则返回 auth_error 覆盖项。
 * @param {Record<string, unknown>} shop
 * @param {{ expireMs: number|null, token_expire_at: *, refresh_token: *, access_token: * }|undefined} tokenAuth
 * @param {number} nowMs
 * @param {{ lastSuccessMs: number, latestOrderMs: number }} times
 */
async function tryProactiveTokenRefreshForHealth(shop, tokenAuth, nowMs, times) {
  if (!tokenAuth) return { tokenExpireMs: null, preHealth: null };
  let tokenExpireMs = tokenAuth.expireMs;
  const soonMs = nowMs + TOKEN_RISK_SOON_SEC * 1000;
  if (tokenExpireMs == null || !Number.isFinite(tokenExpireMs) || tokenExpireMs > soonMs) {
    return { tokenExpireMs, preHealth: null };
  }

  const refreshResult = await ensureShopAccessTokenFresh(
    {
      internal_shop_id: shop.id,
      refreshToken: tokenAuth.refresh_token,
      accessToken: tokenAuth.access_token,
      accessTokenExpiresAt: tokenAuth.token_expire_at,
    },
    { skewMs: TOKEN_RISK_SOON_SEC * 1000 },
  );

  if (refreshResult.ok && refreshResult.refreshed && refreshResult.accessTokenExpiresAt) {
    tokenExpireMs = new Date(refreshResult.accessTokenExpiresAt).getTime();
    return { tokenExpireMs, preHealth: null };
  }
  if (refreshResult.ok) {
    return { tokenExpireMs, preHealth: null };
  }

  const label = refreshResult.userLabel || '授权异常';
  return {
    tokenExpireMs,
    preHealth: {
      health_status: 'auth_error',
      health_reason: `${label}：${refreshResult.fullMessage || ''}`,
      latest_sync_success_at: formatDt(times.lastSuccessMs),
      latest_order_at: formatDt(times.latestOrderMs),
    },
  };
}

function hasSyncSuccessInWindow(shopRow, sync, nowMs) {
  const staleMs = apiStaleSeconds() * 1000;
  const fromSync = sync?.lastSyncOk && sync?.lastSyncAtMs ? sync.lastSyncAtMs : 0;
  const fromDb = parseMs(shopRow.last_sync_at);
  const lastSuccessMs = Math.max(fromSync, fromDb);
  return lastSuccessMs > 0 && nowMs - lastSuccessMs <= staleMs;
}

function computeHealthV2Display(shopRow, sync, stats, tokenExpireMs, nowMs) {
  const status = String(shopRow.status || '').toLowerCase();
  const hidden = shopRow.hidden === 1 || shopRow.hidden === true;
  const syncOn = !(shopRow.sync_enabled === 0 || shopRow.sync_enabled === false);
  const staleSec = apiStaleSeconds();
  const staleMs = staleSec * 1000;
  const todayOrders = Number(stats?.today_orders) || 0;
  const latestOrderMs = Number(stats?.latest_order_at) || 0;
  const pid = String(shopRow.platform_shop_id || '').trim().toLowerCase();

  const lastAttemptMs = sync?.lastSyncAtMs || 0;
  const lastSuccessMs = sync?.lastSyncOk && lastAttemptMs > 0 ? lastAttemptMs : 0;
  const syncFresh = lastSuccessMs > 0 && nowMs - lastSuccessMs <= staleMs;
  const errDetailFull = sync?.lastSyncError ? String(sync.lastSyncError) : '';
  const errDetail = errDetailFull.length > 500 ? errDetailFull.slice(0, 500) : errDetailFull;

  if (status === 'disabled') {
    return {
      health_status: 'disabled',
      health_reason: '店铺已禁用',
      latest_sync_success_at: formatDt(lastSuccessMs),
      latest_order_at: formatDt(latestOrderMs),
    };
  }
  if (hidden) {
    return {
      health_status: 'hidden',
      health_reason: '店铺已隐藏',
      latest_sync_success_at: formatDt(lastSuccessMs),
      latest_order_at: formatDt(latestOrderMs),
    };
  }

  if (!syncOn) {
    return {
      health_status: 'sync_off',
      health_reason: '订单同步已关闭',
      latest_sync_success_at: formatDt(lastSuccessMs),
      latest_order_at: formatDt(latestOrderMs),
    };
  }

  if (todayOrders > 0) {
    return {
      health_status: 'normal',
      health_reason: '今日有单，数据正常',
      latest_sync_success_at: formatDt(lastSuccessMs),
      latest_order_at: formatDt(latestOrderMs),
    };
  }

  if (!sync || !sync.enabled) {
    return {
      health_status: 'sync_stale',
      health_reason: sync
        ? '较久无成功同步：OpenAPI 侧店铺未启用'
        : `较久无成功同步：OpenAPI 未覆盖 platform_shop_id=${pid || '?'}`,
      latest_sync_success_at: formatDt(lastSuccessMs),
      latest_order_at: formatDt(latestOrderMs),
    };
  }

  if (!sync.lastSyncOk) {
    const recentFail = lastAttemptMs > 0 && nowMs - lastAttemptMs <= staleMs;
    const errStatus = classifySyncError(sync.lastSyncError);
    if (recentFail) {
      if (errStatus === 'auth_error') {
        const mapped = mapSyncErrorToHealthAuth(sync.lastSyncError);
        return {
          health_status: 'auth_error',
          health_reason: mapped?.health_reason || authHealthReasonFromSyncError(sync.lastSyncError),
          latest_sync_success_at: formatDt(lastSuccessMs),
          latest_order_at: formatDt(latestOrderMs),
        };
      }
      if (errStatus === 'permission_error') {
        return {
          health_status: 'permission_error',
          health_reason: `API 权限失败：${errDetailFull || '权限或 scope 不足'}`,
          latest_sync_success_at: formatDt(lastSuccessMs),
          latest_order_at: formatDt(latestOrderMs),
        };
      }
      if (errStatus === 'transient') {
        return {
          health_status: 'sync_stale',
          health_reason: `同步异常：${errDetail || 'OpenAPI 暂时不可用（timeout 或限流）'}`,
          latest_sync_success_at: formatDt(lastSuccessMs),
          latest_order_at: formatDt(latestOrderMs),
        };
      }
      return {
        health_status: 'sync_failed',
        health_reason: `同步异常：${errDetail || '订单接口读取失败'}`,
        latest_sync_success_at: formatDt(lastSuccessMs),
        latest_order_at: formatDt(latestOrderMs),
      };
    }
    if (lastSuccessMs > 0 && !syncFresh) {
      return {
        health_status: 'sync_stale',
        health_reason: staleApiMessage(staleSec),
        latest_sync_success_at: formatDt(lastSuccessMs),
        latest_order_at: formatDt(latestOrderMs),
      };
    }
    return {
      health_status: 'no_orders_today',
      health_reason: '今日无单，授权和同步正常（末次同步失败较久）',
      latest_sync_success_at: formatDt(lastSuccessMs),
      latest_order_at: formatDt(latestOrderMs),
    };
  }

  if (syncFresh) {
    return {
      health_status: 'no_orders_today',
      health_reason: '今日无单，授权和同步正常',
      latest_sync_success_at: formatDt(lastSuccessMs),
      latest_order_at: formatDt(latestOrderMs),
    };
  }

  return {
    health_status: 'sync_stale',
    health_reason: staleApiMessage(staleSec),
    latest_sync_success_at: formatDt(lastSuccessMs),
    latest_order_at: formatDt(latestOrderMs),
  };
}

function isComputedSyncFailure(rawHealth, stats, sync) {
  const todayOrders = Number(stats?.today_orders) || 0;
  if (todayOrders > 0) return false;
  const st = String(rawHealth.health_status || '');
  if (st === 'auth_error' || st === 'permission_error' || st === 'disabled' || st === 'hidden' || st === 'sync_off') {
    return false;
  }
  if (st === 'sync_failed') return true;
  if (st === 'sync_stale' && sync && (!sync.lastSyncOk || isTransientSyncError(sync.lastSyncError))) {
    return true;
  }
  return false;
}

function isDegradingProtected(prev, rawHealth) {
  const next = String(rawHealth.health_status || '');
  if (!PROTECTED_STATUS.has(prev)) return false;
  if (next === 'sync_failed') return true;
  if (next === 'sync_stale' && (prev === 'normal' || prev === 'no_orders_today')) return true;
  return false;
}

function buildRetainedHealth(shopRow, stats) {
  const prev = String(shopRow.last_health_status || 'unknown').toLowerCase();
  const statsPack = stats || { today_orders: 0, latest_order_at: 0 };
  return {
    health_status: prev,
    health_reason: shopRow.last_health_message || '保留上次健康状态',
    latest_sync_success_at: formatDt(parseMs(shopRow.last_sync_at)),
    latest_order_at: formatDt(statsPack.latest_order_at || parseMs(shopRow.last_order_seen_at)),
  };
}

/**
 * 失败降级：保护 normal / no_orders_today / sync_stale，sync_failed 需连续失败阈值。
 */
function finalizeHealthResult(shopRow, rawHealth, stats, sync, nowMs) {
  const prev = String(shopRow.last_health_status || 'unknown').toLowerCase();
  let failCount = Number(shopRow.last_health_fail_count) || 0;
  const todayOrders = Number(stats?.today_orders) || 0;

  if (todayOrders > 0) {
    let reason = '今日有单，数据正常';
    if (sync && (!sync.lastSyncOk || isTransientSyncError(sync.lastSyncError))) {
      reason = `${reason}（OpenAPI 告警：${String(sync.lastSyncError || '暂时不可用').slice(0, 100)}）`;
    }
    return {
      health: {
        ...rawHealth,
        health_status: 'normal',
        health_reason: reason,
      },
      failCount: 0,
      applied: true,
      retained: false,
    };
  }

  const authImmediate =
    rawHealth.health_status === 'auth_error' || rawHealth.health_status === 'permission_error';
  if (authImmediate) {
    return { health: rawHealth, failCount: 0, applied: true, retained: false };
  }

  if (hasSyncSuccessInWindow(shopRow, sync, nowMs) && rawHealth.health_status !== 'sync_failed') {
    return { health: rawHealth, failCount: 0, applied: true, retained: false };
  }

  const syncFail = isComputedSyncFailure(rawHealth, stats, sync);
  if (syncFail) failCount += 1;
  else if (['normal', 'no_orders_today'].includes(String(rawHealth.health_status || ''))) {
    failCount = 0;
  }

  const canApplySyncFailed =
    failCount >= SYNC_FAIL_THRESHOLD &&
    todayOrders === 0 &&
    !hasSyncSuccessInWindow(shopRow, sync, nowMs) &&
    (rawHealth.health_status === 'sync_failed' || prev === 'sync_stale');

  if (rawHealth.health_status === 'sync_failed' && !canApplySyncFailed) {
    if (PROTECTED_STATUS.has(prev)) {
      return {
        health: buildRetainedHealth(shopRow, stats),
        failCount,
        applied: false,
        retained: true,
      };
    }
    return {
      health: {
        ...rawHealth,
        health_status: 'sync_stale',
        health_reason: `同步异常累计 ${failCount}/${SYNC_FAIL_THRESHOLD} 次，暂未标记为同步失败`,
      },
      failCount,
      applied: true,
      retained: false,
    };
  }

  if (isDegradingProtected(prev, rawHealth) && !canApplySyncFailed) {
    return {
      health: buildRetainedHealth(shopRow, stats),
      failCount,
      applied: false,
      retained: true,
    };
  }

  if (canApplySyncFailed) {
    return {
      health: {
        ...rawHealth,
        health_status: 'sync_failed',
        health_reason: rawHealth.health_reason || `连续 ${failCount} 次同步失败`,
      },
      failCount,
      applied: true,
      retained: false,
    };
  }

  if (!syncFail) failCount = 0;
  return { health: rawHealth, failCount, applied: true, retained: false };
}

function toHealthPatch(shopRow, health, stats, meta) {
  const todayOrders = Number(stats?.today_orders) || 0;
  return {
    shopId: shopRow.id,
    shop_id: shopRow.id,
    healthStatus: health.health_status,
    health_status: health.health_status,
    healthReason: health.health_reason,
    health_reason: health.health_reason,
    lastSyncAt: health.latest_sync_success_at || shopRow.last_sync_at,
    last_sync_at: health.latest_sync_success_at || shopRow.last_sync_at,
    lastOrderAt: health.latest_order_at || shopRow.last_order_seen_at,
    last_order_seen_at: health.latest_order_at || shopRow.last_order_seen_at,
    latest_order_at: health.latest_order_at,
    lastApiSuccessAt: health.latest_sync_success_at,
    latest_sync_success_at: health.latest_sync_success_at,
    todayOrders,
    today_orders: todayOrders,
    healthFailCount: meta.failCount,
    health_fail_count: meta.failCount,
    applied: meta.applied,
    retained: meta.retained,
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 */
async function refreshTenantShopHealthV2(pool, tenantId) {
  await ensureHealthFailCountColumn(pool);

  const [shopRows] = await pool.query(
    `SELECT id, tenant_id, platform, platform_shop_id, shop_name, display_name, market, region, currency,
            sort_order, hidden, sync_enabled, remarks, imported_from_cache, last_cache_sync_at, status,
            auth_status, last_sync_at, last_order_seen_at, last_order_count, last_gmv_amount,
            last_health_status, last_health_message, last_health_checked_at,
            COALESCE(last_health_fail_count, 0) AS last_health_fail_count,
            created_at, updated_at
     FROM shops WHERE tenant_id = ? AND status <> 'deleted'`,
    [tenantId],
  );
  const shops = Array.isArray(shopRows) ? shopRows : [];
  const [todayByShopId, syncByPlatformId, tokenByShopId] = await Promise.all([
    aggregateTodayOrdersByShopId(pool, tenantId),
    loadOpenApiSyncStateByPlatformShopIdAsync(),
    loadTokenAuthByShopId(pool, tenantId),
  ]);

  const nowMs = Date.now();
  const patches = [];
  let abnormal = 0;
  let retainedCount = 0;
  let appliedCount = 0;

  for (const shop of shops) {
    const stats = todayByShopId.get(Number(shop.id)) || {
      today_orders: 0,
      today_gmv: 0,
      latest_order_at: 0,
    };
    const pid = String(shop.platform_shop_id || '').trim().toLowerCase();
    const sync = pid ? syncByPlatformId.get(pid) : null;
    const tokenAuth = tokenByShopId.get(Number(shop.id));
    const lastSuccessMs =
      sync?.lastSyncOk && sync?.lastSyncAtMs ? sync.lastSyncAtMs : parseMs(shop.last_sync_at);
    const latestOrderMs = Number(stats?.latest_order_at) || parseMs(shop.last_order_seen_at);
    const { tokenExpireMs, preHealth } = await tryProactiveTokenRefreshForHealth(
      shop,
      tokenAuth,
      nowMs,
      { lastSuccessMs, latestOrderMs },
    );
    const rawHealth =
      preHealth || computeHealthV2Display(shop, sync, stats, tokenExpireMs, nowMs);
    const finalized = finalizeHealthResult(shop, rawHealth, stats, sync, nowMs);
    const patch = toHealthPatch(shop, finalized.health, stats, finalized);

    if (finalized.retained) retainedCount += 1;
    else appliedCount += 1;

    patches.push(patch);

    const statusForDb = String(finalized.health.health_status || '').slice(0, 32);
    if (isDisplayAbnormalHealthStatus(statusForDb)) abnormal += 1;

    const statsPack = todayByShopId.get(Number(shop.id)) || { today_orders: 0, today_gmv: 0 };
    const todayGmv = Number(statsPack.today_gmv) || 0;
    const todayOrders = Number(statsPack.today_orders) || 0;
    const gmvForDb = todayOrders > 0 ? todayGmv : 0;

    await pool.execute(
      `UPDATE shops SET
         last_order_seen_at = ?,
         last_order_count = ?,
         last_gmv_amount = ?,
         last_sync_at = COALESCE(?, last_sync_at),
         last_health_status = ?,
         last_health_message = ?,
         last_health_fail_count = ?,
         last_health_checked_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND tenant_id = ?`,
      [
        patch.lastOrderAt,
        todayOrders,
        gmvForDb,
        patch.lastSyncAt,
        statusForDb,
        finalized.health.health_reason,
        finalized.failCount,
        shop.id,
        tenantId,
      ],
    );
  }

  return {
    checked: shops.length,
    abnormal,
    shops: patches,
    applied_count: appliedCount,
    retained_count: retainedCount,
    partial: retainedCount > 0,
    stats_source: 'mysql_curdate',
  };
}

module.exports = {
  SYNC_FAIL_THRESHOLD,
  isDisplayAbnormalHealthStatus,
  refreshTenantShopHealthV2,
  computeHealthV2Display,
  finalizeHealthResult,
};
