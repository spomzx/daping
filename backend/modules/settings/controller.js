'use strict';

const svc = require('./service');

async function get(req, res, next) {
  try {
    const tenantId = Number(req.tenantId);
    const out = await svc.getAll(tenantId, req.auth);
    res.json({ ok: true, module: 'settings', ...out });
  } catch (e) {
    next(e);
  }
}

module.exports = { get };
