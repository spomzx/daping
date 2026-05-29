'use strict';

const { getMysqlPool } = require('../db/mysqlPool');
const { getUserScope } = require('../lib/dataScope');

/** 解析 req.auth 后挂载 req.dataScope（供 shops 等模块复用） */
async function attachDataScope(req, res, next) {
  if (!req.auth) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const pool = getMysqlPool();
    if (!pool) {
      req.dataScope = await getUserScope(null, req.auth);
      return next();
    }
    req.dataScope = await getUserScope(pool, req.auth);
    return next();
  } catch (e) {
    return next(e);
  }
}

module.exports = { attachDataScope };
