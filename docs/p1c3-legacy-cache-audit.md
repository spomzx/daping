# P1-C.3 Legacy JSON Cache 审计

> **任务**：P1-C.3  
> **纪律**：不得删除 `orders-cache.json` / `gmv-cache.json` / `shops.json` 相关代码，仅标记 deprecated。

## 1. SaaS API 是否仍读取这些 JSON

| 文件 | SaaS `/api/*` 直接读取 | 说明 |
|------|------------------------|------|
| `storage/orders-cache.json` | **否** | `orderMetricsService`、dashboard query 均走 MySQL + `withDashboardCache` |
| `storage/gmv-cache.json` | **否** | 汇率与 GMV 来自 `exchange_rates` + orders 聚合 |
| `storage/shops.json` | **否** | 店铺列表来自 MySQL `shops`；`shopHealthService` 明确 no fallback |

仍引用路径的 **非 SaaS API** 场景（legacy / ops）：

| 位置 | 角色 |
|------|------|
| `tiktok-api/scheduler.js` | **legacy worker only** — OpenAPI 同步可写 `orders-cache.json`（`DASHBOARD_MYSQL_ONLY=1` 时禁用） |
| `tiktok-api/shops.js` | **legacy worker only** — `OPENAPI_SHOPS_SOURCE=json` 紧急回滚 |
| `modules/shops/importCacheShops.js` | **ops import only** — 需 `allowLegacyCacheRead` |
| `scripts/migrateGmvCacheToExchangeRates.js` 等 | 一次性迁移脚本 |

## 2. Worker 写入标记

- `orders-cache.json`：`scheduler.js` 顶部 `@deprecated legacy worker only`
- `shops.json`：`shops.js` 顶部 `@deprecated legacy worker / 紧急回滚 only`
- `gmv-cache.json`：无活跃 worker 写入；仅迁移/导入脚本读取

## 3. SaaS API 禁止直接读取

策略由 `lib/saasMysqlOnly.js` 与 `assertLegacyStorageReadAllowed` 门禁；`auditSaasUnification.js` 扫描 `modules/`、`routes/`、`services/` 下无未标注的 JSON 读路径。

**结论**：SaaS Dashboard / Shops / Orders API **禁止**直接读取上述 JSON；缓存层仅为 **memory + `dashboard_*_cache` 表 + MySQL fact**。
