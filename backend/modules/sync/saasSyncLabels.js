'use strict';

const {
  normalizeTokenStatus,
  mapAuthErrorLabelByToken,
  mapAuthStatusLabelByToken,
  mapSyncOperationalErrorLabel,
  mapSyncOperationalStatusLabel,
  computeHasShopCipher,
} = require('../../lib/shopTokenStatus');

/** SaaS：禁止原样展示 raw code / legacy 诊断 */
const LEGACY_DIAG_RE =
  /shops\.json|orders-cache|gmv-cache|cache\s*fallback|missing_platform_shop_id|platform_shop_id\s*=\s*\?/i;

function isLegacyDiagnostic(msg) {
  if (msg == null || msg === '') return false;
  return LEGACY_DIAG_RE.test(String(msg));
}

function stripLegacyDiagnostic(msg) {
  if (msg == null || msg === '') return null;
  const s = String(msg).trim();
  if (!s || isLegacyDiagnostic(s)) return null;
  return s.slice(0, 240);
}

/**
 * @param {Record<string, unknown>} row
 */
function enrichSyncShopRow(row) {
  const resolved_shop_id = Number(row.shop_id);
  const platform_shop_id = String(row.platform_shop_id || '').trim();
  const sync_enabled = row.sync_enabled === 1 || row.sync_enabled === true ? 1 : 0;

  const tokenRow = {
    ...row,
    has_token:
      row.has_token === 1 ||
      row.has_token === true ||
      Boolean(String(row.access_token || '').trim()),
  };
  const token_status = normalizeTokenStatus(tokenRow);
  const has_token = token_status === 'active' || token_status === 'expired' ? 1 : 0;
  const has_shop_cipher = computeHasShopCipher(row);

  let status_label;
  let error_label;

  if (token_status === 'active') {
    status_label = mapSyncOperationalStatusLabel(row);
    error_label = mapSyncOperationalErrorLabel(row);
    if (isLegacyDiagnostic(error_label) || /未授权|缺少授权|missing_token/i.test(error_label)) {
      error_label = mapSyncOperationalErrorLabel({ ...row, last_error: null, last_health_message: null });
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
    String(row.shop_status || 'active').toLowerCase() === 'active' &&
    !(row.hidden === 1 || row.hidden === true);

  let reason = null;
  if (token_status === 'missing') reason = 'missing_token';
  else if (token_status === 'expired') reason = 'token_expired';
  else if (!eligible) {
    if (sync_enabled !== 1) reason = 'sync_disabled';
    else if (has_shop_cipher !== 1) reason = 'missing_shop_cipher';
    else reason = 'not_eligible';
  }

  console.log(
    '[sync-auth-check]',
    JSON.stringify({
      shop_id: resolved_shop_id,
      platform_shop_id,
      token_status,
      has_token: has_token === 1,
      has_shop_cipher: has_shop_cipher === 1,
      sync_enabled,
      eligible,
      reason,
    }),
  );

  return {
    ...row,
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
  };
}

/** 日志列表等非店铺行：保留原映射 */
function mapSyncStatusLabel(code) {
  const key = String(code || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  const MAP = {
    success: '同步正常',
    normal: '同步正常',
    running: '同步中',
    failed: '异常',
    rate_limited: '限流中',
  };
  return MAP[key] || String(code || '—').slice(0, 32);
}

function mapSyncErrorLabel(row) {
  const token_status = normalizeTokenStatus(row);
  if (token_status === 'active') return mapSyncOperationalErrorLabel(row);
  return mapAuthErrorLabelByToken(token_status);
}

module.exports = {
  isLegacyDiagnostic,
  stripLegacyDiagnostic,
  mapSyncStatusLabel,
  mapSyncErrorLabel,
  enrichSyncShopRow,
};
