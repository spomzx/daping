'use strict';

/**
 * 一次性：将 storage/shops.json 导入指定租户的 MySQL shops + shop_auth_tokens。
 *
 * node backend/scripts/migrate-shops-json-to-mysql.js --tenant_id=1
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const mysql = require('mysql2/promise');
const dayjs = require('dayjs');
const { getMysqlConfig } = require('../config/database');
const { readShops } = require('../tiktok-api/shops');
const { getTenantById } = require('../modules/tenants/service');
const { countShopsForTenant } = require('../modules/shops/service');
const { persistOAuthShopsToMysql } = require('../modules/shops/oauthMysqlPersist');
const { backfillShopCipher } = require('../lib/shopCipherBackfill');
const { resolveTenantMaxShops } = require('../lib/tenantShopLimit');
const { migrateShops27OAuthColumns } = require('../db/migrateShops27OAuth');

function parseArgs() {
  const out = { tenantId: null };
  for (const a of process.argv.slice(2)) {
    const m = /^--tenant_id=(\d+)$/.exec(String(a).trim());
    if (m) out.tenantId = Number(m[1]);
  }
  return out;
}

function jsonShopToNormalized(s) {
  return {
    shopId: String(s.shopId || '').trim(),
    shopCipher: String(s.shopCipher || s.shop_cipher || '').trim(),
    shopName: String(s.shopName || s.shop_name || s.shopId || '').trim(),
    region: String(s.region || s.market || '').trim().toUpperCase(),
    currency: String(s.currency || '').trim().toUpperCase(),
    accessToken: String(s.accessToken || ''),
    refreshToken: String(s.refreshToken || ''),
    accessTokenExpiresAt: s.accessTokenExpiresAt || null,
    refreshTokenExpiresAt: s.refreshTokenExpiresAt || null,
    scope: s.grantedScopes || s.scope || '',
    rawTokenPayload: s.rawTokenPayload || s,
  };
}

async function main() {
  const { tenantId } = parseArgs();
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    console.error('Usage: node backend/scripts/migrate-shops-json-to-mysql.js --tenant_id=1');
    process.exit(1);
  }

  const cfg = getMysqlConfig();
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
  });

  try {
    await migrateShops27OAuthColumns(conn);
    const tenant = await getTenantById(conn, tenantId);
    if (!tenant) {
      console.error('[migrate] tenant_not_found', tenantId);
      process.exit(1);
    }

    const jsonShops = readShops().filter((s) => s && s.enabled !== false);
    const normalizedAll = jsonShops.map(jsonShopToNormalized).filter((n) => n.shopId);
    const normalized = normalizedAll.filter((n) => n.shopCipher);
    const missingCipherInJson = normalizedAll.filter((n) => !n.shopCipher);

    const before = await countShopsForTenant(conn, tenantId);
    const maxShops = resolveTenantMaxShops(tenant.max_shops);

    console.log('[migrate] start', {
      tenant_id: tenantId,
      json_shops: jsonShops.length,
      normalized_with_cipher: normalized.length,
      json_missing_cipher: missingCipherInJson.length,
      cipher_backfill_fixed: cipherPatch.fixed,
      mysql_shops_before: before,
      max_shops: maxShops,
    });

    const result = await persistOAuthShopsToMysql(conn, tenantId, normalized);

    /** 已入库但缺 cipher：用 JSON 中同 platform_shop_id 的 cipher 补丁 */
    const cipherPatch = await backfillShopCipher(conn, {
      tenantId,
      tryApi: false,
    });

    const after = await countShopsForTenant(conn, tenantId);

    console.log('[migrate] done', {
      ...result,
      mysql_shops_after: after,
      at: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    });

    if (result.skipped_count > 0) {
      console.log('[migrate] skipped detail:', JSON.stringify(result.skipped, null, 2));
    }
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error('[migrate] failed:', e && e.message ? e.message : e);
  process.exit(1);
});
