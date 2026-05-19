'use strict';

/**
 * tenants 套餐字段：plan_type / shop_limit / max_users / expires_at / is_active / plan_remark
 * @param {import('mysql2/promise').Connection | import('mysql2/promise').PoolConnection} conn
 */
async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return Number(rows[0]?.c) > 0;
}

async function migrateTenantPlan36(conn) {
  const added = [];

  if (!(await columnExists(conn, 'tenants', 'shop_limit'))) {
    await conn.query(
      `ALTER TABLE tenants ADD COLUMN shop_limit INT UNSIGNED NOT NULL DEFAULT 10
       COMMENT '套餐店铺上限' AFTER max_shops`,
    );
    added.push('shop_limit');
  }

  if (!(await columnExists(conn, 'tenants', 'max_users'))) {
    await conn.query(
      `ALTER TABLE tenants ADD COLUMN max_users INT UNSIGNED NOT NULL DEFAULT 3
       COMMENT '套餐用户上限' AFTER shop_limit`,
    );
    added.push('max_users');
  }

  if (!(await columnExists(conn, 'tenants', 'expires_at'))) {
    await conn.query(
      `ALTER TABLE tenants ADD COLUMN expires_at DATETIME NULL DEFAULT NULL
       COMMENT '套餐到期时间' AFTER max_users`,
    );
    added.push('expires_at');
  }

  if (!(await columnExists(conn, 'tenants', 'is_active'))) {
    await conn.query(
      `ALTER TABLE tenants ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1
       COMMENT '1=启用 0=禁用' AFTER expires_at`,
    );
    added.push('is_active');
  }

  if (!(await columnExists(conn, 'tenants', 'plan_remark'))) {
    await conn.query(
      `ALTER TABLE tenants ADD COLUMN plan_remark VARCHAR(255) NULL DEFAULT NULL
       COMMENT '套餐备注' AFTER is_active`,
    );
    added.push('plan_remark');
  }

  const [planCol] = await conn.query(
    `SELECT COLUMN_DEFAULT, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants' AND COLUMN_NAME = 'plan_type'`,
  );
  const planDefault = planCol[0]?.COLUMN_DEFAULT;
  if (planDefault == null || String(planDefault).toLowerCase() === 'null') {
    try {
      await conn.query(
        `ALTER TABLE tenants MODIFY COLUMN plan_type VARCHAR(20) NOT NULL DEFAULT 'basic'
         COMMENT 'basic|enterprise'`,
      );
    } catch {
      await conn.query(`UPDATE tenants SET plan_type = 'basic' WHERE plan_type IS NULL OR TRIM(plan_type) = ''`);
    }
  }

  await conn.query(
    `UPDATE tenants SET plan_type = 'basic'
     WHERE plan_type IS NULL OR TRIM(plan_type) = ''`,
  );

  await conn.query(
    `UPDATE tenants SET shop_limit = CASE
       WHEN max_shops IS NOT NULL AND max_shops > shop_limit THEN max_shops
       WHEN shop_limit IS NULL OR shop_limit < 1 THEN 10
       ELSE shop_limit
     END`,
  );

  await conn.query(
    `UPDATE tenants SET max_users = 3 WHERE max_users IS NULL OR max_users < 1`,
  );

  await conn.query(
    `UPDATE tenants SET is_active = 1 WHERE is_active IS NULL`,
  );

  await conn.query(
    `UPDATE tenants SET max_shops = shop_limit WHERE max_shops IS NULL OR max_shops < shop_limit`,
  );

  return { added };
}

module.exports = { migrateTenantPlan36 };
