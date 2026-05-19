'use strict';

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ tenant_id?: number|null, user_id: number, title: string, content?: string|null, type?: string }} row
 */
async function insertNotification(pool, row) {
  const title = String(row.title || '').trim().slice(0, 255);
  if (!title) return;
  const tid = row.tenant_id != null && Number.isFinite(Number(row.tenant_id)) ? Number(row.tenant_id) : null;
  const uid = Number(row.user_id);
  if (!Number.isFinite(uid) || uid <= 0) return;
  const content = row.content == null ? null : String(row.content).slice(0, 20000);
  const type = String(row.type || 'system').trim().slice(0, 64) || 'system';
  await pool.execute(
    `INSERT INTO notifications (tenant_id, user_id, title, content, type, is_read)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [tid, uid, title, content, type],
  );
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} userId
 */
async function listNotificationsForUser(pool, userId) {
  const [rows] = await pool.query(
    `SELECT id, tenant_id, user_id, title, content, type, is_read, created_at
     FROM notifications
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 100`,
    [userId],
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} userId
 */
async function countUnreadForUser(pool, userId) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0`,
    [userId],
  );
  const n = rows && rows[0] ? Number(rows[0].c) : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} userId
 * @param {number} notifId
 */
async function markNotificationRead(pool, userId, notifId) {
  const [r] = await pool.execute(
    `UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`,
    [notifId, userId],
  );
  const affected = r && typeof r.affectedRows === 'number' ? r.affectedRows : 0;
  return affected > 0;
}

module.exports = {
  insertNotification,
  listNotificationsForUser,
  countUnreadForUser,
  markNotificationRead,
};
