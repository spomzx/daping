'use strict';

/**
 * �?shops.json（或 SHOPS_JSON_PATH）一次性导�?MySQL shops + shop_auth_tokens
 * node backend/scripts/importLegacyShopsJson.js --tenant_id=1
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../', '.env') });

const path = require('path');

function parseArgs() {
  let tenantId = Number(process.env.DASHBOARD_TENANT_ID || process.env.DEFAULT_TENANT_ID || 1);
  for (const a of process.argv.slice(2)) {
    const m = /^--tenant_id=(\d+)$/.exec(a);
    if (m) tenantId = Number(m[1]);
  }
  return { tenantId };
}

async function main() {
  const { tenantId } = parseArgs();
  const script = path.join(__dirname, 'migrate-shops-json-to-mysql.js');
  process.argv = [process.argv[0], process.argv[1], `--tenant_id=${tenantId}`];
  require(script);
}

main();
