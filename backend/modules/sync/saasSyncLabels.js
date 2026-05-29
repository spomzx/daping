'use strict';

const { applySyncCenterShopRow } = require('../../lib/shopAuthContract');

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
  const out = applySyncCenterShopRow(row);
  console.log(
    '[sync-auth-check]',
    JSON.stringify({
      shop_id: out.shop_id,
      platform_shop_id: out.platform_shop_id,
      token_status: out.token_status,
      token_present: out.token_present,
      has_shop_cipher: out.has_shop_cipher === 1,
      sync_enabled: out.sync_enabled,
      eligible: out.eligible_for_manual_sync,
      reason: out.reason,
      status_label: out.status_label,
    }),
  );
  return out;
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
  const contracted = applySyncCenterShopRow(row);
  return contracted.error_label;
}

module.exports = {
  isLegacyDiagnostic,
  stripLegacyDiagnostic,
  mapSyncStatusLabel,
  mapSyncErrorLabel,
  enrichSyncShopRow,
};
