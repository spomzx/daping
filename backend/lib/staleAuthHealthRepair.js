'use strict';

/**
 * API 已验证成功时，清理历史 token_expired / Invalid credentials 等陈旧状态
 */

const dayjs = require('dayjs');
const { patchShopSyncStatus } = require('../sync/services/shopSyncStatusService');
const { normalizeTokenStatus } = require('./shopTokenStatus');
const { classifyTikTokAuthError } = require('./shopAuthErrorClassifier');

const STALE_AUTH_SYNC_STATUSES = new Set(['token_expired', 'disabled']);
const STALE_AUTH_ERROR_MARKERS = [
  'invalid credential',
  'invalid credentials',
  'token_expired',
  'unauthorized',
  'refresh_http_401',
  'refresh_http_403',
  'shop_cipher_missing',
];

/**
 * @param {string} msg
 */
function isStaleAuthErrorText(msg) {
  const s = String(msg || '').toLowerCase();
  if (!s) return false;
  return STALE_AUTH_ERROR_MARKERS.some((m) => s.includes(m));
}

/**
 * @param {string} syncStatus
 * @param {string} lastError
 * @param {number} isTokenValid
 */
function looksLikeStaleAuthState(syncStatus, lastError, isTokenValid) {
  const st = String(syncStatus || '').toLowerCase();
  if (STALE_AUTH_SYNC_STATUSES.has(st)) return true;
  if (isTokenValid === 0 || isTokenValid === false) return true;
  return isStaleAuthErrorText(lastError);
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ tenantId: number, shopId: number, orderCount?: number, source?: string }} p
 */
async function applyApiVerifiedHealthyState(pool, p) {
  const tenantId = Number(p.tenantId);
  const shopId = Number(p.shopId);
  const orderCount = Math.max(0, Number(p.orderCount) || 0);
  const healthStatus = orderCount > 0 ? 'normal' : 'no_orders_today';
  const syncStatus = orderCount > 0 ? 'success' : 'idle';
  const now = new Date();

  await patchShopSyncStatus(pool, tenantId, shopId, 'tiktok', {
    sync_status: syncStatus,
    last_sync_at: now,
    last_success_sync_at: now,
    last_error: null,
    last_error_code: null,
    sync_fail_count: 0,
    is_token_valid: 1,
    token_expired_at: null,
  });

  await pool.execute(
    `UPDATE shops SET
       auth_status = 'authorized',
       last_health_status = ?,
       last_health_message = NULL,
       last_health_fail_count = 0,
       last_sync_at = CURRENT_TIMESTAMP(3),
       updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND tenant_id = ?`,
    [healthStatus, shopId, tenantId],
  );

  return {
    shop_id: shopId,
    tenant_id: tenantId,
    health_status: healthStatus,
    sync_status: syncStatus,
    order_count: orderCount,
    source: p.source || 'api_verified',
    cleared_stale_auth: true,
    at: dayjs().format('YYYY-MM-DD HH:mm:ss'),
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 */
async function listShopsWithStaleAuthDisplay(pool, tenantId) {
  const [rows] = await pool.query(
    `SELECT s.id AS shop_id, s.tenant_id, s.shop_name, s.display_name, s.market, s.region, s.status,
            s.sync_enabled, s.last_health_status, s.last_health_message,
            ss.sync_status, ss.sync_fail_count, ss.last_error, ss.last_success_sync_at,
            ss.is_token_valid, ss.last_error_code,
            t.access_token, t.refresh_token, t.token_expire_at, t.raw_auth_json
     FROM shops s
     LEFT JOIN shop_sync_status ss ON ss.shop_id = s.id AND ss.tenant_id = s.tenant_id AND ss.platform = s.platform
     LEFT JOIN shop_auth_tokens t ON t.id = (
       SELECT t2.id FROM shop_auth_tokens t2 WHERE t2.shop_id = s.id ORDER BY t2.id DESC LIMIT 1
     )
     WHERE s.tenant_id = ? AND s.platform = 'tiktok' AND s.status = 'active'
       AND (s.hidden = 0 OR s.hidden IS NULL)`,
    [tenantId],
  );

  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const tokenStatus = normalizeTokenStatus(r);
    const stale =
      String(r.last_health_status || '').toLowerCase() === 'auth_error' ||
      looksLikeStaleAuthState(r.sync_status, r.last_error || r.last_health_message, r.is_token_valid);

    if (!stale) continue;

    const errText = String(r.last_error || r.last_health_message || '').trim();
    out.push({
      shop_id: Number(r.shop_id),
      shop_name: String(r.display_name || r.shop_name || '').trim(),
      market: String(r.market || r.region || '').trim().toUpperCase(),
      sync_status: r.sync_status || null,
      sync_fail_count: Number(r.sync_fail_count) || 0,
      last_error: r.last_error || null,
      last_error_full: errText || null,
      health_status: r.last_health_status || null,
      health_reason: r.last_health_message || null,
      is_token_valid: r.is_token_valid,
      token_status_computed: tokenStatus,
      last_api_ok_at: r.last_success_sync_at
        ? dayjs(r.last_success_sync_at).format('YYYY-MM-DD HH:mm:ss')
        : null,
      last_error_code: r.last_error_code || null,
    });
  }
  return out;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ tenantId: number, verifyApi?: boolean, dateYmd?: string }} opts
 */
