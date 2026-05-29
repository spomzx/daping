'use strict';

const mysql = require('mysql2/promise');
const { getMysqlConfig, isMysqlConfigured } = require('../config/database');

/** @type {import('mysql2/promise').Pool | null} */
let _pool = null;

function getMysqlPool() {
  if (_pool) return _pool;
  if (!isMysqlConfigured()) return null;
  const cfg = getMysqlConfig();
  _pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 10,
  });
  return _pool;
}

module.exports = { getMysqlPool };
