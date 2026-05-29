'use strict';

const repo = require('./repository');
const { normalizeBaseCurrency, normalizeTargetCurrency, getConversionRate } = require('../../lib/rates');
const exchangeRateService = require('../exchangeRateService');

function parseForceRefresh(rawForce) {
  const v = String(rawForce || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

async function getExchangeRate(query) {
  const base = normalizeBaseCurrency(query?.base);
  const target = normalizeTargetCurrency(query?.target);
  const forceRefresh = parseForceRefresh(query?.force);
  await repo.getRate(base, target, forceRefresh);
  const ratePayload = await getConversionRate(base, target, false);
  return {
    baseCurrency: ratePayload.baseCurrency,
    targetCurrency: ratePayload.targetCurrency,
    rate: ratePayload.rate,
    updatedAt: ratePayload.updatedAt,
    source: ratePayload.source,
    status: ratePayload.status,
  };
}

async function getExchangeRateHealth() {
  return repo.getHealth();
}

function mapHttpError(res, err) {
  return exchangeRateService.mapExchangeRateHttpError(res, err);
}

module.exports = {
  getExchangeRate,
  getExchangeRateHealth,
  mapHttpError,
};
