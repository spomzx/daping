'use strict';

const { getMysqlPool } = require('../db/mysqlPool');
const { getJwtSecret } = require('../config/jwt');
const { normalizeRoleFromDb } = require('../lib/roles');
const { normalizeUserScope } = require('../lib/userScope');
const { refreshAuthScopeFromDb } = require('../lib/authScopeRefresh');

function getBearerToken(req, opts = {}) {
  const allowQueryToken = Boolean(opts.allowQueryToken);
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(\S+)$/i.exec(String(h));
  if (m) return m[1];
  if (allowQueryToken && req.query) {
    const raw = req.query.token ?? req.query.access_token;
    const s = typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0] || '') : '';
    const t = s.trim();
    if (t) return t;
  }
  return null;
}

function createAuthRequired(opts) {
  return function authRequired(req, res, next) {
    const pool = getMysqlPool();
    if (!pool) {
      return res.status(503).json({ error: 'database_unavailable', message: 'MySQL 未配置或不可用' });
    }
    const token = getBearerToken(req, opts);
    if (!token) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return res.status(401).json({ error: 'missing_token' });
    }

    let payload;
    try {
      const jwt = require('jsonwebtoken');
      payload = jwt.verify(token, getJwtSecret());
    } catch {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return res.status(401).json({ error: 'invalid_token' });
    }

    req.auth = {
      user_id: Number(payload.user_id),
      tenant_id: Number(payload.tenant_id),
      role: normalizeRoleFromDb(String(payload.role || '')),
      username: String(payload.username || ''),
      scope: normalizeUserScope(payload.scope),
    };

    if (!req.auth.user_id || !req.auth.tenant_id || !req.auth.role) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return res.status(401).json({ error: 'invalid_token_payload' });
    }

    refreshAuthScopeFromDb(req.auth)
      .then(() => {
        if (String(process.env.DEBUG_AUTH_SCOPE || '').trim() === '1') {
          console.log('[scope]', req.auth);
        }
        next();
      })
      .catch((e) => {
        console.warn('[authRequired] scope refresh failed:', e?.message || e);
        next();
      });
  };
}

const authRequired = createAuthRequired({ allowQueryToken: false });
/** 浏览器整页跳转（无 Authorization 头）时允许 query ?token=JWT */
const authRequiredAllowQueryToken = createAuthRequired({ allowQueryToken: true });

module.exports = { authRequired, authRequiredAllowQueryToken, getBearerToken };
