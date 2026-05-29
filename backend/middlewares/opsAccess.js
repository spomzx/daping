'use strict';

const { isPlatformScope } = require('../lib/userScope');

/** Ops API 仅平台管理员（scope=platform 或 super_admin / platform_admin） */
function requirePlatformOps(req, res, next) {
  if (!req.auth) {
    return res.status(401).json({ error: 'unauthorized', message: '需要登录' });
  }
  if (!isPlatformScope(req.auth)) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Ops API 仅平台管理员可访问',
      ops_only: true,
    });
  }
  return next();
}

/** 标记响应为运维内部接口；允许读取 legacy cache/json（仅写入 MySQL，非 SaaS 展示） */
function markOpsApi(req, res, next) {
  req.allowLegacyCacheRead = true;
  res.set('X-Api-Tier', 'ops');
  res.set('X-Ops-Only', 'true');
  res.set('X-Legacy-Cache-Read', 'ops-only');
  next();
}

/** 旧 SaaS 路径迁移提示（仍允许平台管理员调用以兼容脚本/旧管理页） */
function markDeprecatedSaasOpsPath(req, res, next) {
  res.set('X-Deprecated', 'true');
  res.set('X-Deprecated-Use', req.deprecatedOpsReplacement || '/api/ops');
  res.set('X-Api-Tier', 'ops-deprecated-alias');
  next();
}

function withDeprecatedReplacement(replacementPath) {
  return (req, res, next) => {
    req.deprecatedOpsReplacement = replacementPath;
    return markDeprecatedSaasOpsPath(req, res, next);
  };
}

function attachDeprecationBody(res, payload, replacementPath) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      ...payload,
      _deprecated: true,
      _use_instead: replacementPath,
      _ops_only: true,
    };
  }
  return payload;
}

module.exports = {
  requirePlatformOps,
  markOpsApi,
  markDeprecatedSaasOpsPath,
  withDeprecatedReplacement,
  attachDeprecationBody,
};
