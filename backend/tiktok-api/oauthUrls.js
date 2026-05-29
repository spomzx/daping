'use strict';

/** TikTok Shop OAuth token 端点（与 open-api 业务 API 分离，无需 sign） */
const OAUTH_TOKEN_GET_URL =
  process.env.TIKTOK_OAUTH_TOKEN_URL || 'https://auth.tiktok-shops.com/api/v2/token/get';
const OAUTH_TOKEN_REFRESH_URL =
  process.env.TIKTOK_OAUTH_TOKEN_REFRESH_URL || 'https://auth.tiktok-shops.com/api/v2/token/refresh';

module.exports = {
  OAUTH_TOKEN_GET_URL,
  OAUTH_TOKEN_REFRESH_URL,
};
