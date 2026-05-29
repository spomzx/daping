'use strict';

/**
 * 授权 / 同步健康展示契约（shops 列表 + 授权明细共用）
 * 真源：shop_auth_tokens.access_token；shop_cipher 来自 raw_auth_json
 */

const {
  normalizeTokenStatus,
  mapAuthErrorLabelByToken,
  mapAuthStatusLabelByToken,
  mapSyncOperationalErrorLabel,
  mapSyncOperationalStatusLabel,
  computeHasShopCipher,
  extractShopCipher,
  sqlBestAuthTokenJoin,
} = require('./shopTokenStatus');
const { looksLikeStaleAuthState } = require('./staleAuthHealthRepair');

/**
 * Token 是否存在（仅 access_token 列）
 * @param {Record<string, unknown>} row
 */
function tokenPresentFromRow(row) {
  return Boolean(String(row.access_token || '').trim());
}

/**
 * @param {Record<string, unknown>} row
 */
function shopCipherPresentFromRow(row) {
  return Boolean(extractShopCipher(row.raw_auth_json));
}

/**
 * @param {Record<string, unknown>} row
 */
function isTokenExpired(row, nowMs = Date.now()) {
  const exp = row.token_expire_at;
  if (!exp) return false;
  const t = new Date(exp).getTime();
  return Number.isFinite(t) && t < nowMs;
}

/**
 * 统一 auth contract 字段（不写库）
 * @param {Record<string, unknown>} row
 */
function buildAuthContractFields(row) {
  const token_present = tokenPresentFromRow(row);
  const shop_cipher_present = shopCipherPresentFromRow(row);
  const token_status = normalizeTokenStatus({
    ...row,
    has_token: token_present ? 1 : 0,
  });
  const token_valid_for_display = token_present && !isTokenExpired(row);
  return {
    token_present,
    shop_cipher_present,
    token_status,
    token_valid_for_display,
    auth_contract_label: mapAuthErrorLabelByToken(token_status),
    auth_status_contract: mapAuthStatusLabelByToken(token_status),
  };
}

/**
 * 健康 / 同步展示：token 有效时清理陈旧 token_expired / Invalid credentials
 * @param {Record<string, unknown>} row
 */
