'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { listNotificationsForUser, markNotificationRead, countUnreadForUser } = require('./service');

async function list(req, res) {
  const pool = getMysqlPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  const rows = await listNotificationsForUser(pool, req.auth.user_id);
  const unread = await countUnreadForUser(pool, req.auth.user_id);
  return res.json({ notifications: rows, unread_count: unread });
}

async function patchRead(req, res) {
  const pool = getMysqlPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  const ok = await markNotificationRead(pool, req.auth.user_id, id);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  return res.json({ ok: true });
}

module.exports = { list, patchRead };
