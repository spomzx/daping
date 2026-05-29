#!/usr/bin/env node
'use strict';

/**
 * 回填缺失的 shop_cipher（shop_auth_tokens.raw_auth_json）
 *
 *   node scripts/backfill-missing-shop-cipher.js --tenant-id=6
 *   node scripts/backfill-missing-shop-cipher.js --tenant-id=6 --shop-id=31
 *   node scripts/backfill-missing-shop-cipher.js --tenant-id=6 --no-api   # 仅 shops.json
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const {
  backfillShopCipher,
  listShopsMissingCipher,
} = require('../lib/shopCipherBackfill');

function parseArgs(argv) {
  const out = { tenantId: null, shopId: null, tryApi: true };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--tenant-id=(\d+)$/);
    if (m) out.tenantId = Number(m[1]);
    const s = a.match(/^--shop-id=(\d+)$/);
    if (s) out.shopId = Number(s[1]);
    if (a === '--no-api') out.tryApi = false;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.tenantId) {
    console.error('Usage: node scripts/backfill-missing-shop-cipher.js --tenant-id=N [--shop-id=M] [--no-api]');
    process.exit(1);
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[backfill-shop-cipher] MySQL unavailable');
    process.exit(1);
  }
  const missing = await listShopsMissingCipher(pool, args.tenantId);
  console.log('[backfill-shop-cipher] missing_cipher_count', missing.length);

  const report = await backfillShopCipher(pool, {
    tenantId: args.tenantId,
    shopId: args.shopId,
    tryApi: args.tryApi,
  });

  console.log(JSON.stringify(report, null, 2));

  const recovered = report.sync_status_recovery?.recovered?.length || 0;
  if (recovered) {
    console.log('[backfill-shop-cipher] sync_status_recovered', recovered);
  }

  if (report.need_reauthorize?.length) {
    console.log('\n=== 需重新授权（无 shop_cipher 来源）===');
    for (const r of report.need_reauthorize) {
      console.log(
        `- shop_id=${r.shop_id} platform_shop_id=${r.platform_shop_id} name=${r.shop_name || ''} reason=${r.reason}`,
      );
    }
    process.exit(2);
  }

  const ok = report.fixed > 0 || recovered > 0;
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[backfill-shop-cipher] fatal', e);
  process.exit(1);
});
