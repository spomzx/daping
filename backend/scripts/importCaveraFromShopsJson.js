'use strict';

/**
 * 一次性：从 shops.json（或 SHOPS_JSON_PATH / backup）仅导入 Cavera Jewelry
 * node backend/scripts/importCaveraFromShopsJson.js --tenant_id=1
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const fs = require('fs');
const { getMysqlPool } = require('../db/mysqlPool');
const { persistOAuthShopsToMysql } = require('../modules/shops/oauthMysqlPersist');
const { CAVERA_PLATFORM_SHOP_ID } = require('../lib/openApiSyncShops');

const DEFAULT_JSON = path.join(__dirname, '..', 'storage.local.bak', 'shops.json');

function parseArgs() {
  let tenantId = Number(process.env.DASHBOARD_TENANT_ID || process.env.DEFAULT_TENANT_ID || 1);
  let jsonPath = process.env.SHOPS_JSON_PATH || DEFAULT_JSON;
  for (const a of process.argv.slice(2)) {
    const t = /^--tenant_id=(\d+)$/.exec(a);
    if (t) tenantId = Number(t[1]);
    const p = /^--json=(.+)$/.exec(a);
    if (p) jsonPath = p[1];
  }
  return { tenantId, jsonPath };
}

function jsonShopToNormalized(s) {
  return {
    shopId: String(s.shopId || '').trim(),
    shopCipher: String(s.shopCipher || s.shop_cipher || '').trim(),
    shopName: String(s.shopName || s.shop_name || s.shopId || '').trim(),
    region: String(s.region || s.market || 'TH').trim().toUpperCase(),
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
  const { tenantId, jsonPath } = parseArgs();
  if (!fs.existsSync(jsonPath)) {
    console.error('shops json not found:', jsonPath);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.shops || [];
  const cavera = list.find((s) => String(s.shopId || '').trim() === CAVERA_PLATFORM_SHOP_ID);
  if (!cavera) {
    console.error('Cavera not in', jsonPath);
    process.exit(1);
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('MySQL unavailable');
    process.exit(1);
  }

  const norm = jsonShopToNormalized(cavera);
  const result = await persistOAuthShopsToMysql(pool, tenantId, [norm], { unlimitedShops: true });
  console.log('[import-cavera]', JSON.stringify({ tenantId, platform_shop_id: CAVERA_PLATFORM_SHOP_ID, ...result }, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
