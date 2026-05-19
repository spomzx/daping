'use strict';

const { getJwtSecret } = require('../config/jwt');
const { normalizeRoleFromDb } = require('../lib/roles');
const { normalizeUserScope } = require('../lib/userScope');
const { refreshAuthScopeFromDb } = require('../lib/authScopeRefresh');
const { getBearerToken } = require('./authRequired');

/**
 * 有 Bearer 且合法则写入 req.auth；无 token 或无效 token 不拦截（大屏兼容未登录）。
 * 使用 Promise 链而非 async/await，避免 Express 4 在 await 完成前进入下一中间件。
 */
function optionalAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return next();

  let payload;
  try {
    const jwt = require('jsonwebtoken');
    payload = jwt.verify(token, getJwtSecret());
  } catch {
    return next();
  }

  const userId = Number(payload.user_id);
  const tenantId = Number(payload.tenant_id);
  const role = normalizeRoleFromDb(String(payload.role || ''));
  if (!userId || !tenantId || !role) return next();

  req.auth = {
    user_id: userId,
    tenant_id: tenantId,
    role,
    username: String(payload.username || ''),
    scope: normalizeUserScope(payload.scope),
  };

  refreshAuthScopeFromDb(req.auth)
    .then(() => {
      if (String(process.env.DEBUG_AUTH_SCOPE || '').trim() === '1') {
        console.log('[scope]', req.auth);
      }
      next();
    })
    .catch((e) => {
      console.warn('[optionalAuth] scope refresh failed:', e?.message || e);
      next();
    });
}

module.exports = { optionalAuth };
