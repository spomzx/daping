'use strict';

/**
 * orders.platform_shop_id — 幂等补齐（staging 等未跑 migrate30 的库）
 * @param {import('mysql2/promise').Connection} conn
 * @returns {Promise<{ columnAdded: boolean; indexesAdded: string[] }>}
 */
async function columnExists(conn, table, columnName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, columnName],
  );
  return Number(rows[0]?.c) > 0;
}

async function indexExists(conn, table, indexName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, indexName],
  );
  return Number(rows[0]?.c) > 0;
}

async function migrateOrders34PlatformShopId(conn) {
  const indexesAdded = [];
  let columnAdded = false;

  const hasCol = await columnExists(conn, 'orders', 'platform_shop_id');
  if (!hasCol) {
    const hasShopId = await columnExists(conn, 'orders', 'shop_id');
    const afterClause = hasShopId ? ' AFTER `shop_id`' : '';
    await conn.query(`
      ALTER TABLE \`orders\`
        ADD COLUMN \`platform_shop_id\` VARCHAR(128) NULL DEFAULT NULL
          COMMENT 'TikTok platform shop id; orders.shop_id = shops.id'${afterClause}
    `);
    columnAdded = true;
    console.log('[migrate34] orders.platform_shop_id column added');
  } else {
    console.log('[migrate34] orders.platform_shop_id already exists — skip ADD COLUMN');
  }

  if (!(await indexExists(conn, 'orders', 'idx_orders_platform_shop_id'))) {
    if (!(await indexExists(conn, 'orders', 'idx_orders_platform_shop'))) {
      try {
        await conn.query(
          'ALTER TABLE `orders` ADD INDEX `idx_orders_platform_shop_id` (`platform_shop_id`)',
        );
        indexesAdded.push('idx_orders_platform_shop_id');
        console.log('[migrate34] index idx_orders_platform_shop_id added');
      } catch (e) {
        console.warn('[migrate34] idx_orders_platform_shop_id:', e?.message || e);
      }
    } else {
      console.log('[migrate34] idx_orders_platform_shop exists — skip idx_orders_platform_shop_id');
    }
  } else {
    console.log('[migrate34] idx_orders_platform_shop_id already exists');
  }

  const timeCol = (await columnExists(conn, 'orders', 'created_at_platform'))
    ? 'created_at_platform'
    : (await columnExists(conn, 'orders', 'created_at'))
      ? 'created_at'
      : null;

  if (timeCol && !(await indexExists(conn, 'orders', 'idx_orders_platform_shop_created_at'))) {
    try {
      await conn.query(
        `ALTER TABLE \`orders\` ADD INDEX \`idx_orders_platform_shop_created_at\` (\`platform_shop_id\`, \`${timeCol}\`)`,
      );
      indexesAdded.push('idx_orders_platform_shop_created_at');
      console.log('[migrate34] index idx_orders_platform_shop_created_at added (time:', timeCol, ')');
    } catch (e) {
      console.warn('[migrate34] idx_orders_platform_shop_created_at:', e?.message || e);
    }
  }

  if (await columnExists(conn, 'orders', 'platform_shop_id')) {
    try {
      const [res] = await conn.query(`
        UPDATE orders o
        INNER JOIN shops s ON o.shop_id = s.id
        SET o.platform_shop_id = s.platform_shop_id
        WHERE o.platform_shop_id IS NULL
          AND s.platform_shop_id IS NOT NULL
      `);
      console.log('[migrate34] backfill platform_shop_id from shops:', res.affectedRows ?? 0);
    } catch (e) {
      console.warn('[migrate34] backfill skipped:', e?.message || e);
    }
  }

  return { columnAdded, indexesAdded };
}

module.exports = { migrateOrders34PlatformShopId };
