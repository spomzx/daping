# 已废弃数据源清单

> **DO NOT USE** 于 SaaS、实时大屏、分析页 KPI/排行/趋势统计。

## 文件级

| 资源 | 原用途 | 状态 |
|------|--------|------|
| `backend/storage/orders-cache.json` | Legacy 大屏、对账 | @deprecated 仅 Ops/同步副产物 |
| `backend/storage/gmv-cache.json` | Legacy 汇率、店铺导入 | @deprecated 已改 `exchange_rates` + API |
| `backend/storage/shops.json` | 旧店铺列表 | @deprecated SaaS 用 MySQL `shops` |

## 环境变量

| 变量 | 原用途 | 状态 |
|------|--------|------|
| `DASHBOARD_DATA_SOURCE=cache` | Legacy 读 orders-cache | @deprecated **无效**（`isMysqlPrimaryDashboard()` 恒 true） |

## 代码路径

| 模块 | 说明 |
|------|------|
| `tiktok-api/ordersDashboardFromCache.js` | @deprecated 仅 `/api/legacy-dashboard` 聚合壳 |
| `routes/legacyDashboardRoutes.js` | @deprecated 410 旧 `/api/dashboard`；活跃路径 `/api/legacy-dashboard` |
| `modules/shops/importCacheShops.js` | @deprecated Ops 导入 |
| `modules/orders/orderCacheRebuildService.js` | @deprecated MySQL → cache 重建 |
| `scripts/rebuildOrdersCacheFromMysql.js` | @deprecated 运维脚本 |

## 函数 / 模式（禁止在新代码出现）

```javascript
// @deprecated DO NOT USE
readJsonCache()
fallbackToJson()
if (!mysqlData) return readOrdersCache()
```

## 替代方案

| 能力 | 使用 |
|------|------|
| 今日订单 / GMV | `orderMetricsService.getTodayOrderSummary` → `/api/dashboard/summary` |
| 排行 | `orderMetricsService.getShopRanking` |
| 趋势 / 订单量 | `orderMetricsService.getOrderTrend` |
| GMV 对比 | `orderMetricsService.getGmvCompare` |
| 实时订单 | `GET /api/dashboard/orders` |
| 汇率 | `buildSaaSFxContext` / `exchange_rates` 表 |

## 统一 debug 响应

```json
{
  "debug": {
    "source": "mysql",
    "filter": "valid_orders_today",
    "table": "orders"
  }
}
```
