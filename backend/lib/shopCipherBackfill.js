'use strict';

/**
 * shop_cipher 回填：写入 shop_auth_tokens.raw_auth_json.shop_cipher
 * 来源优先级：shops.json → TikTok GET /authorization/202309/shops
 */

const dayjs = require('dayjs');
const path = require('path');
const fs = require('fs');
const { readShops, SHOPS_PATH } = require('../tiktok-api/shops');
const { patchShopSyncStatus } = require('../sync/services/shopSyncStatusService');

/** 因缺 cipher 导致的历史失败/禁用，可在补齐后清除 */
const STALE_CIPHER_SYNC_MARKERS = [
  'shop_cipher_missing',
  'missing_shop_cipher',
  'shop_not_found_or_not_eligible',
  'missing_seller.order.info',
  'missing_seller.order.info_scope',
  'missing_scope',
];

function isStaleCipherSyncFailure(lastError, lastErrorCode) {
  const code = String(lastErrorCode || '').toLowerCase();
  const err = String(lastError || '').toLowerCase();
  return STALE_CIPHER_SYNC_MARKERS.some((m) => code.includes(m) || err.includes(m));
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

function extractCipherFromRawAuth(rawAuth) {
  const raw = parseJsonField(rawAuth);
  return String(raw.shop_cipher || raw.shopCipher || '').trim();
}

/**
 * @param {object} raw
 * @param {string} shopCipher
 * @param {string} platformShopId
 */
function mergeCipherIntoRawAuth(raw, shopCipher, platformShopId) {
  const base = parseJsonField(raw);
  return {
    ...base,
    shop_cipher: shopCipher,
    shopCipher: shopCipher,
    shop_id: platformShopId || base.shop_id || base.shopId,
  };
}

/**
 * @param {string} platformShopId
 * @param {string} [jsonPath]
 */
function loadCipherFromShopsJson(platformShopId, jsonPath) {
  const pid = String(platformShopId || '').trim();
  if (!pid) return { cipher: null, source: null, path: null };

  const candidates = [
    jsonPath,
    process.env.SHOPS_JSON_PATH,
    path.join(__dirname, '..', 'storage', 'shops.json'),
    path.join(__dirname, '..', 'storage.local.bak', 'shops.json'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (!p || !fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.shops || [];
      const hit = list.find((s) => String(s.shopId || s.shop_id || '').trim() === pid);
      if (!hit) continue;
      const cipher = String(hit.shopCipher || hit.shop_cipher || hit.rawTokenPayload?.shop_cipher || '').trim();
      if (cipher) return { cipher, source: 'shops_json', path: p };
    } catch {
      /* try next */
    }
  }

  try {
    const list = readShops();
    const hit = (Array.isArray(list) ? list : []).find((s) => String(s.shopId || '').trim() === pid);
    if (hit) {
      const cipher = String(hit.shopCipher || hit.shop_cipher || hit.rawTokenPayload?.shop_cipher || '').trim();
      if (cipher) return { cipher, source: 'shops_readShops', path: SHOPS_PATH };
    }
  } catch {
    /* ignore */
  }

  return { cipher: null, source: null, path: null };
}

/**
 * @param {string} accessToken
 * @param {string} platformShopId
 */
async function loadCipherFromAuthorizedShopsApi(accessToken, platformShopId) {
  const token = String(accessToken || '').trim();
  if (!token) {
    return { cipher: null, source: null, error: 'missing_access_token', debug: null };
  }

  const { fetchAuthorizedShops } = require('../tiktok-api/auth');
  try {
    const { list, debug } = await fetchAuthorizedShops(token);
    const pid = String(platformShopId || '').trim();
    for (const raw of Array.isArray(list) ? list : []) {
      const id = String(raw?.shop_id || raw?.seller_id || raw?.id || '').trim();
      if (id === pid) {
        const cipher = String(raw?.shop_cipher || raw?.shopCipher || raw?.cipher || '').trim();
        if (cipher) {
          return { cipher, source: 'authorization_shops_api', error: null, debug };
        }
      }
    }
    return {
      cipher: null,
      source: null,
      error: 'shop_not_in_authorized_list',
      debug,
    };
  } catch (e) {
    return {
      cipher: null,
      source: null,
      error: String(e?.message || e),
      debug: e?.debug || null,
    };
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ tenantId: number, shopId: number, platformShopId: string, shopCipher: string, source: string }} p
 */
async function patchShopAuthCipherInMysql(pool, p) {
  const cipher = String(p.shopCipher || '').trim();
  if (!cipher) {
    return { ok: false, reason: 'empty_cipher' };
  }

  const [tokRows] = await pool.query(
    `SELECT id, raw_auth_json, access_token
     FROM shop_auth_tokens
     WHERE tenant_id = ? AND shop_id = ?
     ORDER BY id DESC LIMIT 1`,
    [p.tenantId, p.shopId],
  );
  const tok = tokRows?.[0];
  if (!tok) {
    return { ok: false, reason: 'no_token_row' };
  }

  const merged = mergeCipherIntoRawAuth(tok.raw_auth_json, cipher, p.platformShopId);
  await pool.execute(
    `UPDATE shop_auth_tokens SET raw_auth_json = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
    [JSON.stringify(merged), tok.id],
  );

  await pool.execute(
    `UPDATE shops SET
       auth_status = 'authorized',
       sync_enabled = 1,
       status = CASE WHEN status = 'deleted' THEN status ELSE 'active' END,
       updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND tenant_id = ?`,
    [p.shopId, p.tenantId],
  );

  const syncRecovery = await recoverShopSyncStatusIfEligible(pool, {
    tenantId: p.tenantId,
    shopId: p.shopId,
    forceAfterCipherPatch: true,
  });

  return {
    ok: true,
    token_row_id: tok.id,
    shop_cipher: cipher,
    source: p.source,
    sync_status_recovery: syncRecovery,
  };
}

/**
 * 已有 shop_cipher 且店铺可同步时，清除 shop_sync_status=disabled（及 cipher 导致的 failed）
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ tenantId: number, shopId?: number, forceAfterCipherPatch?: boolean }} opts
 */
async function recoverShopSyncStatusIfEligible(pool, opts) {
  const tenantId = Number(opts.tenantId);
  const shopFilter = opts.shopId != null && Number.isFinite(Number(opts.shopId)) ? 'AND s.id = ?' : '';
  const params = [tenantId];
  if (shopFilter) params.push(Number(opts.shopId));

  const [rows] = await pool.query(
    `SELECT s.id AS shop_id, s.tenant_id, s.platform, s.status, s.sync_enabled,
            t.raw_auth_json,
            ss.sync_status, ss.last_error, ss.last_error_code
     FROM shops s
     INNER JOIN shop_auth_tokens t ON t.id = (
       SELECT t2.id FROM shop_auth_tokens t2 WHERE t2.shop_id = s.id ORDER BY t2.id DESC LIMIT 1
     )
     LEFT JOIN shop_sync_status ss ON ss.shop_id = s.id AND ss.tenant_id = s.tenant_id AND ss.platform = s.platform
     WHERE s.tenant_id = ? AND s.platform = 'tiktok' AND s.status = 'active' AND s.sync_enabled = 1
       ${shopFilter}`,
    params,
  );

  const recovered = [];
  const skipped = [];

  for (const r of Array.isArray(rows) ? rows : []) {
    const shopId = Number(r.shop_id);
    const platform = String(r.platform || 'tiktok');
    const cipher = extractCipherFromRawAuth(r.raw_auth_json);
    if (!cipher) {
      skipped.push({ shop_id: shopId, reason: 'no_shop_cipher' });
      continue;
    }

    const syncStatus = String(r.sync_status || '').toLowerCase();
    const staleCipher = isStaleCipherSyncFailure(r.last_error, r.last_error_code);
    const shouldRecover =
      syncStatus === 'disabled' ||
      (syncStatus === 'failed' && staleCipher) ||
      (opts.forceAfterCipherPatch && staleCipher);

    if (!shouldRecover) {
      skipped.push({ shop_id: shopId, reason: 'sync_status_ok', sync_status: syncStatus || null });
      continue;
    }

    if (Number(r.sync_enabled) === 0) {
      await pool.execute(
        `UPDATE shops SET sync_enabled = 1, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND tenant_id = ?`,
        [shopId, tenantId],
      );
    }

    await patchShopSyncStatus(pool, tenantId, shopId, platform, {
      sync_status: 'idle',
      last_error: null,
      last_error_code: null,
      sync_fail_count: 0,
      is_token_valid: 1,
      token_expired_at: null,
    });
    recovered.push({
      shop_id: shopId,
      previous_sync_status: syncStatus,
      new_sync_status: 'idle',
      cleared_stale_cipher_error: staleCipher,
    });
  }

  return { recovered, skipped };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 */
async function listShopsMissingCipher(pool, tenantId) {
  const [rows] = await pool.query(
    `SELECT s.id AS shop_id, s.tenant_id, s.platform_shop_id, s.shop_name, s.display_name, s.market, s.region,
            s.sync_enabled, s.status, s.auth_status,
            t.id AS token_id, t.access_token, t.refresh_token, t.token_expire_at, t.raw_auth_json
     FROM shops s
     LEFT JOIN shop_auth_tokens t ON t.id = (
       SELECT t2.id FROM shop_auth_tokens t2 WHERE t2.shop_id = s.id ORDER BY t2.id DESC LIMIT 1
     )
     WHERE s.tenant_id = ? AND s.platform = 'tiktok' AND s.status <> 'deleted'`,
    [tenantId],
  );
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const hasToken = Boolean(String(r.access_token || '').trim());
    const cipher = extractCipherFromRawAuth(r.raw_auth_json);
    if (!hasToken) continue;
    if (cipher) continue;
    out.push(r);
  }
  return out;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ tenantId: number, shopId?: number, jsonPath?: string, tryApi?: boolean }} opts
 */
async function backfillShopCipher(pool, opts) {
  const tenantId = Number(opts.tenantId);
  let rows;
  if (opts.shopId != null && Number.isFinite(Number(opts.shopId))) {
    const [shopRows] = await pool.query(
      `SELECT s.id AS shop_id, s.tenant_id, s.platform_shop_id, s.shop_name, s.market, s.sync_enabled, s.status,
              t.access_token, t.raw_auth_json
       FROM shops s
       LEFT JOIN shop_auth_tokens t ON t.id = (
         SELECT t2.id FROM shop_auth_tokens t2 WHERE t2.shop_id = s.id ORDER BY t2.id DESC LIMIT 1
       )
       WHERE s.id = ? AND s.tenant_id = ? LIMIT 1`,
      [Number(opts.shopId), tenantId],
    );
    const row = shopRows?.[0];
    if (!row) {
      return {
        tenant_id: tenantId,
        processed: 0,
        fixed: 0,
        failed: 0,
        results: [],
        need_reauthorize: [],
        error: 'shop_not_found',
        at: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      };
    }
    rows = extractCipherFromRawAuth(row.raw_auth_json) ? [] : [row];
  } else {
    rows = await listShopsMissingCipher(pool, tenantId);
  }
  const results = [];
  const needReauth = [];

  for (const row of rows) {
    if (!row) continue;
    const shopId = Number(row.shop_id);
    const platformShopId = String(row.platform_shop_id || '').trim();
    const accessToken = String(row.access_token || '').trim();

    let cipher = null;
    let source = null;
    let resolveError = null;
    let resolveDebug = null;

    const fromJson = loadCipherFromShopsJson(platformShopId, opts.jsonPath);
    if (fromJson.cipher) {
      cipher = fromJson.cipher;
      source = fromJson.source;
    } else if (opts.tryApi !== false && accessToken) {
      const fromApi = await loadCipherFromAuthorizedShopsApi(accessToken, platformShopId);
      cipher = fromApi.cipher;
      source = fromApi.source;
      resolveError = fromApi.error;
      resolveDebug = fromApi.debug;
    } else if (!accessToken) {
      resolveError = 'missing_access_token';
    } else {
      resolveError = fromJson.path ? 'cipher_not_in_json' : resolveError || 'cipher_not_found';
    }

    if (!cipher) {
      needReauth.push({
        shop_id: shopId,
        platform_shop_id: platformShopId,
        shop_name: row.shop_name || row.display_name,
        market: row.market || row.region,
        reason: resolveError || 'cipher_unavailable',
        action: 'reauthorize_oauth',
      });
      results.push({
        shop_id: shopId,
        platform_shop_id: platformShopId,
        ok: false,
        error: resolveError,
      });
      continue;
    }

    const patched = await patchShopAuthCipherInMysql(pool, {
      tenantId,
      shopId,
      platformShopId,
      shopCipher: cipher,
      source,
    });
    results.push({
      shop_id: shopId,
      platform_shop_id: platformShopId,
      ok: patched.ok,
      shop_cipher: cipher,
      source,
      patch: patched,
    });
  }

  const syncRecovery = await recoverShopSyncStatusIfEligible(pool, {
    tenantId,
    shopId: opts.shopId,
  });

  return {
    tenant_id: tenantId,
    processed: results.length,
    fixed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
    need_reauthorize: needReauth,
    sync_status_recovery: syncRecovery,
    at: dayjs().format('YYYY-MM-DD HH:mm:ss'),
  };
}

module.exports = {
  extractCipherFromRawAuth,
  mergeCipherIntoRawAuth,
  loadCipherFromShopsJson,
  loadCipherFromAuthorizedShopsApi,
  patchShopAuthCipherInMysql,
  listShopsMissingCipher,
  recoverShopSyncStatusIfEligible,
  backfillShopCipher,
};
