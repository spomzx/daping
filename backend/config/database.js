'use strict';

/**
 * @returns {{ host: string, port: number, user: string, password: string, database: string }}
 */
function getMysqlConfig() {
  const host = String(process.env.DB_HOST || '').trim();
  const user = String(process.env.DB_USER || '').trim();
  const database = String(process.env.DB_NAME || '').trim();
  const password = process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : '';
  const port = Number(process.env.DB_PORT || 3306);
  if (!host || !user || !database) {
    throw new Error('DB_HOST, DB_USER, DB_NAME are required for MySQL');
  }
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('DB_PORT must be a positive number');
  }
  return { host, port, user, password, database };
}

function isMysqlConfigured() {
  try {
    getMysqlConfig();
    return true;
  } catch {
    return false;
  }
}

module.exports = { getMysqlConfig, isMysqlConfigured };
