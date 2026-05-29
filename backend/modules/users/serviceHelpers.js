'use strict';

const { isPlatformScopeUser } = require('../../lib/userScope');

function actorHasPlatformPrivileges(auth) {
  return isPlatformScopeUser({ scope: auth.scope, role: auth.role });
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} targetUserId
 * @param {number} tenantId
 */
async function getMembershipInTenant(pool, targetUserId, tenantId) {
  const [rows] = await pool.query(
    `SELECT ut.id, ut.user_id, ut.tenant_id, ut.role, ut.status AS membership_status,
            u.username, u.status AS user_status, u.scope AS user_scope
     FROM user_tenants ut
     INNER JOIN users u ON u.id = ut.user_id
     WHERE ut.user_id = ? AND ut.tenant_id = ?
     LIMIT 1`,
    [targetUserId, tenantId],
  );
  const list = Array.isArray(rows) ? rows : [];
  return list[0] || null;
}

module.exports = { actorHasPlatformPrivileges, getMembershipInTenant };
