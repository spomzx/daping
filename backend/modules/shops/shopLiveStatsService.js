'use strict';

const dayjs = require('dayjs');
const {
  apiStaleSeconds,
  loadOpenApiSyncStateByPlatformShopIdAsync,
} = require('./shopHealthService');

function hasRecentVerifiedApiSuccess(shopRow, sync, nowMs) {
  const staleMs = apiStaleSeconds() * 1000;
  const rowSuccessMs = shopRow.last_success_sync_at
    ? dayjs(shopRow.last_success_sync_at).valueOf()
    : 0;
  if (rowSuccessMs > 0 && nowMs - rowSuccessMs <= staleMs) return true;

  const st = String(shopRow.sync_status || '').toLowerCase();
  if (
    rowSuccessMs > 0 &&
    (st === 'idle' || st === 'success' || st === 'partial_success')
  ) {
    return true;
  }

  if (sync?.lastSyncOk && sync.lastSyncAtMs > 0 && nowMs - sync.lastSyncAtMs <= staleMs) {
    return true;
  }
  return false;
}
const { mapSyncErrorToHealthAuth } = require('../../lib/shopAuthErrorClassifier');
const {
  aggregateTodayStatsByShopId,
  fetchTodayStatsForShopRow,
  applyTrustedTodayKpi,
} = require('./shopTodayStats');
const { looksLikeStaleAuthState } = require('../../lib/staleAuthHealthRepair');
const {
  loadAuthContractByShopId,
  effectiveIsTokenValidForHealth,
  tokenPresentFromRow,
} = require('../../lib/shopAuthContract');
const { applyShopListDisplayContract } = require('../../lib/shopListDisplay');

/** 健康判定文案用滚动窗口（小时）；今日 KPI 为自然日 CURDATE */
function shopStatsWindowHours() {
  const h = Number(process.env.SHOP_TODAY_WINDOW_HOURS || process.env.ANALYTICS_DEFAULT_HOURS || 24);
  return Number.isFinite(h) && h > 0 ? Math.min(720, Math.max(1, h)) : 24;
}

function formatDt(ms) {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return null;
  return dayjs(ms).format('YYYY-MM-DD HH:mm:ss.SSS');
}

function staleApiMessage(staleSec) {
  const min = Math.floor(staleSec / 60);
  if (min >= 60) return `已超过 ${Math.floor(min / 60)} 小时无成功 OpenAPI 同步`;
  return `已超过 ${min} 分钟无成功 OpenAPI 同步`;
}

function orderInStatsWindow(latestOrderMs, windowHours, nowMs) {
  if (!latestOrderMs || !Number.isFinite(latestOrderMs) || latestOrderMs <= 0) return false;
  return latestOrderMs >= nowMs - windowHours * 3600 * 1000;
}

function syncSuccessWithinThreshold(lastSuccessMs, staleMs, nowMs) {
  return lastSuccessMs > 0 && nowMs - lastSuccessMs <= staleMs;
}

/** 店铺今日 KPI：仅以 MySQL 自然日聚合为准 */
function pickStats(mysqlPack) {
  return mysqlPack || { today_orders: 0, today_gmv: 0, latest_order_at: 0 };
}

/**
 * 健康 V3：禁止仅因今日单=0 判同步停滞；0 单默认今日无单。
 * @returns {{ health_status, health_reason, health_rule, latest_sync_status?, latest_sync_success_at? }}
 */
