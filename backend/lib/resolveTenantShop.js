'use strict';

const { sqlBestAuthTokenJoin, tokenRank, normalizeTokenStatus } = require('./shopTokenStatus');

/**
 * 从 JWT / req.auth 解析当前登录租户（SaaS 接口唯一 tenant 来源）
 * @param {{ tenant_id?: number }|null|undefined} auth
 */
function authTenantId(auth) {
  const tid = Number(auth?.tenant_id);
  return Number.isFinite(tid) && tid > 0 ? tid : null;
}

/**
 * 平台 scope 不再跨 tenant 拉 shops；强制绑定 auth.tenant_id
 * @param {import('./dataScope').UserDataScope} scope
 * @param {{ tenant_id?: number }|null|undefined} auth
 */
function enforceAuthTenantScope(scope, auth, effectiveTenantId) {
  const tid =
    effectiveTenantId != null && Number.isFinite(Number(effectiveTenantId)) && Number(effectiveTenantId) > 0
      ? Number(effectiveTenantId)
      : authTenantId(auth);
  if (!scope || scope.mode === 'none') {
    return { mode: 'none', tenantId: tid, userId: scope?.userId ?? null, role: scope?.role ?? '', shopIds: null };
  }
  if (tid == null) {
    return { mode: 'none', tenantId: null, userId: scope.userId, role: scope.role, shopIds: null };
  }
  if (scope.mode === 'platform') {
    return {
      mode: 'tenant_all',
      tenantId: tid,
      userId: scope.userId,
      role: scope.role,
      shopIds: null,
    };
  }
  return { ...scope, tenantId: tid };
}

/** Analytics / dashboard：禁止 skipTenant / allTenants */
function strictAnalyticsFilterOpts() {
  return { skipTenant: false, allTenantShops: false };
}

function pickBetterShopRow(a, b) {
  const na = normalizeTokenStatus(a);
  const nb = normalizeTokenStatus(b);
  const ra = tokenRank(na);
  const rb = tokenRank(nb);
  if (ra !== rb) return ra > rb ? a : b;

  const stA = String(a.shop_status || a.status || 'active').toLowerCase();
  const stB = String(b.shop_status || b.status || 'active').toLowerCase();
  if (stA === 'deleted' && stB !== 'deleted') return b;
  if (stB === 'deleted' && stA !== 'deleted') return a;

  const ta = a.token_updated_at ? new Date(String(a.token_updated_at)).getTime() : 0;
  const tb = b.token_updated_at ? new Date(String(b.token_updated_at)).getTime() : 0;
  if (ta !== tb) return tb >= ta ? b : a;

  return Number(b.shop_id) >= Number(a.shop_id) ? b : a;
}

/**
 * 同 tenant 内按 platform_shop_id 去重（active > expired > missing）
 * @param {Record<string, unknown>[]} rows
 * @param {number} tenantId
 */
function dedupeShopsByPlatformShopId(rows, tenantId) {
  const tid = Number(tenantId);
  const byPid = new Map();
  const noPid = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    if (Number(row.tenant_id) !== tid) continue;
    const pid = String(row.platform_shop_id || '').trim().toLowerCase();
    if (!pid) {
      noPid.push(row);
      continue;
    }
    const key = `p:${pid}`;
    const prev = byPid.get(key);
    byPid.set(key, prev ? pickBetterShopRow(prev, row) : row);
  }

  const out = [...byPid.values(), ...noPid];
  out.sort((a, b) => {
    const pa = String(a.platform_shop_id || '');
    const pb = String(b.platform_shop_id || '');
    if (pa !== pb) return pa.localeCompare(pb);
    return Number(a.shop_id) - Number(b.shop_id);
  });
  return out;
}

const SHOP_SELECT = `
  s.id AS internal_shop_id,
  s.id AS shop_id,
  s.tenant_id,
  s.platform,
  s.platform_shop_id,
  s.shop_name,
  s.display_name,
  s.market,
  s.region,
  s.sync_enabled,
  s.hidden,
  s.status AS shop_status,
  s.last_sync_at,
  t.access_token,
  t.refresh_token,
  t.token_expire_at,
  t.refresh_token_expire_at,
  t.scope_json,
  t.raw_auth_json,
  t.updated_at AS token_updated_at,
  (CASE WHEN t.access_token IS NOT NULL AND TRIM(t.access_token) <> '' THEN 1 ELSE 0 END) AS has_token,
  (CASE
    WHEN t.access_token IS NOT NULL AND TRIM(t.access_token) <> ''
         AND t.token_expire_at IS NOT NULL AND t.token_expire_at < NOW(3) THEN 'expired'
    WHEN t.access_token IS NULL OR TRIM(t.access_token) = '' THEN 'missing'
    ELSE 'active'
  END) AS token_status
`;

/**
 * 仅在指定 tenant 内解析店铺；禁止跨 tenant；同 platform_shop_id 取 id 最大且 token 最优行
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {{ shopId?: number|string, platformShopId?: string }} keys
 */
async function resolveTenantShop(pool, tenantId, keys = {}) {
  const tid = Number(tenantId);
  if (!pool || !Number.isFinite(tid) || tid <= 0) return null;

  const tokenJoin = sqlBestAuthTokenJoin('s', 't');
  const shopId = keys.shopId != null ? Number(keys.shopId) : NaN;
  const platformShopId = String(keys.platformShopId || '').trim();

  if (Number.isFinite(shopId) && shopId > 0) {
    const [rows] = await pool.query(
      `
      SELECT ${SHOP_SELECT}
      FROM shops s
      ${tokenJoin}
      WHERE s.tenant_id = ?
        AND s.id = ?
        AND s.status <> 'deleted'
      LIMIT 1
      `,
      [tid, shopId],
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  if (!platformShopId) return null;

  const [rows] = await pool.query(
    `
    SELECT ${SHOP_SELECT}
    FROM shops s
    ${tokenJoin}
    WHERE s.tenant_id = ?
      AND LOWER(TRIM(COALESCE(s.platform_shop_id, ''))) = LOWER(TRIM(?))
      AND s.status <> 'deleted'
    ORDER BY
      CASE
        WHEN t.access_token IS NOT NULL AND TRIM(t.access_token) <> ''
             AND (t.token_expire_at IS NULL OR t.token_expire_at >= NOW(3)) THEN 0
        WHEN t.access_token IS NOT NULL AND TRIM(t.access_token) <> '' THEN 1
        ELSE 2
      END ASC,
      s.id DESC
    LIMIT 1
    `,
    [tid, platformShopId],
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

module.exports = {
  authTenantId,
  enforceAuthTenantScope,
  strictAnalyticsFilterOpts,
  dedupeShopsByPlatformShopId,
  resolveTenantShop,
  pickBetterShopRow,
};
