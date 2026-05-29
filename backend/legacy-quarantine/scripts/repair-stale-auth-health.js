#!/usr/bin/env node
'use strict';

/**
 * 清理 API 已验证成功店铺的陈旧 token_expired / Invalid credentials 展示
 *
 *   node scripts/repair-stale-auth-health.js --tenant-id=6
 *   node scripts/repair-stale-auth-health.js --tenant-id=6 --date=2026-05-25
 *   node scripts/repair-stale-auth-health.js --tenant-id=6 --list-only
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const dayjs = require('dayjs');
const { getMysqlPool } = require('../../db/mysqlPool');
const {
  listShopsWithStaleAuthDisplay,
  repairStaleAuthHealthForTenant,
} = require('../../lib/staleAuthHealthRepair');
const { ensureShopAccessTokenFresh } = require('../../lib/tiktokTokenRefresh');

function parseArgs(argv) {
  let tenantId = null;
  let dateYmd = dayjs().format('YYYY-MM-DD');
  let listOnly = false;
  for (const a of argv) {
    if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
    else if (a.startsWith('--date=')) dateYmd = String(a.split('=')[1]).trim();
    else if (a === '--list-only') listOnly = true;
  }
  return { tenantId, dateYmd, listOnly };
}

async function enrichStaleWithTokenRefresh(pool, tenantId, staleList) {
  const out = [];
  for (const row of staleList) {
    const [tok] = await pool.query(
      `SELECT access_token, refresh_token, token_expire_at FROM shop_auth_tokens
       WHERE shop_id = ? AND tenant_id = ? ORDER BY id DESC LIMIT 1`,
      [row.shop_id, tenantId],
    );
    const t = tok?.[0];
    let token_refresh_result = { ok: null, refreshed: false, category: 'not_run' };
    if (t) {
      const tr = await ensureShopAccessTokenFresh(
        {
          internal_shop_id: row.shop_id,
          refreshToken: t.refresh_token,
          accessToken: t.access_token,
          accessTokenExpiresAt: t.token_expire_at,
        },
        { skewMs: 48 * 3600 * 1000 },
      );
      token_refresh_result = {
        ok: tr.ok,
        refreshed: tr.refreshed === true,
        category: tr.category || null,
        userLabel: tr.userLabel || null,
        fullMessage: tr.fullMessage || null,
      };
    }
    out.push({ ...row, token_refresh_result });
  }
  return out;
}

async function main() {
  const { tenantId, dateYmd, listOnly } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(tenantId)) {
    console.error('用法: node scripts/repair-stale-auth-health.js --tenant-id=6 [--date=YYYY-MM-DD] [--list-only]');
    process.exit(1);
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[repair-stale-auth-health] �?MySQL');
    process.exit(2);
  }

  const staleList = await listShopsWithStaleAuthDisplay(pool, tenantId);
  const staleDetailed = await enrichStaleWithTokenRefresh(pool, tenantId, staleList);

  console.log('\n=== 陈旧授权/同步异常店铺（修复前�?==');
  console.log(JSON.stringify(staleDetailed, null, 2));
  console.log(`\n合计: ${staleDetailed.length} 家\n`);

  if (listOnly) {
    process.exit(staleDetailed.length > 0 ? 2 : 0);
  }

  const report = await repairStaleAuthHealthForTenant(pool, { tenantId, verifyApi: true, dateYmd });
  console.log(JSON.stringify(report, null, 2));

  const remaining = await listShopsWithStaleAuthDisplay(pool, tenantId);
  console.log('\n=== 修复后仍显示陈旧的店�?===');
  console.log(JSON.stringify(remaining, null, 2));

  const exitCode =
    report.need_reauthorize?.length > 0
      ? 2
      : remaining.length > 0
        ? 1
        : 0;
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('[repair-stale-auth-health] fatal', e);
  process.exit(1);
});
