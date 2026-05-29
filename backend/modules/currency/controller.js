'use strict';

const svc = require('./service');

async function exchangeRate(req, res) {
  try {
    const out = await svc.getExchangeRate(req.query || {});
    res.json(out);
  } catch (e) {
    const mapped = svc.mapHttpError(res, e);
    if (mapped) return mapped;
    return res.status(500).json({ error: 'exchange_rate_failed', message: String(e?.message || e) });
  }
}

async function health(req, res) {
  try {
    const out = await svc.getExchangeRateHealth();
    res.json(out);
  } catch (e) {
    return res.status(500).json({ error: 'exchange_rate_health_failed', message: String(e?.message || e) });
  }
}

module.exports = {
  exchangeRate,
  health,
};
