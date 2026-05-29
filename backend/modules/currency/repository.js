'use strict';

const exchangeRateService = require('../exchangeRateService');

async function getRate(base, target, forceRefresh) {
  if (forceRefresh) {
    await exchangeRateService.refreshRatesFromDb();
  }
  return exchangeRateService.getRate(base, target);
}

async function getHealth() {
  return exchangeRateService.getHealth();
}

module.exports = {
  getRate,
  getHealth,
};
