'use strict';

/**
 * 必须在 server / worker / 任何读取 process.env 的业务模块之前 require 本文件。
 */
const path = require('path');

const envFile = path.resolve(__dirname, '.env');

if (!global.__BACKEND_ENV_BOOTSTRAPPED__) {
  global.__BACKEND_ENV_BOOTSTRAPPED__ = true;

  const result = require('dotenv').config({ path: envFile });

  console.info('[env-check]', {
    cwd: process.cwd(),
    envFile,
    envLoaded: result.error == null,
    envError: result.error ? String(result.error.message || result.error) : undefined,
    portPresent: Boolean(process.env.PORT),
    dbNamePresent: Boolean(process.env.DB_NAME),
    tiktokAppKeyPresent: Boolean(process.env.TIKTOK_APP_KEY),
    tiktokAppKeyLength: process.env.TIKTOK_APP_KEY ? String(process.env.TIKTOK_APP_KEY).length : 0,
    tiktokAppSecretPresent: Boolean(process.env.TIKTOK_APP_SECRET),
    tiktokAppSecretLength: process.env.TIKTOK_APP_SECRET
      ? String(process.env.TIKTOK_APP_SECRET).length
      : 0,
    nodeEnv: process.env.NODE_ENV || null,
    appEnv: process.env.APP_ENV || null,
  });
}

module.exports = { envFile };