async function repairStaleAuthHealthForTenant(pool, opts) {
  const tenantId = Number(opts.tenantId);
  const staleList = await listShopsWithStaleAuthDisplay(pool, tenantId);
  const repaired = [];
  const stillBad = [];
  const needReauth = [];

  const { fetchOrdersInTimeRange } = require('../tiktok-api/orders');
  const { ensureShopAccessTokenFresh } = require('./tiktokTokenRefresh');

  for (const row of staleList) {
    const shopId = row.shop_id;
    const [shopRows] = await pool.query(
      `SELECT s.id, s.tenant_id, s.platform_shop_id, s.shop_name, s.display_name, s.market, s.region, s.status, s.sync_enabled,
              t.access_token, t.refresh_token, t.token_expire_at, t.raw_auth_json
       FROM shops s
       LEFT JOIN shop_auth_tokens t ON t.id = (
         SELECT t2.id FROM shop_auth_tokens t2 WHERE t2.shop_id = s.id ORDER BY t2.id DESC LIMIT 1
       )
       WHERE s.id = ? AND s.tenant_id = ? LIMIT 1`,
      [shopId, tenantId],
    );
    const sr = shopRows?.[0];
    if (!sr) {
      stillBad.push({ ...row, reason: 'shop_not_found' });
      continue;
    }

    const raw = typeof sr.raw_auth_json === 'object' ? sr.raw_auth_json : JSON.parse(String(sr.raw_auth_json || '{}'));
    const shop = {
      internal_shop_id: shopId,
      shop_id: shopId,
      tenant_id: tenantId,
      platform_shop_id: String(sr.platform_shop_id || '').trim(),
      shop_name: String(sr.display_name || sr.shop_name || '').trim(),
      market: String(sr.market || sr.region || 'TH').trim().toUpperCase(),
      shop_cipher: String(raw.shop_cipher || raw.shopCipher || '').trim(),
      shopCipher: String(raw.shop_cipher || raw.shopCipher || '').trim(),
      access_token: String(sr.access_token || '').trim(),
      accessToken: String(sr.access_token || '').trim(),
      refresh_token: String(sr.refresh_token || '').trim(),
      accessTokenExpiresAt: sr.token_expire_at ? dayjs(sr.token_expire_at).toISOString() : '',
    };

    let tokenRefreshResult = { ok: true, refreshed: false, category: 'skipped' };
    if (opts.verifyApi !== false) {
      const tr = await ensureShopAccessTokenFresh(
        {
          internal_shop_id: shopId,
          refreshToken: shop.refresh_token,
          accessToken: shop.access_token,
          accessTokenExpiresAt: sr.token_expire_at,
        },
        { skewMs: 48 * 3600 * 1000 },
      );
      tokenRefreshResult = {
        ok: tr.ok,
        refreshed: tr.refreshed === true,
        category: tr.category || null,
        userLabel: tr.userLabel || null,
        fullMessage: tr.fullMessage || null,
      };
      if (!tr.ok) {
        const authClass = classifyTikTokAuthError(tr.fullMessage || tr.userLabel || '');
        needReauth.push({
          ...row,
          token_refresh_result: tokenRefreshResult,
          reason: authClass.category,
        });
        continue;
      }
      if (tr.ok && tr.shop) {
        shop.accessToken = tr.shop.accessToken || shop.accessToken;
        shop.shopCipher = tr.shop.shop_cipher || shop.shopCipher;
      }

      const apiRet = await fetchOrdersInTimeRange(shop, {
        dateYmd: opts.dateYmd || dayjs().format('YYYY-MM-DD'),
        logPrefix: `[repair-stale-auth:${shopId}]`,
        deadlineMs: Date.now() + 90000,
      });

      if (!apiRet.ok) {
        stillBad.push({
          ...row,
          token_refresh_result: tokenRefreshResult,
          api_ok: false,
          api_error: apiRet.error?.message || apiRet.debug?.responseMessage,
        });
        continue;
      }

      const orderCount = Array.isArray(apiRet.data) ? apiRet.data.length : 0;
      const fix = await applyApiVerifiedHealthyState(pool, {
        tenantId,
        shopId,
        orderCount,
        source: 'repair_stale_auth_health',
      });
      repaired.push({
        ...row,
        token_refresh_result: tokenRefreshResult,
        api_ok: true,
        api_orders_count: orderCount,
        repair: fix,
        sync_status_after: fix.sync_status,
        health_status_after: fix.health_status,
      });
      continue;
    }

    const fix = await applyApiVerifiedHealthyState(pool, {
      tenantId,
      shopId,
      orderCount: 0,
      source: 'repair_stale_auth_health_force',
    });
    repaired.push({ ...row, repair: fix, forced: true });
  }

  return {
    tenant_id: tenantId,
    stale_count: staleList.length,
    stale_shops: staleList,
    repaired_count: repaired.length,
    repaired,
    still_bad: stillBad,
    need_reauthorize: needReauth,
  };
}

/**
 * 列表 API 展示：健康正常时覆盖陈旧 sync/token 字段（不写库）
 * @param {Record<string, unknown>} row
 */
function sanitizeShopRowStaleAuthDisplay(row) {
  const health = String(row.health_status || row.last_health_status || '').toLowerCase();
  if (health !== 'normal' && health !== 'no_orders_today') return row;

  const orders = Number(row.today_orders ?? row.last_order_count ?? 0) || 0;
  const next = { ...row };
  if (looksLikeStaleAuthState(next.sync_status, next.last_error, next.is_token_valid)) {
    next.sync_status = orders > 0 ? 'success' : 'idle';
    next.is_token_valid = 1;
    next.last_error = null;
    next.last_error_full = null;
    next.last_error_code = null;
    next.queue_sync_status = next.sync_status;
  }
  return next;
}

module.exports = {
  isStaleAuthErrorText,
  looksLikeStaleAuthState,
  applyApiVerifiedHealthyState,
  listShopsWithStaleAuthDisplay,
  repairStaleAuthHealthForTenant,
  sanitizeShopRowStaleAuthDisplay,
};
