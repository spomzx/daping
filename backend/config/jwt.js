'use strict';

function getJwtSecret() {
  const s = String(process.env.JWT_SECRET || '').trim();
  if (!s) throw new Error('JWT_SECRET is required');
  return s;
}

function getJwtExpiresIn() {
  return String(process.env.JWT_EXPIRES_IN || '7d').trim() || '7d';
}

module.exports = { getJwtSecret, getJwtExpiresIn };
