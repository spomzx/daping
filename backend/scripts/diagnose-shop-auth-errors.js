#!/usr/bin/env node
'use strict';

/**
 * 列出授权异常店铺并尝试 refresh（仅写回 token，不删店、不清订单）。
 *
 * 用法（项目根或 backend 目录）：
 *   node backend/scripts/diagnose-shop-auth-errors.js
 *   node backend/scripts/diagnose-shop-auth-errors.js --tenant-id=6
 *   node backend/scripts/diagnose-shop-auth-errors.js --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const { refreshShopAccessToken } = require('../lib/tiktokTokenRefresh');
const { classifyTikTokAuthError } = require('../lib/shopAuthErrorClassifier');

function parseArgs(argv) {
  let tenantId = null;
  let dryRun = false;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
  }
  return { tenantId, dryRun };
}

async function main() {
  const { tenantId, dryRun } = parseArgs(process.argv.slice(2));
  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-shop-auth] 无 MySQL 连接，请配置 DATABASE_URL / MYSQL_*');
    process.exit(2);
  }

  const params = [];
  let tenantClause = '';
  if (tenantId != null && Number.isFinite(tenantId)) {
    tenantClause = ' AND s.tenant_id = ? ';
    params.push(tenantId);
  }

  const [rows] = await pool.query(
    `
    SELECT
      s.id AS shop_id,
      s.tenant_id,
      s.market,
      s.platform_shop_id,
      s.last_health_status,
      s.last_health_message,
      ss.sync_status,
      ss.last_error,
      t.token_expire_at AS token_expire_time,
      t.refresh_token_expire_at,
      t.refresh_token
    FROM shops s
    LEFT JOIN shop_sync_status ss
      ON ss.shop_id = s.id AND ss.tenant_id = s.tenant_id AND ss.platform = s.platform
    LEFT JOIN shop_auth_tokens t ON t.shop_id = s.id AND t.tenant_id = s.tenant_id
    WHERE s.status <> 'deleted'
      ${tenantClause}
      AND (
        s.last_health_status = 'auth_error'
        OR LOWER(COALESCE(ss.last_error, '')) LIKE '%invalid cr%'
        OR LOWER(COALESCE(ss.last_error, '')) LIKE '%invalid credential%'
        OR LOWER(COALESCE(ss.last_error, '')) LIKE '%refresh_http_%'
        OR LOWER(COALESCE(ss.last_error, '')) LIKE '%refresh_payload%'
        OR LOWER(COALESCE(ss.last_error, '')) LIKE '%需重新授权%'
        OR LOWER(COALESCE(ss.last_error, '')) LIKE '%应用配置异常%'
        OR LOWER(COALESCE(s.last_health_message, '')) LIKE '%授权%'
      )
    ORDER BY s.tenant_id, s.id
    `,
    params,
  );

  const list = Array.isArray(rows) ? rows : [];
  const report = [];

  for (const r of list) {
    let refresh_result = 'dry_run_skipped';
    if (!dryRun) {
      if (!r.refresh_token || !String(r.refresh_token).trim()) {
        refresh_result = 'no_refresh_token';
      } else {
        const rr = await refreshShopAccessToken({
          internal_shop_id: r.shop_id,
          refreshToken: r.refresh_token,
        });
        if (rr.ok) {
          refresh_result = `ok expire=${rr.accessTokenExpiresAt || ''}`;
        } else {
          refresh_result = `${rr.category || 'fail'}: ${rr.fullMessage || ''}`;
        }
      }
    }

    const errForClassify = r.last_error || r.last_health_message || '';
    let classified = classifyTikTokAuthError(errForClassify);
    if (!dryRun && refresh_result && !String(refresh_result).startsWith('ok')) {
      const refreshMsg = String(refresh_result).includes(':')
        ? String(refresh_result).split(':').slice(1).join(':').trim()
        : refresh_result;
      classified = classifyTikTokAuthError(refreshMsg);
    }

    const item = {
      shop_id: r.shop_id,
      market: r.market,
      tenant_id: r.tenant_id,
      platform_shop_id: r.platform_shop_id,
      last_error: r.last_error == null ? null : String(r.last_error),
      last_health_status: r.last_health_status,
      last_health_message: r.last_health_message,
      sync_status: r.sync_status,
      token_expire_time: r.token_expire_time,
      refresh_token_expire_at: r.refresh_token_expire_at,
      error_category: classified.category,
      error_label: classified.userLabel,
      refresh_result,
    };
    report.push(item);
    console.log(JSON.stringify(item, null, 0));
  }

  console.log('---');
  console.log(
    JSON.stringify(
      {
        dry_run: dryRun,
        total: report.length,
        by_category: report.reduce((acc, x) => {
          const k = x.error_category || 'unknown';
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {}),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error('[diagnose-shop-auth] fatal', e);
  process.exit(1);
});
