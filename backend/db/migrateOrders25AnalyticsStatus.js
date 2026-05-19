'use strict';

/**
 * orders.analytics_status + idx_analytics；一次性回填（可重复执行，仅更新仍为默认值的行）。
 */

const { deriveAnalyticsStatusFromMysqlRow } = require('../lib/orderFilter');

async function columnExists(conn, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = ?`,
    [column],
  );
  return Number(rows[0]?.c) > 0;
}

async function indexExists(conn, indexName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = ?`,
    [indexName],
  );
  return Number(rows[0]?.c) > 0;
}

/**
 * @param {import('mysql2').Connection} conn
 */
async function migrateOrders25AnalyticsStatus(conn) {
  const hasCol = await columnExists(conn, 'analytics_status');
  if (!hasCol) {
    await conn.query(
      'ALTER TABLE `orders` ADD COLUMN `analytics_status` VARCHAR(20) NULL DEFAULT NULL AFTER `order_status`',
    );
    console.log('[mysql] orders.analytics_status 列已添加（可空，待回填）');
  }

  const hasIdx = await indexExists(conn, 'idx_analytics');
  if (!hasIdx) {
    try {
      await conn.query(
        'CREATE INDEX `idx_analytics` ON `orders` (`tenant_id`, `analytics_status`, `created_at_platform`, `market`, `shop_id`)',
      );
      console.log('[mysql] idx_analytics 已创建');
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.warn('[mysql] idx_analytics 创建（可忽略）:', msg);
    }
  }

  const batch = 800;
  let total = 0;
  for (;;) {
    const [rows] = await conn.query(
      `SELECT id, order_status, raw_json FROM orders
       WHERE analytics_status IS NULL
       ORDER BY id ASC
       LIMIT ?`,
      [batch],
    );
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) break;

    for (const row of list) {
      const st = deriveAnalyticsStatusFromMysqlRow(row);
      await conn.query('UPDATE orders SET analytics_status = ? WHERE id = ?', [st, row.id]);
    }
    total += list.length;
    if (list.length < batch) break;
  }

  if (total > 0) {
    console.log('[mysql] analytics_status 回填完成，处理行数:', total);
  }

  const [[cntRow]] = await conn.query('SELECT COUNT(*) AS c FROM orders WHERE analytics_status IS NULL');
  const nullLeft = Number(cntRow?.c || 0);
  if (nullLeft === 0) {
    try {
      await conn.query(
        "ALTER TABLE `orders` MODIFY COLUMN `analytics_status` VARCHAR(20) NOT NULL DEFAULT 'other'",
      );
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (!msg.includes('Duplicate') && !msg.includes('check that column')) {
        console.warn('[mysql] analytics_status NOT NULL 约束（可忽略）:', msg);
      }
    }
  } else {
    console.warn('[mysql] analytics_status 仍有 NULL，跳过 NOT NULL 约束；剩余', nullLeft);
  }
}

module.exports = { migrateOrders25AnalyticsStatus };
