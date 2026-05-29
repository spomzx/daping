#!/usr/bin/env node
'use strict';

/**
 * TikTok 授权链路诊断：每店 tenant / market / seller_type / token / scope / 同步状态
 * 用法: node scripts/diagnose-tiktok-auth-routing.js [--tenant-id=6]
 */

require('../loadEnv');

const { getMysqlPool } = require('../db/mysqlPool');
const { scopeIncludesOrderInfoDeclared } = require('../lib/openApiWorkerEligibility');
const { scopeIncludesOrderInfo } = require('../tiktok-api/authRouting');

function parseArgs() {
  const out = { tenantId: null };
  for (const a of process.argv.slice(2)) {
    const m = /^--tenant-id=(\d+)$/.exec(a);
    if (m) out.tenantId = Number(m[1]);
  }
  return out;
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

async function main() {
  const { tenantId } = parseArgs();
  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-tiktok-auth] MySQL unavailable');
    process.exit(1);
  }

  const params = [];
  let where = "s.platform = 'tiktok' AND s.status <> 'deleted'";
  if (tenantId != null && Number.isFinite(tenantId)) {
    where += ' AND s.tenant_id = ?';
    params.push(tenantId);
  }

  const [rows] = await pool.query(
    `SELECT s.id, s.tenant_id, s.shop_name, s.market, s.region, s.seller_type, s.platform_shop_id,
            s.sync_enabled, s.last_sync_at, s.auth_status, s.last_health_status,
            t.access_token, t.refresh_token, t.scope_json, t.raw_auth_json
     FROM shops s
     LEFT JOIN shop_auth_tokens t ON t.shop_id = s.id AND t.tenant_id = s.tenant_id
       AND t.id = (
         SELECT t2.id FROM shop_auth_tokens t2
         WHERE t2.shop_id = s.id AND t2.tenant_id = s.tenant_id
         ORDER BY t2.updated_at DESC, t2.id DESC LIMIT 1
       )
     WHERE ${where}
     ORDER BY s.tenant_id, s.id`,
    params,
  );

  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    console.log('[diagnose-tiktok-auth] no shops in MySQL (no shops.json fallback)');
    process.exit(0);
  }

  console.log(`[diagnose-tiktok-auth] shops=${list.length} tenant_filter=${tenantId ?? 'all'}\n`);

  for (const r of list) {
    const raw = parseJsonField(r.raw_auth_json);
    const cipher = String(raw.shop_cipher || raw.shopCipher || '').trim();
    const scopes = r.scope_json;
    const hasOrderScope =
      scopeIncludesOrderInfo(scopes) ||
      scopeIncludesOrderInfoDeclared(scopes, raw) ||
      scopeIncludesOrderInfo(raw.granted_scopes || raw.scope);

    const line = {
      tenant_id: r.tenant_id,
      shop_id: r.id,
      shop_name: r.shop_name,
      market: r.market || r.region || null,
      seller_type: r.seller_type || raw.seller_type || null,
      platform_shop_id: r.platform_shop_id,
      has_access_token: Boolean(String(r.access_token || '').trim()),
      has_refresh_token: Boolean(String(r.refresh_token || '').trim()),
      has_shop_cipher: Boolean(cipher),
      scopes: scopes,
      has_order_info_scope: hasOrderScope,
      sync_enabled: r.sync_enabled === 1,
      last_sync_at: r.last_sync_at,
      auth_health_status: r.last_health_status || r.auth_status || 'unknown',
    };
    console.log(JSON.stringify(line));
  }
}

main().catch((e) => {
  console.error('[diagnose-tiktok-auth] failed', e?.message || e);
  process.exit(1);
});
