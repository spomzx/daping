'use strict';

/**
 * 与 Authorizations 一致的 token 口径（shop_auth_tokens 为准）
 */

const TOKEN_RANK = { active: 3, expired: 2, missing: 1 };

function tokenRank(status) {
  return TOKEN_RANK[String(status || '').toLowerCase()] || 0;
}

function parseJsonField(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return {};
  }
}

function extractShopCipher(rawAuth) {
  const raw = rawAuth && typeof rawAuth === 'object' ? rawAuth : parseJsonField(rawAuth);
  return String(raw.shop_cipher || raw.shopCipher || '').trim();
}

/**
 * @param {Record<string, unknown>} row
 */
function computeHasShopCipher(row) {
  return extractShopCipher(row.raw_auth_json) ? 1 : 0;
}

/**
 * @param {Record<string, unknown>} row
 */
function normalizeTokenStatus(row) {
  const hasToken = row.has_token === 1 || row.has_token === true;
  const access = String(row.access_token || '').trim();
  if (!hasToken && !access) return 'missing';

  const exp = row.token_expire_at;
  if (exp) {
    const t = new Date(exp).getTime();
    if (Number.isFinite(t) && t < Date.now()) return 'expired';
  }

  const ts = String(row.token_status || '').toLowerCase();
  if (ts === 'expired') return 'expired';
  if (ts === 'missing' && !access) return 'missing';
  if (access || hasToken) return 'active';
  return 'missing';
}

/**
 * @param {string} tokenStatus
 */
function mapAuthErrorLabelByToken(tokenStatus) {
  const ts = String(tokenStatus || '').toLowerCase();
  if (ts === 'active') return '授权正常';
  if (ts === 'expired') return '授权已过期';
  if (ts === 'missing') return '缺少授权 Token';
  return '授权异常';
}

/**
 * @param {string} tokenStatus
 */
function mapAuthStatusLabelByToken(tokenStatus) {
  const ts = String(tokenStatus || '').toLowerCase();
  if (ts === 'active') return '授权正常';
  if (ts === 'expired') return '授权失效';
  if (ts === 'missing') return '未授权';
  return '授权异常';
}

const LEGACY_DIAG_RE =
  /shops\.json|orders-cache|gmv-cache|cache\s*fallback|missing_platform_shop_id|platform_shop_id\s*=\s*\?/i;

function isAuthRawMessage(msg) {
  if (!msg) return false;
  const s = String(msg).trim().toLowerCase();
  if (!s) return false;
  if (LEGACY_DIAG_RE.test(s)) return false;
  return (
    s.includes('token') ||
    s.includes('auth') ||
    s.includes('授权') ||
    s.includes('令牌') ||
    s.includes('cipher') ||
    s === 'missing' ||
    s === 'token_missing' ||
    s === 'auth_error'
  );
}

/**
 * token=active 时：仅同步运行类错误，禁止 auth 类文案
 * @param {Record<string, unknown>} row
 */
function mapSyncOperationalErrorLabel(row) {
  const health = String(row.last_health_status || '').toLowerCase();
  const logStatus = String(row.last_log_status || '').toLowerCase();
  const rawKey = String(row.last_error || row.last_health_message || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

  if (health === 'rate_limited' || rawKey === 'rate_limited' || rawKey.includes('rate_limit')) {
    return '同步频率过高，请稍后重试';
  }
  if (logStatus === 'running' || health === 'running') return '同步中';
  if (logStatus === 'failed' || health === 'sync_error' || health === 'sync_stale') {
    return '异常';
  }

  const raw = String(row.last_error || row.last_health_message || '').trim();
  if (raw && !isAuthRawMessage(raw) && !LEGACY_DIAG_RE.test(raw)) {
    return raw.slice(0, 240);
  }

  const orders = Number(row.today_orders_count || 0);
  return orders > 0 ? '同步正常' : '近24h无订单';
}

/**
 * @param {Record<string, unknown>} row
 */
function mapSyncOperationalStatusLabel(row) {
  const health = String(row.last_health_status || '').toLowerCase();
  const logStatus = String(row.last_log_status || '').toLowerCase();
  const orders = Number(row.today_orders_count || 0);

  if (logStatus === 'running' || health === 'running') return '同步中';
  if (health === 'rate_limited' || String(row.last_error || '').includes('rate_limit')) {
    return '限流中';
  }
  if (logStatus === 'failed' || health === 'sync_error' || health === 'sync_stale') {
    return '异常';
  }
  if (logStatus === 'success' || health === 'normal') {
    return orders > 0 ? '同步正常' : '近24h无订单';
  }
  return orders > 0 ? '同步正常' : '近24h无订单';
}

/**
 * SQL 片段：按 tenant + shop / platform_shop_id 解析最优 token（active > expired > missing）
 */
function sqlBestAuthTokenJoin(shopAlias = 's', tokenAlias = 't') {
  return `
    LEFT JOIN shop_auth_tokens ${tokenAlias} ON ${tokenAlias}.id = (
      SELECT t2.id FROM shop_auth_tokens t2
      INNER JOIN shops s_t ON s_t.id = t2.shop_id AND s_t.tenant_id = t2.tenant_id
      WHERE t2.tenant_id = ${shopAlias}.tenant_id
        AND (
          t2.shop_id = ${shopAlias}.id
          OR (
            TRIM(COALESCE(${shopAlias}.platform_shop_id, '')) <> ''
            AND LOWER(TRIM(s_t.platform_shop_id)) = LOWER(TRIM(${shopAlias}.platform_shop_id))
          )
        )
      ORDER BY
        CASE
          WHEN t2.access_token IS NOT NULL AND TRIM(t2.access_token) <> ''
               AND (t2.token_expire_at IS NULL OR t2.token_expire_at >= NOW(3)) THEN 0
          WHEN t2.access_token IS NOT NULL AND TRIM(t2.access_token) <> ''
               AND t2.token_expire_at IS NOT NULL AND t2.token_expire_at < NOW(3) THEN 1
          ELSE 2
        END ASC,
        t2.updated_at DESC,
        t2.id DESC
      LIMIT 1
    )`;
}

module.exports = {
  TOKEN_RANK,
  tokenRank,
  normalizeTokenStatus,
  mapAuthErrorLabelByToken,
  mapAuthStatusLabelByToken,
  mapSyncOperationalErrorLabel,
  mapSyncOperationalStatusLabel,
  computeHasShopCipher,
  extractShopCipher,
  sqlBestAuthTokenJoin,
  isAuthRawMessage,
};
