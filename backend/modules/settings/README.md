# Settings 模块

- `GET /api/settings` — `system_settings` + `exchange_rates`（**MySQL only**，不读 gmv-cache.json）
- 汇率空表时：SaaS 走实时 API / 内置 fallback，不回退 gmv-cache

运维：`node backend/scripts/migrateGmvCacheToExchangeRates.js` 可将历史 gmv-cache 灌入 `exchange_rates`。
