'use strict';

/**
 * 一次性：将 storage/gmv-cache.json 中的汇率写入 exchange_rates（去重）。
 * 不存在文件时 skipped，不报错。
 *
 * 用法：node backend/scripts/migrateGmvCacheToExchangeRates.js
 */

const path = require('path');
const fs = require('fs');
const { getMysqlPool } = require('../db/mysqlPool');

const STORAGE_DIR = path.join(__dirname, '..', 'storage');
const GMV_CACHE_PATH = path.join(STORAGE_DIR, 'gmv-cache.json');

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const pool = getMysqlPool();
  if (!pool) {
    console.error('[migrate-gmv-cache] MySQL unavailable');
    process.exit(1);
  }

  const pack = readJsonSafe(GMV_CACHE_PATH);
  if (!pack || typeof pack !== 'object') {
    console.log('[migrate-gmv-cache] skipped: gmv-cache.json not found or invalid');
    process.exit(0);
  }

  const base = String(pack.baseCurrency || 'THB').trim().toUpperCase().slice(0, 8);
  const target = String(pack.targetCurrency || 'CNY').trim().toUpperCase().slice(0, 8);
  const rate = Number(pack.exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    console.log('[migrate-gmv-cache] skipped: no valid exchangeRate in file');
    process.exit(0);
  }

  const [[existing]] = await pool.query(
    `SELECT id FROM exchange_rates
     WHERE base_currency = ? AND target_currency = ?
       AND ABS(rate - ?) < 0.0000001
     LIMIT 1`,
    [base, target, rate],
  );

  if (existing && existing.id) {
    console.log('[migrate-gmv-cache] skipped: duplicate rate already in DB', { base, target, rate });
    process.exit(0);
  }

  const effectiveAt = pack.meta?.updatedAt || pack.updatedAt || new Date().toISOString();
  const [ins] = await pool.query(
    `INSERT INTO exchange_rates (base_currency, target_currency, rate, source, effective_at)
     VALUES (?, ?, ?, 'gmv-cache-migration', ?)`,
    [base, target, rate, new Date(effectiveAt)],
  );

  console.log('[migrate-gmv-cache] ok', {
    id: ins.insertId,
    base_currency: base,
    target_currency: target,
    rate,
    from: GMV_CACHE_PATH,
  });
  process.exit(0);
}

main().catch((e) => {
  console.error('[migrate-gmv-cache] failed', e?.message || e);
  process.exit(1);
});
