'use strict';

const { getDb, getDbFilePath } = require('./sqlite');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL UNIQUE,
  shop_id TEXT,
  shop_name TEXT,
  market TEXT,
  status TEXT,
  currency TEXT,
  amount REAL,
  amount_target REAL,
  target_currency TEXT,
  customer_name TEXT,
  product_items_json TEXT,
  raw_json TEXT,
  created_at TEXT,
  created_ts INTEGER,
  updated_at TEXT,
  updated_ts INTEGER,
  synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_created_ts ON orders(created_ts);
CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market);
CREATE INDEX IF NOT EXISTS idx_orders_shop_id ON orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
`;

/**
 * 本地 SQLite 订单表（可选）。不影响 MySQL 业务库。
 * @returns {boolean}
 */
function initSqliteOrdersDatabase() {
  const db = getDb();
  if (!db) {
    console.error('[dashboard-db] SQLite init skipped: database not available');
    return false;
  }
  try {
    db.exec(SCHEMA_SQL);
    return true;
  } catch (e) {
    console.error('[dashboard-db] SQLite init exec failed:', e && e.message ? e.message : e);
    return false;
  }
}

if (require.main === module) {
  try {
    const ok = initSqliteOrdersDatabase();
    console.log(ok ? `[dashboard-db] SQLite initialized ${getDbFilePath()}` : '[dashboard-db] SQLite init failed');
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('[dashboard-db] SQLite init fatal', e);
    process.exit(1);
  }
}

module.exports = { initSqliteOrdersDatabase };
