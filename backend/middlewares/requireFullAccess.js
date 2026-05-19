'use strict';

const { getMysqlPool } = require('../db/mysqlPool');
const { getMeProfile } = require('../modules/users/service');

/**
 * 禁止 pending_review / disabled / deleted 访问需写权限或 BI 数据接口。
 */
function requireFullAccess(req, res, next) {
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({ error: 'database_unavailable', message: 'MySQL 不可用' });
  }
  void (async () => {
    try {
      const row = await getMeProfile(pool, req.auth.user_id, req.auth.tenant_id);
      if (!row) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(401).json({ error: 'inactive_account' });
      }
      const us = String(row.user_status || '');
      const ms = String(row.membership_status || '');
      const ts = String(row.tenant_status || '');
      if (us === 'disabled' || us === 'deleted' || ms === 'disabled' || ms === 'deleted') {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(401).json({ error: 'inactive_account' });
      }
      if (ts === 'disabled' || ts === 'deleted') {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(401).json({ error: 'inactive_account' });
      }
      if (us === 'pending_review' || ms === 'pending_review' || ts === 'pending_review') {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(403).json({ error: 'account_pending_review' });
      }
      if (us !== 'active' || ms !== 'active' || ts !== 'active') {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(403).json({ error: 'inactive_account' });
      }
      return next();
    } catch (e) {
      console.error('[requireFullAccess]', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'internal_error' });
    }
  })();
}

module.exports = { requireFullAccess };
