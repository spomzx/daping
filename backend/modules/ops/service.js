'use strict';

const { buildOrdersReconcileReport } = require('../orders/orderReconcileService');
const { rebuildOrdersCacheFromMysql } = require('../orders/orderCacheRebuildService');
const { ORDERS_CACHE_PATH, STORAGE_DIR, cacheFileStats } = require('../../lib/ordersCachePath');

async function runOrdersReconcile(tenantId, auth, options = {}) {
  return buildOrdersReconcileReport(tenantId, auth, options);
}

async function runOrdersCacheRebuild(tenantId, auth, options = {}) {
  const rebuilt = await rebuildOrdersCacheFromMysql(tenantId, auth);
  const hoursRaw = Number(options.windowHours);
  const windowHours =
    Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(720, Math.max(1, hoursRaw)) : undefined;
  const reconcile = await buildOrdersReconcileReport(tenantId, auth, { windowHours });
  return {
    rebuild: rebuilt,
    reconcile,
    paths: {
      rebuild_writes: rebuilt.cachePath || rebuilt.cache_file_path,
      reconcile_reads: reconcile.meta?.cacheFile || reconcile.debug?.cacheSource?.cache_file_path,
      storage_dir: rebuilt.storage_dir,
    },
    meta: {
      legacy_cache_rebuild: true,
      not_saas_source_of_truth: true,
      mysql_primary: true,
    },
  };
}

function getOrdersCachePathsInfo() {
  return {
    orders_cache_path: ORDERS_CACHE_PATH,
    storage_dir: STORAGE_DIR,
    process_cwd: process.cwd(),
    ...cacheFileStats(),
    ops_only: true,
    legacy_cache: true,
  };
}

module.exports = {
  runOrdersReconcile,
  runOrdersCacheRebuild,
  getOrdersCachePathsInfo,
};
