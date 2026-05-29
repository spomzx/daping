'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const {
  listUsersForActor,
  createUserByActor,
  setUserStatusByActor,
  resetPasswordByActor,
  approvePendingTenantOwner,
  rejectPendingTenantOwner,
  deleteUserByActor,
} = require('./service');
const shopPermSvc = require('./shopPermissionsService');
const { auditFromRequest } = require('../operation-logs/audit');

function parseIdParam(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function list(req, res) {
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  const out = await listUsersForActor(pool, req.auth, req.query || {});
  if (!out.ok) {
    return res.status(out.status || 500).json({ error: out.error });
  }
  return res.json({
    list: out.list,
    users: out.users,
    total: out.total,
    page: out.page,
    page_size: out.page_size,
  });
}

async function assignableShops(req, res) {
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  const out = await shopPermSvc.listAssignableShopsForActor(pool, req.auth);
  if (!out.ok) {
    return res.status(out.status || 500).json({ error: out.error });
  }
  return res.json({ shops: out.shops });
}

async function getShopPermissions(req, res) {
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  const id = parseIdParam(req.params.id || req.params.userId);
  if (!id) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const out = await shopPermSvc.getUserShopPermissions(pool, req.auth, id);
  if (!out.ok) {
    return res.status(out.status || 500).json({ error: out.error, message: out.message });
  }
  return res.json({ user_id: out.user_id, shops: out.shops });
}

async function putShopPermissions(req, res) {
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  const id = parseIdParam(req.params.id || req.params.userId);
  if (!id) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const shopIds = req.body && req.body.shop_ids;
  const out = await shopPermSvc.setUserShopPermissions(pool, req.auth, id, shopIds);
  if (!out.ok) {
    return res.status(out.status || 500).json({ error: out.error, message: out.message });
  }
  return res.json({ ok: true, user_id: out.user_id, shops: out.shops });
}

async function create(req, res) {
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  const out = await createUserByActor(pool, req.auth, req.body || {});
  if (!out.ok) {
    return res.status(out.status || 500).json({
      error: out.error,
      message: out.message,
    });
  }
  await auditFromRequest(pool, req, {
    action: 'create_user',
    module: 'users',
    targetType: 'user',
    targetId: out.user?.id,
    afterData: { user: out.user },
    status: 'success',
  });
  return res.status(201).json({ user: out.user });
}

async function patchStatus(req, res) {
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  const id = parseIdParam(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const status = req.body && req.body.status;
  const out = await setUserStatusByActor(pool, req.auth, id, status);
  if (!out.ok) {
    return res.status(out.status || 500).json({ error: out.error });
  }
  await auditFromRequest(pool, req, {
    action: 'update_user_status',
    module: 'users',
    targetType: 'user',
    targetId: id,
    afterData: { status },
    status: 'success',
  });
  return res.json({ ok: true });
}

async function resetPassword(req, res) {
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  const id = parseIdParam(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const password = req.body && req.body.password;
  const out = await resetPasswordByActor(pool, req.auth, id, password);
  if (!out.ok) {
    return res.status(out.status || 500).json({ error: out.error });
  }
  return res.json({ ok: true });
}

async function approve(req, res) {
  const pool = getMysqlPool();
  if (!pool) return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  const id = parseIdParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const out = await approvePendingTenantOwner(pool, req.auth, id);
  if (!out.ok) return res.status(out.status || 500).json({ error: out.error });
  return res.json({ ok: true });
}

async function reject(req, res) {
  const pool = getMysqlPool();
  if (!pool) return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  const id = parseIdParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const out = await rejectPendingTenantOwner(pool, req.auth, id);
  if (!out.ok) return res.status(out.status || 500).json({ error: out.error });
  return res.json({ ok: true });
}

async function removeUser(req, res) {
  const pool = getMysqlPool();
  if (!pool) return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  const id = parseIdParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const out = await deleteUserByActor(pool, req.auth, id);
  if (!out.ok) {
    const body = { error: out.error };
    if (out.message) body.message = out.message;
    return res.status(out.status || 500).json(body);
  }
  await auditFromRequest(pool, req, {
    action: 'delete_user',
    module: 'users',
    targetType: 'user',
    targetId: id,
    status: 'success',
    detail_json:
      Array.isArray(out.tenants_deleted) && out.tenants_deleted.length
        ? { tenants_deleted: out.tenants_deleted }
        : undefined,
  });
  return res.json({
    ok: true,
    success: true,
    tenants_deleted: out.tenants_deleted || [],
  });
}

module.exports = {
  list,
  create,
  patchStatus,
  resetPassword,
  approve,
  reject,
  removeUser,
  assignableShops,
  getShopPermissions,
  putShopPermissions,
};
