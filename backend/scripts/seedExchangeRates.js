#!/usr/bin/env node
'use strict';

/**
 * 初始化 exchange_rates（可配置初始值，不写死在业务查询里）
 * 用法: node backend/scripts/seedExchangeRates.js
 *
 * 环境变量（可选）:
 *   SEED_RATE_USD_THB  SEED_RATE_USD_MYR  SEED_RATE_USD_PHP  SEED_RATE_USD_VND  SEED_RATE_USD_SGD
 */

require('../loadEnv');

const { getMysqlPool } = require('../db/mysqlPool');
const { refreshRatesFromDb } = require('../modules/exchangeRateService');

function readSeedRate(envKey, fallback) {
  const raw = String(process.env[envKey] || '').trim();
  const n = Number(raw || fallback);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid ${envKey}: ${raw || fallback}`);
  }
  return n;
}

const SEED_ROWS = [
  { base: 'USD', target: 'USD', rate: 1, env: null },
  { base: 'USD', target: 'THB', rate: readSeedRate('SEED_RATE_USD_THB', '36.5'), env: 'SEED_RATE_USD_THB' },
  { base: 'USD', target: 'MYR', rate: readSeedRate('SEED_RATE_USD_MYR', '4.72'), env: 'SEED_RATE_USD_MYR' },
  { base: 'USD', target: 'PHP', rate: readSeedRate('SEED_RATE_USD_PHP', '56.2'), env: 'SEED_RATE_USD_PHP' },
  { base: 'USD', target: 'VND', rate: readSeedRate('SEED_RATE_USD_VND', '25400'), env: 'SEED_RATE_USD_VND' },
  { base: 'USD', target: 'SGD', rate: readSeedRate('SEED_RATE_USD_SGD', '1.34'), env: 'SEED_RATE_USD_SGD' },
];

async function main() {
  const pool = getMysqlPool();
  if (!pool) {
    console.error('[seedExchangeRates] MySQL 未配置');
    process.exit(1);
  }
  for (const row of SEED_ROWS) {
    await pool.query(
      `INSERT INTO exchange_rates (base_currency, target_currency, rate, source, effective_at)
       VALUES (?, ?, ?, 'seed', NOW(3))`,
      [row.base, row.target, row.rate],
    );
    const via = row.env ? `env ${row.env}` : 'fixed';
    console.log(`[seedExchangeRates] ${row.base} -> ${row.target} = ${row.rate} (${via})`);
  }
  await refreshRatesFromDb(pool);
  const [all] = await pool.query('SELECT * FROM exchange_rates ORDER BY base_currency, target_currency, id');
  console.log('[seedExchangeRates] done, rows:', Array.isArray(all) ? all.length : 0);
}

main().catch((e) => {
  console.error('[seedExchangeRates] fatal', e);
  process.exit(1);
});
