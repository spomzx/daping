'use strict';

/**
 * @param {unknown} errMsg
 * @param {number} [httpStatus]
 */
function isTokenError(errMsg, httpStatus) {
  if (Number(httpStatus) === 401) return true;
  const s = String(errMsg || '').toLowerCase();
  return (
    s.includes('invalid token') ||
    s.includes('invalid credentials') ||
    s.includes('invalid credential') ||
    s.includes('token expired') ||
    s.includes('token_expired') ||
    s.includes('unauthorized') ||
    s.includes('access_token') ||
    s.includes('refresh_token') ||
    s.includes('refresh_http_') ||
    s.includes('需重新授权') ||
    s.includes('应用配置异常') ||
    s.includes('auth expired') ||
    s === 'expired'
  );
}

function tokenErrorCode(errMsg) {
  const s = String(errMsg || '').toLowerCase();
  if (s.includes('expired')) return 'token_expired';
  if (s.includes('unauthorized') || s.includes('401')) return 'unauthorized';
  return 'token_invalid';
}

module.exports = { isTokenError, tokenErrorCode };
