'use strict';

const { parseDashboardFilterQuery } = require('../dashboard/filterContract');

const MARKET_TIMEZONE_MAP = {
  TH: 'Asia/Bangkok',
  MY: 'Asia/Kuala_Lumpur',
  SG: 'Asia/Singapore',
  PH: 'Asia/Manila',
  VN: 'Asia/Ho_Chi_Minh',
};

function toIsoFromSec(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function normalizeRangeLabel(range) {
  const r = String(range || 'today').trim().toLowerCase();
  if (r === 'last7') return '7d';
  if (r === 'last30') return '30d';
  return r;
}

function marketFromQuery(query) {
  const raw = String(query?.market ?? query?.region ?? 'ALL').trim().toUpperCase();
  return raw || 'ALL';
}

function timezoneFromMarket(market) {
  if (MARKET_TIMEZONE_MAP[market]) {
    return {
      timezone: MARKET_TIMEZONE_MAP[market],
      fallback: false,
    };
  }
  return {
    timezone: 'UTC',
    fallback: true,
  };
}

function buildTimeWindow(tenantId, query, options = {}) {
  const contract = parseDashboardFilterQuery(query || {}, Number(tenantId));
  const market = marketFromQuery(query || {});
  const tz = timezoneFromMarket(market);
  return {
    market,
    timezone: tz.timezone,
    timezoneFallback: tz.fallback,
    range: normalizeRangeLabel(contract.timeRange),
    displayRange: normalizeRangeLabel(contract.timeRange),
    startAt: toIsoFromSec(contract.startSec),
    endAt: toIsoFromSec(contract.endSec),
    serverNow: new Date().toISOString(),
    browserDisplayAllowed: options.browserDisplayAllowed !== false,
  };
}

function withTimeWindow(payload, tenantId, query, options = {}) {
  const base = payload && typeof payload === 'object' ? payload : { data: payload };
  return {
    ...base,
    timeWindow: buildTimeWindow(tenantId, query, options),
  };
}

module.exports = {
  buildTimeWindow,
  withTimeWindow,
};