function computeShopHealthV2(shopRow, sync, stats, tokenExpireMs, nowMs) {
  const windowHours = shopStatsWindowHours();
  const status = String(shopRow.status || '').toLowerCase();
  const hidden = shopRow.hidden === 1 || shopRow.hidden === true;
  const syncOn = !(shopRow.sync_enabled === 0 || shopRow.sync_enabled === false);
  const staleSec = apiStaleSeconds();
  const staleMs = staleSec * 1000;
  const todayOrders = Number(stats?.today_orders) || 0;
  const latestOrderMs = Number(stats?.latest_order_at) || 0;
  const orderInWindow = orderInStatsWindow(latestOrderMs, windowHours, nowMs);
  const pid = String(shopRow.platform_shop_id || '').trim().toLowerCase();

  const lastAttemptMs = sync?.lastSyncAtMs || 0;
  const lastSuccessMs = sync?.lastSyncOk && lastAttemptMs > 0 ? lastAttemptMs : 0;
  const syncFresh = syncSuccessWithinThreshold(lastSuccessMs, staleMs, nowMs);
  const errDetail = sync?.lastSyncError ? String(sync.lastSyncError).slice(0, 240) : '';
  const tokenValidDisplay =
    tokenPresentFromRow(shopRow) &&
    !(tokenExpireMs != null && Number.isFinite(tokenExpireMs) && tokenExpireMs <= nowMs);
  const tokenValidFlag = effectiveIsTokenValidForHealth(shopRow);

  if (status === 'disabled') {
    return {
      health_status: 'disabled',
      health_rule: 'disabled',
      health_reason: '店铺已禁用，不参与健康判断',
    };
  }
  if (hidden) {
    return {
      health_status: 'hidden',
      health_rule: 'hidden',
      health_reason: '店铺已隐藏，不参与健康判断',
    };
  }

  if (
    !tokenValidDisplay &&
    tokenExpireMs != null &&
    Number.isFinite(tokenExpireMs) &&
    !hasRecentVerifiedApiSuccess(shopRow, sync, nowMs)
  ) {
    const soon = nowMs + 48 * 3600 * 1000;
    if (tokenExpireMs <= soon) {
      return {
        health_status: 'auth_error',
        health_rule: 'auth_error',
        health_reason:
          tokenExpireMs <= nowMs ? '访问令牌已过期' : '访问令牌即将过期，请重新授权',
        latest_sync_status: 'auth',
      };
    }
  }

  if (!syncOn) {
    return {
      health_status: 'sync_off',
      health_rule: 'sync_off',
      health_reason: '未开启订单同步（sync_enabled=false）',
      latest_sync_status: 'off',
    };
  }

  if (sync && !sync.enabled) {
    return {
      health_status: 'sync_stale',
      health_rule: 'api_stale',
      health_reason: 'OpenAPI 侧店铺未启用，同步 worker 未遍历',
      latest_sync_status: 'off',
    };
  }

  /** 窗口内有单：不因 OpenAPI 时间旧而标「同步停滞」 */
  if (todayOrders > 0) {
    if (!sync) {
      return {
        health_status: 'order_cache_pending',
        health_rule: 'order_recent_cache_pending',
        health_reason: `MySQL 近 ${windowHours}h 有 ${todayOrders} 单，但 OpenAPI 同步列表未覆盖 platform_shop_id=${pid || '?'}（检查 sync_enabled/token/cipher）`,
        latest_sync_status: 'never',
        latest_sync_success_at: formatDt(lastSuccessMs),
      };
    }
    if (!sync.lastSyncOk) {
      const recentFail = lastAttemptMs > 0 && nowMs - lastAttemptMs <= staleMs;
      if (recentFail) {
        const authMapped =
          looksLikeStaleAuthState(shopRow.sync_status, sync?.lastSyncError, tokenValidFlag) &&
          mapSyncErrorToHealthAuth(sync?.lastSyncError);
        if (authMapped && !tokenValidDisplay) {
          return {
            health_status: 'auth_error',
            health_rule: 'auth_error',
            health_reason: authMapped.health_reason,
            latest_sync_status: 'failed',
            latest_sync_success_at: formatDt(lastSuccessMs),
          };
        }
        if (tokenValidDisplay) {
          return {
            health_status: 'normal',
            health_rule: 'normal_with_orders',
            health_reason: `近 ${windowHours}h 内 ${todayOrders} 单；OpenAPI 状态待刷新（token 有效）`,
            latest_sync_status: 'ok',
            latest_sync_success_at: formatDt(lastSuccessMs),
          };
        }
        return {
          health_status: 'sync_stale',
          health_rule: 'sync_failed',
          health_reason: `MySQL 有 ${todayOrders} 单，但 OpenAPI 最近失败：${errDetail || '—'}（${formatDt(lastAttemptMs)}）`,
          latest_sync_status: 'failed',
          latest_sync_success_at: formatDt(lastSuccessMs),
        };
      }
      return {
        health_status: 'order_cache_pending',
        health_rule: 'order_recent_cache_pending',
        health_reason: `MySQL 近 ${windowHours}h 有 ${todayOrders} 单；OpenAPI 末次失败较久，订单由 MySQL 导入`,
        latest_sync_status: 'failed',
        latest_sync_success_at: formatDt(lastSuccessMs),
      };
    }
    if (!syncFresh) {
      return {
        health_status: 'order_cache_pending',
        health_rule: 'order_recent_cache_pending',
        health_reason: `近 ${windowHours}h 内有 ${todayOrders} 单（最新订单 ${formatDt(latestOrderMs)}）；OpenAPI 成功同步较久（${formatDt(lastSuccessMs)}，${diffMinutesLabel(lastSuccessMs, nowMs)}）`,
        latest_sync_status: 'ok',
        latest_sync_success_at: formatDt(lastSuccessMs),
      };
    }
    return {
      health_status: 'normal',
      health_rule: 'normal_with_orders',
      health_reason: `近 ${windowHours}h 内 ${todayOrders} 单，OpenAPI 同步正常`,
      latest_sync_status: 'ok',
      latest_sync_success_at: formatDt(lastSuccessMs),
    };
  }

  if (sync && sync.lastSyncOk && syncFresh) {
    return {
      health_status: 'no_orders_today',
      health_rule: 'no_orders_today',
      health_reason: `近 ${windowHours}h 内无订单，OpenAPI 同步正常（最近成功 ${formatDt(lastSuccessMs)}）`,
      latest_sync_status: 'ok',
      latest_sync_success_at: formatDt(lastSuccessMs),
    };
  }

  if (!sync) {
    return {
      health_status: 'no_orders_today',
      health_rule: 'no_orders_today',
      health_reason: `近 ${windowHours}h 内无订单；OpenAPI 同步未覆盖 platform_shop_id=${pid || '?'}`,
      latest_sync_status: 'never',
    };
  }

  if (sync && !sync.lastSyncOk) {
    const recentFail = lastAttemptMs > 0 && nowMs - lastAttemptMs <= staleMs;
    if (recentFail) {
      const errRaw = sync?.lastSyncError || '';
      const authMapped =
        looksLikeStaleAuthState(shopRow.sync_status, errRaw, tokenValidFlag) &&
        mapSyncErrorToHealthAuth(errRaw);
      if (authMapped && !tokenValidDisplay) {
        return {
          health_status: 'auth_error',
          health_rule: 'auth_error',
          health_reason: authMapped.health_reason,
          latest_sync_status: 'failed',
          latest_sync_success_at: formatDt(lastSuccessMs),
        };
      }
      if (tokenValidDisplay) {
        return {
          health_status: 'no_orders_today',
          health_rule: 'no_orders_today',
          health_reason: `近 ${windowHours}h 无订单；授权有效，OpenAPI 同步待刷新`,
          latest_sync_status: 'idle',
          latest_sync_success_at: formatDt(lastSuccessMs),
        };
      }
      const label = '同步异常';
      return {
        health_status: 'sync_stale',
        health_rule: 'sync_failed',
        health_reason: `${label}：${errDetail || errRaw || '订单接口读取失败'}（${formatDt(lastAttemptMs)}）`,
        latest_sync_status: 'failed',
        latest_sync_success_at: formatDt(lastSuccessMs),
      };
    }
    return {
      health_status: 'no_orders_today',
      health_rule: 'no_orders_today',
      health_reason: `近 ${windowHours}h 无订单；OpenAPI 末次失败 ${formatDt(lastAttemptMs) || '—'}`,
      latest_sync_status: 'failed',
      latest_sync_success_at: formatDt(lastSuccessMs),
    };
  }

  if (sync && sync.lastSyncOk && !syncFresh) {
    if (tokenValidDisplay) {
      return {
        health_status: 'no_orders_today',
        health_rule: 'no_orders_today',
        health_reason: `近 ${windowHours}h 无订单；授权有效（OpenAPI 成功较久 ${formatDt(lastSuccessMs)}）`,
        latest_sync_status: 'ok',
        latest_sync_success_at: formatDt(lastSuccessMs),
      };
    }
    return {
      health_status: 'sync_stale',
      health_rule: 'sync_stale_no_success',
      health_reason: `${staleApiMessage(staleSec)}；近 ${windowHours}h 无订单；最近成功 OpenAPI ${formatDt(lastSuccessMs)}`,
      latest_sync_status: 'ok',
      latest_sync_success_at: formatDt(lastSuccessMs),
    };
  }

  return {
    health_status: 'sync_stale',
    health_rule: 'sync_stale_no_success',
    health_reason: `${staleApiMessage(staleSec)}；近 ${windowHours}h 无订单；${errDetail || 'OpenAPI 长时间无成功同步'}`,
    latest_sync_status: 'failed',
    latest_sync_success_at: formatDt(lastSuccessMs),
  };
}