function applyAuthContractDisplay(row) {
  const contract = buildAuthContractFields(row);
  let next = { ...row, ...contract };

  if (!contract.token_valid_for_display) {
    return next;
  }

  const orders = Number(next.today_orders ?? next.last_order_count ?? 0) || 0;
  const health = String(next.health_status || next.last_health_status || '').toLowerCase();

  if (looksLikeStaleAuthState(next.sync_status, next.last_error, next.is_token_valid)) {
    next.sync_status = orders > 0 ? 'success' : 'idle';
    next.is_token_valid = 1;
    next.last_error = null;
    next.last_error_full = null;
    next.last_error_code = null;
    next.queue_sync_status = next.sync_status;
  }

  if (health === 'auth_error') {
    next.health_status = orders > 0 ? 'normal' : 'no_orders_today';
    next.last_health_status = next.health_status;
    next.health_reason = orders > 0 ? '授权正常，近窗口有订单' : '授权正常，今日无单';
    next.last_health_message = next.health_reason;
  } else if (health === 'sync_stale' || health === 'sync_failed') {
    const err = String(next.last_error || next.health_reason || '').toLowerCase();
    const staleAuthErr =
      err.includes('invalid credential') ||
      err.includes('token') ||
      err.includes('unauthorized') ||
      err.includes('cipher');
    if (staleAuthErr || looksLikeStaleAuthState(next.sync_status, next.last_error, 0)) {
      next.health_status = orders > 0 ? 'normal' : 'no_orders_today';
      next.last_health_status = next.health_status;
      next.health_reason =
        orders > 0 ? '授权正常，OpenAPI 同步待刷新' : '授权正常，今日无单';
      next.last_health_message = next.health_reason;
      if (next.sync_status === 'token_expired' || next.sync_status === 'failed') {
        next.sync_status = orders > 0 ? 'success' : 'idle';
        next.is_token_valid = 1;
      }
    }
  }

  return next;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {number[]} shopIds
 */
async function loadAuthContractByShopId(pool, tenantId, shopIds) {
  const map = new Map();
  if (!pool || !Number.isFinite(tenantId) || !shopIds.length) return map;

  const ids = [...new Set(shopIds.map((id) => Number(id)).filter((id) => id > 0))];
  if (!ids.length) return map;

  const ph = ids.map(() => '?').join(',');
  const tokenJoin = sqlBestAuthTokenJoin('s', 't');
  const [rows] = await pool.query(
    `SELECT
      s.id AS shop_id,
      t.access_token,
      t.refresh_token,
      t.token_expire_at,
      t.raw_auth_json,
      (CASE WHEN t.access_token IS NOT NULL AND TRIM(t.access_token) <> '' THEN 1 ELSE 0 END) AS has_token
     FROM shops s
     ${tokenJoin}
     WHERE s.tenant_id = ? AND s.id IN (${ph})`,
    [tenantId, ...ids],
  );

  for (const r of Array.isArray(rows) ? rows : []) {
    const sid = Number(r.shop_id);
    if (!Number.isFinite(sid)) continue;
    map.set(sid, {
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      token_expire_at: r.token_expire_at,
      raw_auth_json: r.raw_auth_json,
      has_token: r.has_token,
    });
  }
  return map;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {object[]} list
 */
async function enrichShopsWithAuthContract(pool, list) {
  if (!pool || !Array.isArray(list) || !list.length) return list;

  const byTenant = new Map();
  for (const row of list) {
    const tid = Number(row.tenant_id);
    if (!Number.isFinite(tid)) continue;
    if (!byTenant.has(tid)) byTenant.set(tid, []);
    byTenant.get(tid).push(row);
  }

  const merged = new Map();
  for (const [tid, rows] of byTenant) {
    const authMap = await loadAuthContractByShopId(
      pool,
      tid,
      rows.map((r) => r.id),
    );
    for (const row of rows) {
      const sid = Number(row.id);
      const auth = authMap.get(sid) || {};
      merged.set(`${tid}:${sid}`, { ...row, ...auth });
    }
  }

  return list.map((row) => {
    const tid = Number(row.tenant_id);
    const sid = Number(row.id);
    const key = `${tid}:${sid}`;
    const base = merged.get(key) || row;
    return applyAuthContractDisplay(base);
  });
}

/**
 * 授权明细行（与 aggregate 输出合并）
 * @param {Record<string, unknown>} row
 */
function applyAuthContractToAuthorizationRow(row) {
  const contract = buildAuthContractFields(row);
  const token_status = contract.token_status;
  const error_label = contract.auth_contract_label;
  return {
    ...row,
    ...contract,
    token_status,
    error_label,
    last_health_message: error_label,
    auth_status: error_label,
  };
}

function syncOperationalRowFromContract(row) {
  const orders = Number(row.today_orders_count ?? row.today_orders ?? 0) || 0;
  const health = String(row.last_health_status || '').toLowerCase();
  const staleHealth =
    health === 'sync_stale' ||
    health === 'sync_failed' ||
    health === 'auth_error' ||
    health === 'sync_error';
  if (!staleHealth) return row;
  return {
    ...row,
    last_health_status: orders > 0 ? 'normal' : 'no_orders_today',
    last_health_message: orders > 0 ? '授权正常，近窗口有订单' : '授权正常，今日无单',
    last_error: null,
  };
}

/**
 * 同步中心行：与 shops / 授权明细共用 token 真源，并修正陈旧 health →「异常」
 * @param {Record<string, unknown>} row
 */
function applySyncCenterShopRow(row) {
  const base = applyAuthContractDisplay({
    ...row,
    today_orders: row.today_orders_count ?? row.today_orders,
  });
  const contract = buildAuthContractFields(base);
  const sync_enabled = base.sync_enabled === 1 || base.sync_enabled === true ? 1 : 0;
  const has_shop_cipher = computeHasShopCipher(base);
  const token_status = contract.token_status;
  const has_token = token_status === 'active' || token_status === 'expired' ? 1 : 0;

  let status_label;
  let error_label;

  if (contract.token_valid_for_display) {
    const op = syncOperationalRowFromContract(base);
    status_label = mapSyncOperationalStatusLabel(op);
    error_label = mapSyncOperationalErrorLabel(op);
    if (/未授权|缺少授权|missing_token|token_missing/i.test(String(error_label || ''))) {
      const orders = Number(base.today_orders_count ?? base.today_orders ?? 0) || 0;
      error_label = orders > 0 ? '同步正常' : '近24h无订单';
    }
  } else if (token_status === 'expired') {
    status_label = mapAuthStatusLabelByToken('expired');
    error_label = mapAuthErrorLabelByToken('expired');
  } else {
    status_label = mapAuthStatusLabelByToken('missing');
    error_label = mapAuthErrorLabelByToken('missing');
  }

  const eligible =
    token_status === 'active' &&
    sync_enabled === 1 &&
    has_shop_cipher === 1 &&
    String(base.shop_status || 'active').toLowerCase() === 'active' &&
    !(base.hidden === 1 || base.hidden === true);

  let reason = null;
  if (token_status === 'missing') reason = 'missing_token';
  else if (token_status === 'expired') reason = 'token_expired';
  else if (!eligible) {
    if (sync_enabled !== 1) reason = 'sync_disabled';
    else if (has_shop_cipher !== 1) reason = 'missing_shop_cipher';
    else reason = 'not_eligible';
  }

  const resolved_shop_id = Number(base.shop_id ?? base.resolved_shop_id);
  const platform_shop_id = String(base.platform_shop_id || '').trim();

  return {
    ...base,
    ...contract,
    resolved_shop_id,
    shop_id: resolved_shop_id,
    platform_shop_id,
    token_status,
    has_token,
    has_shop_cipher,
    sync_enabled,
    status_label,
    error_label,
    auth_error_label: mapAuthErrorLabelByToken(token_status),
    eligible_for_manual_sync: eligible,
    reason,
  };
}

/**
 * computeShopHealthV2 用：token 列有效时勿因陈旧 is_token_valid=0 判 auth
 * @param {Record<string, unknown>} shopRow
 */
function effectiveIsTokenValidForHealth(shopRow) {
  const contract = buildAuthContractFields(shopRow);
  if (contract.token_valid_for_display) return 1;
  if (shopRow.is_token_valid === 0 || shopRow.is_token_valid === false) return 0;
  return shopRow.is_token_valid != null ? shopRow.is_token_valid : 1;
}

module.exports = {
  tokenPresentFromRow,
  shopCipherPresentFromRow,
  buildAuthContractFields,
  applyAuthContractDisplay,
  applyAuthContractToAuthorizationRow,
  applySyncCenterShopRow,
  enrichShopsWithAuthContract,
  loadAuthContractByShopId,
  effectiveIsTokenValidForHealth,
  isTokenExpired,
};
