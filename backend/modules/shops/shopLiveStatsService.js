'use strict';

const dayjs = require('dayjs');
const { orderAnalyticsEventTimeExpr } = require('../../lib/analyticsFilter');
const {
  apiStaleSeconds,
  loadOpenApiSyncStateByPlatformShopIdAsync,
} = require('./shopHealthService');
const { getCreateEpochSec, dedupeOrdersByOrderId } = require('../../tiktok-api/ordersDashboardFromCache');

/** 与数据分析页默认 24h 滚动窗口一致 */
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

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number | null} tenantId null = 全平台
 * @param {number} windowHours
 */
async function aggregateMysqlStatsByShopId(pool, tenantId, windowHours) {
  const evt = orderAnalyticsEventTimeExpr('o');
  const hours = windowHours;
  const params = [hours];
  let tenantClause = '';
  if (tenantId != null && Number.isFinite(Number(tenantId))) {
    tenantClause = ' AND o.tenant_id = ? ';
    params.push(Number(tenantId));
  }

  const sql = `
    SELECT
      s.id AS shop_id,
      LOWER(TRIM(s.platform_shop_id)) AS platform_shop_id,
      COUNT(DISTINCT CONCAT(o.platform, ':', o.platform_order_id)) AS today_orders,
      COALESCE(SUM(o.total_amount), 0) AS today_gmv,
      MAX(${evt}) AS latest_order_at
    FROM orders o
    INNER JOIN shops s ON s.id = o.shop_id
    WHERE ${evt} IS NOT NULL
      AND ${evt} >= DATE_SUB(NOW(3), INTERVAL ? HOUR)
      ${tenantClause}
    GROUP BY s.id, LOWER(TRIM(s.platform_shop_id))
  `;

  const [rows] = await pool.query(sql, params);
  const byShopId = new Map();
  const byPlatformId = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const sid = Number(r.shop_id);
    const pid = String(r.platform_shop_id || '').trim().toLowerCase();
    const pack = {
      today_orders: Number(r.today_orders) || 0,
      today_gmv: Number(Number(r.today_gmv).toFixed(4)) || 0,
      latest_order_at: r.latest_order_at ? new Date(r.latest_order_at).getTime() : 0,
    };
    if (Number.isFinite(sid)) byShopId.set(sid, pack);
    if (pid) byPlatformId.set(pid, pack);
  }
  return { byShopId, byPlatformId };
}

/**
 * 单店兜底：聚合未命中时按 shop_id / platform_shop_id / 店名+市场 再查一次（禁止 IN 子查询占位符拼接错误）
 */
async function fetchMysqlStatsForShopRow(pool, shop, tenantId, windowHours) {
  if (!pool || !shop) return null;

  const evt = orderAnalyticsEventTimeExpr('o');
  const params = [windowHours];
  const whereParts = [
    `${evt} IS NOT NULL`,
    `${evt} >= DATE_SUB(NOW(3), INTERVAL ? HOUR)`,
  ];

  if (tenantId != null && Number.isFinite(Number(tenantId))) {
    whereParts.push('o.tenant_id = ?');
    params.push(Number(tenantId));
  }

  const sid = Number(shop.id);
  const pid = String(shop.platform_shop_id || '').trim().toLowerCase();
  const orParts = [];

  if (Number.isFinite(sid) && sid > 0) {
    orParts.push('o.shop_id = ?');
    params.push(sid);
  }

  if (pid) {
    orParts.push(`LOWER(TRIM(COALESCE(o.platform_shop_id, ''))) = ?`);
    params.push(pid);
    orParts.push(
      `EXISTS (SELECT 1 FROM shops s2 WHERE s2.id = o.shop_id AND LOWER(TRIM(COALESCE(s2.platform_shop_id, ''))) = ?)`,
    );
    params.push(pid);
  }

  const shopName = String(shop.shop_name || shop.display_name || '').trim().toLowerCase();
  const market = String(shop.market || shop.region || '').trim().toUpperCase();
  if (shopName && market) {
    orParts.push(
      `(LOWER(TRIM(COALESCE(o.shop_name, ''))) = ? AND UPPER(TRIM(COALESCE(o.market, ''))) = ?)`,
    );
    params.push(shopName, market);
  }

  if (orParts.length === 0) return null;

  const [rows] = await pool.query(
    `
    SELECT
      COUNT(DISTINCT CONCAT(o.platform, ':', o.platform_order_id)) AS today_orders,
      COALESCE(SUM(o.total_amount), 0) AS today_gmv,
      MAX(${evt}) AS latest_order_at
    FROM orders o
    WHERE ${whereParts.join(' AND ')}
      AND (${orParts.join(' OR ')})
    `,
    params,
  );
  const r = rows && rows[0] ? rows[0] : null;
  if (!r) return null;
  return {
    today_orders: Number(r.today_orders) || 0,
    today_gmv: Number(Number(r.today_gmv).toFixed(4)) || 0,
    latest_order_at: r.latest_order_at ? new Date(r.latest_order_at).getTime() : 0,
  };
}

