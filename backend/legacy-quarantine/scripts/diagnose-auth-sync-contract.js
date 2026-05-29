#!/usr/bin/env node
'use strict';

/**
 * 授权 Token / 同步健康契约诊断（shops + 授权明细 + 同步中心�? *
 *   node scripts/diagnose-auth-sync-contract.js --tenant-id=6
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getMysqlPool } = require('../../db/mysqlPool');
const shopsSvc = require('../../modules/shops/service');
const { enrichShopsListWithTodayStats } = require('../../modules/shops/shopLiveStatsService');
const authZSvc = require('../../modules/authorizations/service');
const syncSvc = require('../../modules/sync/service');
const { buildAuthContractFields } = require('../../lib/shopAuthContract');
const { sqlBestAuthTokenJoin } = require('../../lib/shopTokenStatus');
const { applyShopListDisplayContract } = require('../../lib/shopListDisplay');

function parseArgs(argv) {
  let tenantId = null;
  for (const a of argv) {
    if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
  }
  return { tenantId };
}

function inc(map, key) {
  const k = String(key || 'unknown');
  map[k] = (map[k] || 0) + 1;
}

function diagAuth(tenantId) {
  return { tenant_id: tenantId, role: 'super_admin' };
}

function uiWouldShowTokenMissing(row) {
  const c = buildAuthContractFields(row);
  if (c.token_valid_for_display) return false;
  const label = String(row.error_label || row.auth_contract_label || row.auth_status || '').toLowerCase();
  const sync = String(row.sync_status || '').toLowerCase();
  return (
    c.token_status === 'missing' ||
    label.includes('缺少') ||
    label.includes('missing') ||
    sync === 'token_expired' ||
    sync.includes('token_exp')
  );
}

function uiWouldShowBadHealth(row) {
  const h = String(row.health_status || row.last_health_status || '').toLowerCase();
  return h === 'auth_error' || h === 'sync_stale' || h === 'sync_failed';
}

function authPageShowsMissing(row) {
  const c = buildAuthContractFields(row);
  if (!c.token_present) return false;
  const ts = String(row.token_status || c.token_status || '').toLowerCase();
  const err = String(row.error_label || row.auth_contract_label || '');
  return ts === 'missing' || /缺少授权|missing_token/i.test(err);
}

function syncCenterShowsAbnormal(row) {
  const c = buildAuthContractFields(row);
  if (!c.token_present || !c.token_valid_for_display) return false;
  const syncOn = row.sync_enabled === 1 || row.sync_enabled === true;
  const active = String(row.shop_status || row.status || 'active').toLowerCase() === 'active';
  if (!syncOn || !active) return false;
  const label = String(row.status_label || '');
  const err = String(row.error_label || '');
  const ts = String(row.token_status || '').toLowerCase();
  if (ts === 'missing' || ts === 'expired') return true;
  if (label === '异常' || err === '异常') return true;
  if (/未授权|缺少授权/i.test(label) || /未授权|缺少授权/i.test(err)) return true;
  return false;
}

function shopPageShowsStale(row) {
  const c = buildAuthContractFields(row);
  if (!c.token_present) return false;
  const display = applyShopListDisplayContract({ ...row, ...c });
  return uiWouldShowTokenMissing(display) || uiWouldShowBadHealth(display);
}

async function loadRawShops(pool, tenantId) {
  const [rows] = await pool.query(
    `SELECT s.id, s.tenant_id, s.shop_name, s.display_name, s.market, s.region, s.status, s.sync_enabled,
            s.auth_status, s.hidden
     FROM shops s
     WHERE s.tenant_id = ? AND s.status <> 'deleted'`,
    [tenantId],
  );
  return Array.isArray(rows) ? rows : [];
}

async function loadTokenRows(pool, tenantId, shopIds) {
  if (!shopIds.length) return [];
  const ph = shopIds.map(() => '?').join(',');
  const tokenJoin = sqlBestAuthTokenJoin('s', 't');
  const [rows] = await pool.query(
    `SELECT s.id AS shop_id, t.access_token, t.raw_auth_json
     FROM shops s
     ${tokenJoin}
     WHERE s.tenant_id = ? AND s.id IN (${ph})`,
    [tenantId, ...shopIds],
  );
  return Array.isArray(rows) ? rows : [];
}

async function buildShopsApiRows(pool, tenantId) {
  const rawShops = await loadRawShops(pool, tenantId);
  let list = rawShops;
  list = await shopsSvc.enrichShopsWithSyncStatus(pool, list);
  list = await enrichShopsListWithTodayStats(pool, list);
  const shopIds = rawShops.map((s) => Number(s.id)).filter(Boolean);
  const tokenRows = await loadTokenRows(pool, tenantId, shopIds);
  const tokenById = new Map(tokenRows.map((r) => [Number(r.shop_id), r]));
  return { list, tokenById };
}

async function main() {
  const { tenantId } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    console.error('用法: node scripts/diagnose-auth-sync-contract.js --tenant-id=6');
    process.exit(1);
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-auth-sync-contract] �?MySQL');
    process.exit(2);
  }

  const auth = diagAuth(tenantId);
  const { list: shopsList, tokenById } = await buildShopsApiRows(pool, tenantId);

  let authzItems = [];
  let syncShops = [];
  try {
    const authzOut = await authZSvc.list(tenantId, auth);
    authzItems = Array.isArray(authzOut.items) ? authzOut.items : [];
  } catch (e) {
    console.error('[diagnose-auth-sync-contract] authorizations list failed:', e?.message || e);
  }
  try {
    const syncOut = await syncSvc.getStatus(tenantId, auth);
    syncShops = Array.isArray(syncOut.shops) ? syncOut.shops : [];
  } catch (e) {
    console.error('[diagnose-auth-sync-contract] sync status failed:', e?.message || e);
  }

  const auth_status_breakdown = {};
  const sync_status_breakdown = {};
  const health_status_breakdown = {};

  const shops_api_mismatch = [];
  const authorizations_api_mismatch = [];
  const sync_center_api_mismatch = [];
  const mismatch_shops = [];

  let tokens_present = 0;
  let shop_cipher_present = 0;
  let shops_active = 0;
  let token_present_but_authorization_page_missing = 0;
  let token_present_but_sync_center_abnormal = 0;
  let token_present_but_shop_page_stale = 0;

  for (const row of shopsList) {
    const sid = Number(row.id);
    const tr = tokenById.get(sid) || {};
    const merged = { ...row, access_token: tr.access_token, raw_auth_json: tr.raw_auth_json };
    const contract = buildAuthContractFields(merged);
    const display = applyShopListDisplayContract({ ...merged, ...contract });

    if (String(row.status || '').toLowerCase() === 'active') shops_active += 1;
    if (contract.token_present) tokens_present += 1;
    if (contract.shop_cipher_present) shop_cipher_present += 1;

    inc(auth_status_breakdown, row.auth_status || 'null');
    inc(sync_status_breakdown, display.sync_status || row.sync_status || 'null');
    inc(health_status_breakdown, display.health_status || row.health_status || 'null');

    const syncOn = !(row.sync_enabled === 0 || row.sync_enabled === false);
    const active = String(row.status || '').toLowerCase() === 'active';

    if (contract.token_present && shopPageShowsStale(display)) {
      token_present_but_shop_page_stale += 1;
      shops_api_mismatch.push({
        shop_id: sid,
        api: 'shops',
        problem: 'token_present_but_shop_page_stale',
        token_status: display.token_status || contract.token_status,
        sync_status: display.sync_status,
        health_status: display.health_status,
        display: display.display,
      });
    }

    let problem = null;
    if (contract.token_present && uiWouldShowTokenMissing(display)) {
      problem = 'token_present_but_ui_missing_or_stale';
    } else if (
      active &&
      syncOn &&
      contract.token_valid_for_display &&
      uiWouldShowBadHealth(display)
    ) {
      problem = 'active_sync_enabled_token_present_but_health_bad';
    }

    if (problem) {
      mismatch_shops.push({
        shop_id: sid,
        shop_name: String(row.display_name || row.shop_name || ''),
        market: String(row.market || row.region || ''),
        status: row.status,
        sync_enabled: row.sync_enabled,
        auth_status: row.auth_status,
        token_present: contract.token_present,
        shop_cipher_present: contract.shop_cipher_present,
        sync_status: display.sync_status || row.sync_status,
        health_status: display.health_status || row.health_status,
        ui_display: display.display,
        problem,
      });
    }
  }

  const authzByShopId = new Map(authzItems.map((r) => [Number(r.shop_id), r]));
  const syncByShopId = new Map(syncShops.map((r) => [Number(r.shop_id), r]));

  for (const [sid, tr] of tokenById) {
    if (!String(tr.access_token || '').trim()) continue;
    const contract = buildAuthContractFields(tr);

    const authRow = authzByShopId.get(sid);
    if (authRow && authPageShowsMissing(authRow)) {
      token_present_but_authorization_page_missing += 1;
      authorizations_api_mismatch.push({
        shop_id: sid,
        api: 'authorizations',
        problem: 'token_present_but_page_missing',
        token_status: authRow.token_status,
        error_label: authRow.error_label,
      });
    }

    const syncRow = syncByShopId.get(sid);
    if (syncRow && syncCenterShowsAbnormal(syncRow)) {
      token_present_but_sync_center_abnormal += 1;
      sync_center_api_mismatch.push({
        shop_id: sid,
        api: 'sync_center',
        problem: 'token_present_but_status_abnormal',
        token_status: syncRow.token_status,
        status_label: syncRow.status_label,
        error_label: syncRow.error_label,
      });
    }
  }

  const tokenMissingStale = mismatch_shops.filter(
    (m) => m.problem === 'token_present_but_ui_missing_or_stale',
  ).length;
  const activeBadHealth = mismatch_shops.filter(
    (m) => m.problem === 'active_sync_enabled_token_present_but_health_bad',
  ).length;

  const ok =
    tokenMissingStale === 0 &&
    activeBadHealth === 0 &&
    shops_api_mismatch.length === 0 &&
    authorizations_api_mismatch.length === 0 &&
    sync_center_api_mismatch.length === 0 &&
    token_present_but_authorization_page_missing === 0 &&
    token_present_but_sync_center_abnormal === 0 &&
    token_present_but_shop_page_stale === 0;

  const report = {
    ok,
    tenant_id: tenantId,
    shops_total: shopsList.length,
    shops_active,
    tokens_present,
    shop_cipher_present,
    shops_api_contract: { checked: shopsList.length, mismatch: shops_api_mismatch.length },
    authorizations_api_contract: {
      checked: authzItems.length,
      mismatch: authorizations_api_mismatch.length,
    },
    sync_center_api_contract: { checked: syncShops.length, mismatch: sync_center_api_mismatch.length },
    auth_status_breakdown,
    sync_status_breakdown,
    health_status_breakdown,
    shops_api_mismatch,
    authorizations_api_mismatch,
    sync_center_api_mismatch,
    mismatch_shops,
    token_present_but_authorization_page_missing,
    token_present_but_sync_center_abnormal,
    token_present_but_shop_page_stale,
    summary: {
      token_present_but_ui_missing_or_stale: tokenMissingStale,
      active_sync_enabled_token_present_but_health_bad: activeBadHealth,
      token_present_but_authorization_page_missing,
      token_present_but_sync_center_abnormal,
      token_present_but_shop_page_stale,
    },
    notes: [
      'token_present = shop_auth_tokens.access_token TRIM non-empty',
      'shops path = enrichShopsWithSyncStatus + enrichShopsListWithTodayStats + applyShopListDisplayContract',
      'authorizations path = authorizations/service.list (loadAuthContractByShopId + aggregate)',
      'sync_center path = sync/service.getStatus (loadAuthContractByShopId + applySyncCenterShopRow)',
    ],
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[diagnose-auth-sync-contract]', e?.message || e);
  process.exit(3);
});
