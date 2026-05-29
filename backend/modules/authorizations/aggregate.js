'use strict';

const { stripLegacyDiagnostic, mapSyncStatusLabel } = require('../sync/saasSyncLabels');
const { tokenRank } = require('../../lib/shopTokenStatus');
const { applyAuthContractToAuthorizationRow, buildAuthContractFields } = require('../../lib/shopAuthContract');

function pickAuthorizationRow(a, b) {
  const ca = buildAuthContractFields(a);
  const cb = buildAuthContractFields(b);
  if (ca.token_present !== cb.token_present) return ca.token_present ? a : b;

  const ra = tokenRank(ca.token_status);
  const rb = tokenRank(cb.token_status);
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
    const contracted = applyAuthContractToAuthorizationRow(row);
    const token_status = contracted.token_status;
    const error_label = contracted.auth_contract_label;
    const hint = stripLegacyDiagnostic(row.last_health_message);
    out.push({
      ...contracted,
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
};