function aggregateCacheByPlatformShopId(ordersPack, windowHours) {
  const orders = ordersPack && Array.isArray(ordersPack.orders) ? ordersPack.orders : [];
  const cutoffSec = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const inWindow = orders.filter((o) => {
    const ep = getCreateEpochSec(o);
    return ep >= cutoffSec;
  });
  const { orders: deduped } = dedupeOrdersByOrderId(inWindow);
  const map = new Map();
  for (const o of deduped) {
    const pid = String(o.shopId ?? o.shop_id ?? '').trim().toLowerCase();
    if (!pid) continue;
    const amt = Number(o.orderAmountBase ?? o.totalAmount ?? 0) || 0;
    let g = map.get(pid);
    if (!g) g = { todayCount: 0, todayGmv: 0, lastEp: 0 };
    const ep = getCreateEpochSec(o);
    if (ep > g.lastEp) g.lastEp = ep;
    g.todayCount += 1;
    g.todayGmv += Number.isFinite(amt) ? amt : 0;
    map.set(pid, g);
  }
  return map;
}

function mergeCacheStats(cacheAgg, platformShopId) {
  const pid = String(platformShopId || '').trim().toLowerCase();
  const g = pid ? cacheAgg.get(pid) : null;
  if (!g) return null;
  return {
    today_orders: g.todayCount,
    today_gmv: Number(Number(g.todayGmv).toFixed(4)) || 0,
    latest_order_at: g.lastEp > 0 ? g.lastEp * 1000 : 0,
  };
}

/** 店铺健康/今日单：仅以 MySQL 为准，cache 不参与 */
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

  if (tokenExpireMs != null && Number.isFinite(tokenExpireMs)) {
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
      return {
        health_status: 'sync_stale',
        health_rule: 'sync_failed',
        health_reason: `近 ${windowHours}h 无订单；OpenAPI 最近失败：${errDetail || '—'}（${formatDt(lastAttemptMs)}）`,
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
  let statsSource = 'mysql';
  try {
    if (pool) {
      mysqlAgg = await aggregateMysqlStatsByShopId(pool, tenantId, windowHours);
    } else {
      statsSource = 'unavailable';
    }
  } catch (e) {
    statsSource = 'unavailable';
    console.warn('[shop-live-stats] mysql aggregate failed:', e?.message || e);
  }

  const shopIds = (Array.isArray(shopRows) ? shopRows : []).map((s) => Number(s.id)).filter(Boolean);
  const tokenByShopId = new Map();
  if (pool && shopIds.length > 0) {
    const ph = shopIds.map(() => '?').join(',');
    const [tokRows] = await pool.query(
      `SELECT shop_id, token_expire_at FROM shop_auth_tokens WHERE shop_id IN (${ph})`,
      shopIds,
    );
    for (const r of Array.isArray(tokRows) ? tokRows : []) {
      const sid = Number(r.shop_id);
      if (!Number.isFinite(sid)) continue;
      tokenByShopId.set(sid, r.token_expire_at ? new Date(r.token_expire_at).getTime() : null);
    }
  }

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
        const direct = await fetchMysqlStatsForShopRow(pool, shop, tenantId, windowHours);
        if (direct && (direct.today_orders > 0 || direct.latest_order_at > 0)) {
          mysqlPack = direct;
        }
      } catch (e) {
        console.warn('[shop-live-stats] per-shop fallback failed:', shop.id, e?.message || e);
      }
    }
    const stats = pickStats(mysqlPack);

    const sync = pid ? syncByPlatformId.get(pid) : null;
    const tokenExpireMs = tokenByShopId.get(Number(shop.id)) ?? null;
    const health = computeShopHealthV2(shop, sync, stats, tokenExpireMs, nowMs);

    const latestOrderMs = stats.latest_order_at || 0;
    const lastSuccessMs = sync?.lastSyncOk && sync.lastSyncAtMs ? sync.lastSyncAtMs : 0;
    const displaySyncMs = Math.max(lastSuccessMs, latestOrderMs);

    const debug = buildShopHealthDebug(shop, sync, stats, health, tokenExpireMs, nowMs);

    const row = {
      ...shop,
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
      stats_source: statsSource,
    };

    out.push(row);
  }

  return { shops: out, windowHours, statsSource };
}

module.exports = {
  enrichShopRows,
  shopStatsWindowHours,
  computeShopHealthV2,
};