function diffMinutesLabel(lastMs, nowMs) {
  if (!lastMs) return '无成功同步记录';
  const m = Math.floor((nowMs - lastMs) / 60000);
  return `约 ${m} 分钟前`;
}

function buildShopHealthDebug(shop, sync, stats, health, tokenExpireMs, nowMs) {
  const staleSec = apiStaleSeconds();
  const staleMs = staleSec * 1000;
  const lastAttemptMs = sync?.lastSyncAtMs || 0;
  const lastSuccessMs = sync?.lastSyncOk && lastAttemptMs > 0 ? lastAttemptMs : 0;
  return {
    shop_id: shop.id,
    shop_name: shop.shop_name,
    market: shop.market,
    status: shop.status,
    hidden: shop.hidden === 1 || shop.hidden === true,
    sync_enabled: !(shop.sync_enabled === 0 || shop.sync_enabled === false),
    platform_shop_id: shop.platform_shop_id,
    today_orders: Number(stats?.today_orders) || 0,
    today_gmv: Number(stats?.today_gmv) || 0,
    latest_order_at: formatDt(stats?.latest_order_at),
    latest_sync_success_at: formatDt(lastSuccessMs),
    latest_sync_attempt_at: formatDt(lastAttemptMs),
    latest_sync_status: health.latest_sync_status || (sync?.lastSyncOk ? 'ok' : sync ? 'failed' : 'never'),
    last_sync_error: sync?.lastSyncError ? String(sync.lastSyncError).slice(0, 500) : null,
    api_stale_seconds: staleSec,
    diff_minutes: lastSuccessMs > 0 ? Math.floor((nowMs - lastSuccessMs) / 60000) : null,
    openapi_in_shops_json: Boolean(sync),
    openapi_last_sync_ok: sync?.lastSyncOk === true,
    health_status: health.health_status,
    health_reason: health.health_reason,
    health_rule: health.health_rule,
    now: formatDt(nowMs),
    stats_window_hours: shopStatsWindowHours(),
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number | null} tenantId
 * @param {object[]} shopRows
 */
async function enrichShopRows(pool, tenantId, shopRows) {
  const windowHours = shopStatsWindowHours();
  const nowMs = Date.now();
  const syncByPlatformId = await loadOpenApiSyncStateByPlatformShopIdAsync();

  let mysqlAgg = { byShopId: new Map(), byPlatformId: new Map() };
  let statsSource = 'mysql_orders_intraday';
  try {
    if (pool) {
      mysqlAgg = await aggregateTodayStatsByShopId(pool, tenantId);
    } else {
      statsSource = 'unavailable';
    }
  } catch (e) {
    statsSource = 'unavailable';
    console.warn('[shop-live-stats] mysql today aggregate failed:', e?.message || e);
  }

  const shopIds = (Array.isArray(shopRows) ? shopRows : []).map((s) => Number(s.id)).filter(Boolean);
  const authByShopId =
    pool && Number.isFinite(Number(tenantId))
      ? await loadAuthContractByShopId(pool, Number(tenantId), shopIds)
      : new Map();

  const out = [];
  for (const shop of Array.isArray(shopRows) ? shopRows : []) {
    const pid = String(shop.platform_shop_id || '').trim().toLowerCase();
    const sid = Number(shop.id);
    let mysqlPack = Number.isFinite(sid)
      ? mysqlAgg.byShopId.get(sid) || (pid ? mysqlAgg.byPlatformId.get(pid) : null)
      : pid
        ? mysqlAgg.byPlatformId.get(pid)
        : null;
    if ((!mysqlPack || mysqlPack.today_orders === 0) && pool) {
      try {
        const direct = await fetchTodayStatsForShopRow(pool, shop, tenantId);
        if (direct && (direct.today_orders > 0 || direct.latest_order_at > 0)) {
          mysqlPack = direct;
        }
      } catch (e) {
        console.warn('[shop-live-stats] per-shop fallback failed:', shop.id, e?.message || e);
      }
    }
    let sync = pid ? syncByPlatformId.get(pid) : null;
    const rowSuccessMs = shop.last_success_sync_at
      ? dayjs(shop.last_success_sync_at).valueOf()
      : 0;
    if (rowSuccessMs > 0) {
      const base = sync || {
        lastSyncAtMs: 0,
        lastSyncOk: false,
        lastSyncError: '',
        enabled: shop.sync_enabled !== 0,
      };
      sync = {
        ...base,
        lastSyncAtMs: Math.max(base.lastSyncAtMs || 0, rowSuccessMs),
        lastSyncOk: base.lastSyncOk || rowSuccessMs > 0,
        lastSyncError: base.lastSyncOk ? base.lastSyncError : '',
      };
    }
    const authPack = authByShopId.get(Number(shop.id)) || {};
    const shopForHealth = { ...shop, ...authPack };
    const stats = applyTrustedTodayKpi(pickStats(mysqlPack), shopForHealth, sync);
    const tokenExpireMs = authPack.token_expire_at
      ? new Date(authPack.token_expire_at).getTime()
      : null;
    const health = computeShopHealthV2(shopForHealth, sync, stats, tokenExpireMs, nowMs);

    const latestOrderMs = stats.latest_order_at || 0;
    const lastSuccessMs = sync?.lastSyncOk && sync.lastSyncAtMs ? sync.lastSyncAtMs : 0;
    const displaySyncMs = Math.max(lastSuccessMs, latestOrderMs);

    const debug = buildShopHealthDebug(shop, sync, stats, health, tokenExpireMs, nowMs);

    const row = {
      ...shopForHealth,
      shop_id: shop.id,
      today_orders: stats.today_orders,
      today_gmv: stats.today_gmv,
      last_order_count: stats.today_orders,
      last_gmv_amount: stats.today_gmv,
      latest_order_at: formatDt(latestOrderMs),
      latest_sync_success_at: health.latest_sync_success_at || formatDt(lastSuccessMs),
      latest_sync_attempt_at: debug.latest_sync_attempt_at,
      latest_sync_status: debug.latest_sync_status,
      last_sync_error: debug.last_sync_error,
      api_stale_seconds: debug.api_stale_seconds,
      diff_minutes: debug.diff_minutes,
      health_rule: health.health_rule,
      last_sync_at: formatDt(displaySyncMs) || shop.last_sync_at,
      last_order_seen_at: formatDt(latestOrderMs) || shop.last_order_seen_at,
      last_health_status: health.health_status,
      last_health_message: health.health_reason,
      health_status: health.health_status,
      health_reason: health.health_reason,
      health_debug: {
        ...debug,
        stats_lookup: mysqlPack
          ? {
              via: 'mysql',
              today_orders: stats.today_orders,
              today_gmv: stats.today_gmv,
            }
          : { via: 'none' },
      },
      stats_window_hours: windowHours,
      stats_date_window: 'dashboard_today_contract',
      stats_source: statsSource,
      kpi_trusted: stats.kpi_trusted !== false,
      kpi_untrusted_reason: stats.kpi_untrusted_reason || null,
    };

    out.push(applyShopListDisplayContract(row));
  }

  return { shops: out, windowHours, statsSource };
}

/**
 * GET /api/shops 列表：按租户批量附加今日 KPI（MySQL CURDATE，不读 snapshot/cache）
 * @param {import('mysql2/promise').Pool} pool
 * @param {object[]} list
 */
async function enrichShopsListWithTodayStats(pool, list) {
  if (!pool || !Array.isArray(list) || !list.length) return list;
  const byTenant = new Map();
  for (const row of list) {
    const tid = Number(row.tenant_id);
    if (!Number.isFinite(tid)) continue;
    if (!byTenant.has(tid)) byTenant.set(tid, []);
    byTenant.get(tid).push(row);
  }
  const enrichedById = new Map();
  for (const [tid, rows] of byTenant) {
    const { shops } = await enrichShopRows(pool, tid, rows);
    for (const s of shops) enrichedById.set(Number(s.id), s);
  }
  return list.map((row) => enrichedById.get(Number(row.id)) || row);
}

module.exports = {
  enrichShopRows,
  enrichShopsListWithTodayStats,
  shopStatsWindowHours,
  computeShopHealthV2,
};
