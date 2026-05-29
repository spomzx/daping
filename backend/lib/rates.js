'use strict';

const dayjs = require('dayjs');
const exchangeRateService = require('../modules/exchangeRateService');

const BASE_CURRENCY = exchangeRateService.BASE_CURRENCY;
const SUPPORTED_CURRENCIES = exchangeRateService.SUPPORTED_CURRENCIES;

function safeAmount(value, digits = 2, defaultValue = 0) {
  if (!Number.isFinite(value)) return defaultValue;
  return Number(value.toFixed(digits));
}

function normalizeTargetCurrency(value) {
  return exchangeRateService.normalizeTargetCurrency(value);
}

function normalizeBaseCurrency(value) {
  return exchangeRateService.normalizeBaseCurrency(value);
}

async function getConversionRate(base, target, _forceRefresh = false) {
  if (_forceRefresh) {
    await exchangeRateService.refreshRatesFromDb();
  }
  return exchangeRateService.getConversionRate(base, target);
}

function getFallbackRate() {
  throw new exchangeRateService.MissingExchangeRateError('FALLBACK_DISABLED');
}

module.exports = {
  BASE_CURRENCY,
  SUPPORTED_CURRENCIES,
  safeAmount,
  normalizeBaseCurrency,
  normalizeTargetCurrency,
  getConversionRate,
  getFallbackRate,
};
