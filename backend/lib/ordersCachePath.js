'use strict';

const path = require('path');
const fs = require('fs');
const { storageDir } = require('./storageFile');

const STORAGE_DIR = storageDir();
/** @deprecated legacy worker only — SaaS API 禁止读取 orders-cache.json */
const ORDERS_CACHE_PATH = path.join(STORAGE_DIR, 'orders-cache.json');

function cacheFileStats() {
  try {
    if (!fs.existsSync(ORDERS_CACHE_PATH)) {
      return {
        cache_file_path: ORDERS_CACHE_PATH,
        storage_dir: STORAGE_DIR,
        cache_updated_at: null,
        cache_file_exists: false,
        cache_lag_minutes: null,
      };
    }
    const st = fs.statSync(ORDERS_CACHE_PATH);
    const mtime = st.mtime ? st.mtime.getTime() : null;
    const lagMin = mtime != null ? Math.floor((Date.now() - mtime) / 60000) : null;
    return {
      cache_file_path: ORDERS_CACHE_PATH,
      storage_dir: STORAGE_DIR,
      cache_updated_at: mtime ? new Date(mtime).toISOString() : null,
      cache_file_exists: true,
      cache_lag_minutes: lagMin,
      cache_file_size_bytes: st.size,
    };
  } catch (e) {
    return {
      cache_file_path: ORDERS_CACHE_PATH,
      storage_dir: STORAGE_DIR,
      cache_updated_at: null,
      cache_file_exists: false,
      cache_lag_minutes: null,
      error: String(e?.message || e),
    };
  }
}

module.exports = { ORDERS_CACHE_PATH, STORAGE_DIR, cacheFileStats };
