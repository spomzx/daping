'use strict';

/**
 * 修正 tenants.plan_type 非法值（如误写入数字 "20"），统一为 basic|enterprise|custom
 * @param {import('mysql2/promise').Connection | import('mysql2/promise').PoolConnection} conn
 */
async function migrateTenantPlanType39(conn) {
  const [r] = await conn.query(
    `UPDATE tenants SET plan_type = 'basic'
     WHERE plan_type IS NULL
        OR TRIM(plan_type) = ''
        OR LOWER(TRIM(plan_type)) NOT IN ('basic','enterprise','custom')`,
  );
  const fixedInvalid = r?.affectedRows != null ? Number(r.affectedRows) : 0;

  return { fixedInvalid };
}

module.exports = { migrateTenantPlanType39 };
