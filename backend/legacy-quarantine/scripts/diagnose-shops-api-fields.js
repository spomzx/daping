#!/usr/bin/env node
'use strict';

/**
 * 打印 GET /api/shops 同源列表字段（与 ShopMgmtPanel 一致）
 *
 *   node scripts/diagnose-shops-api-fields.js --tenant-id=6 --shop-ids=37,38,39,40,41
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getMysqlPool } = require('../../db/mysqlPool');
const shopsSvc = require('../../modules/shops/service');
const { enrichShopsListWithTodayStats } = require('../../modules/shops/shopLiveStatsService');

function parseArgs(argv) {
  let tenantId = null;
  let shopIds = [];
  for (const a of argv) {
    if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
    else if (a.startsWith('--shop-ids=')) {
      shopIds = String(a.split('=')[1])
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n));
    }
  }
  return { tenantId, shopIds };
}

async function buildListLikeApi(pool, tenantId, shopIds) {
  const [rows] = await pool.query(
    `SELECT s.id, s.tenant_id, s.platform, s.platform_shop_id, s.shop_name, s.display_name,
            s.market, s.region, s.currency, s.sort_order, s.hidden, s.sync_enabled, s.remarks,
            s.status, s.auth_status, s.last_sync_at, s.last_order_seen_at, s.last_order_count,
            s.last_gmv_amount, s.last_health_status, s.last_health_message, s.last_health_checked_at,
            s.created_at, s.updated_at, t.tenant_name, t.tenant_code
     FROM shops s
     LEFT JOIN tenants t ON t.id = s.tenant_id
     WHERE s.tenant_id = ? AND s.id IN (${shopIds.map(() => '?').join(',')})`,
    [tenantId, ...shopIds],
  );
  let list = await shopsSvc.enrichShopsWithSyncStatus(pool, rows);
  list = await enrichShopsListWithTodayStats(pool, list);
  return list;
}

function pickFields(row) {
  return {
    shop_id: row.id ?? row.shop_id,
    shop_name: row.display_name || row.shop_name,
    market: row.market || row.region,
    sync_status: row.sync_status ?? null,
    sync_label: row.sync_label ?? null,
    last_error: row.last_error ?? null,
    last_error_full: row.last_error_full ?? null,
    health_status: row.health_status ?? row.last_health_status ?? null,
    health_label: row.health_label ?? null,
    display: row.display ?? null,
    today_orders: row.today_orders ?? row.last_order_count ?? 0,
    today_gmv: row.today_gmv ?? row.last_gmv_amount ?? 0,
    is_token_valid: row.is_token_valid,
    last_success_sync_at: row.last_success_sync_at ?? null,
    health_reason: row.health_reason ?? null,
  };
}

async function main() {
  const { tenantId, shopIds } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(tenantId) || !shopIds.length) {
    console.error(
      '用法: node scripts/diagnose-shops-api-fields.js --tenant-id=6 --shop-ids=37,38,39,40,41',
    );
    process.exit(1);
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-shops-api-fields] �?MySQL');
    process.exit(2);
  }

  const list = await buildListLikeApi(pool, tenantId, shopIds);
  const out = list.map(pickFields);
  console.log(JSON.stringify({ tenant_id: tenantId, shops: out }, null, 2));

  const bad = out.filter(
    (r) =>
      String(r.display || '') !== 'today_no_orders' &&
      String(r.display || '') !== 'ok' &&
      (String(r.health_status || '').includes('auth') ||
        String(r.sync_status || '') === 'token_expired' ||
        String(r.last_error || '').toLowerCase().includes('invalid credential')),
  );
  if (bad.length) {
    console.error('\n[FAIL] 仍有陈旧授权展示字段:', bad.length);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('[diagnose-shops-api-fields] fatal', e);
  process.exit(1);
});
