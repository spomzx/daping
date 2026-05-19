'use strict';

const { stripLegacyDiagnostic, mapSyncStatusLabel } = require('../sync/saasSyncLabels');
const {
  tokenRank,
  normalizeTokenStatus,
  mapAuthErrorLabelByToken,
} = require('../../lib/shopTokenStatus');

function pickAuthorizationRow(a, b) {
  const na = normalizeTokenStatus(a);
  const nb = normalizeTokenStatus(b);
  const ra = tokenRank(na);
  const rb = tokenRank(nb);
  if (ra !== rb) return ra > rb ? a : b;

  const stA = String(a.shop_status || 'active').toLowerCase();
  const stB = String(b.shop_status || 'active').toLowerCase();
  if (stA === 'deleted' && stB !== 'deleted') return b;
  if (stB === 'deleted' && stA !== 'deleted') return a;

  const ta = a.token_updated_at ? new Date(String(a.token_updated_at)).getTime() : 0;
  const tb = b.token_updated_at ? new Date(String(b.token_updated_at)).getTime() : 0;
  if (ta !== tb) return tb >= ta ? b : a;

  return Number(b.shop_id) >= Number(a.shop_id) ? b : a;
}

function aggregateAuthorizationRows(rows) {
  const byKey = new Map();

  for (const row of rows) {
    if (String(row.shop_status || '').toLowerCase() === 'deleted') continue;

    const pid = String(row.platform_shop_id || '').trim().toLowerCase();
    if (!pid) continue;
    const key = `p:${pid}`;
    const prev = byKey.get(key);
    byKey.set(key, prev ? pickAuthorizationRow(prev, row) : row);
  }

  for (const row of rows) {
    if (String(row.shop_status || '').toLowerCase() === 'deleted') continue;
    const pid = String(row.platform_shop_id || '').trim().toLowerCase();
    if (pid) continue;
    const key = `s:${row.shop_id}`;
    const prev = byKey.get(key);
    byKey.set(key, prev ? pickAuthorizationRow(prev, row) : row);
  }

  const out = [];
  for (const row of byKey.values()) {
    const token_status = normalizeTokenStatus(row);
    const error_label = mapAuthErrorLabelByToken(token_status);
    const hint = stripLegacyDiagnostic(row.last_health_message);
    out.push({
      ...row,
      token_status,
      error_label,
      last_health_message: error_label,
      auth_status: error_label,
      health_hint:
        token_status === 'active' && hint && hint !== error_label ? mapSyncStatusLabel(hint) : null,
    });
  }

  out.sort((a, b) => {
    const pa = String(a.platform_shop_id || '');
    const pb = String(b.platform_shop_id || '');
    if (pa !== pb) return pa.localeCompare(pb);
    return Number(a.shop_id) - Number(b.shop_id);
  });

  return out;
}

module.exports = {
  aggregateAuthorizationRows,
  pickAuthorizationRow,
  mapAuthErrorLabelByToken,
  normalizeTokenStatus,
};
