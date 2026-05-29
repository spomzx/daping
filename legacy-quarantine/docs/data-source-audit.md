# 数据源审计

> 分支：`fix/unify-order-data-source`  
> 原则：**SaaS + 实时大屏契约 API 仅 MySQL**；`orders-cache.json` / `gmv-cache.json` 仅运维/同步副产物，**禁止**作为统计主读源。

## 页面 /legacy（实时大屏）

| 项 | 内容 |
|----|------|
| 接口 | `GET /api/dashboard/summary`、`ranking`、`product-ranking`、`order-volume`、`orders`、`gmv-compare` |
| 当前数据源 | **mysql** |
| 文件位置 | `backend/modules/dashboard/*`、`backend/services/orderMetricsService.js` |
| 是否存在 fallback | **NO**（`DASHBOARD_DATA_SOURCE=cache` 已失效，`isMysqlPrimaryDashboard()` 恒为 true） |
| 风险等级 | **LOW**（契约路径） |

## 页面 /legacy（已废弃聚合）

| 项 | 内容 |
|----|------|
| 接口 | `GET /api/legacy-dashboard`（原 `/api/dashboard`） |
| 当前数据源 | **mysql**（已移除 cache 分支） |
| 文件位置 | `backend/routes/legacyDashboardRoutes.js` |
| 是否存在 fallback | **NO** |
| 风险等级 | **MEDIUM**（仅回滚旧前端时误用） |

## 页面 /analytics（数据总览）

| 项 | 内容 |
|----|------|
| 接口 | `GET /api/analytics/*` |
| 当前数据源 | **mysql** |
| 文件位置 | `backend/modules/analytics/*` |
| 是否存在 fallback | **NO**（`saasMysqlOnly` 中间件阻断 cache 路径） |
| 风险等级 | **LOW** |

## 页面 /dashboard（SaaS 控制台）

| 项 | 内容 |
|----|------|
| 接口 | 同 analytics + `/api/dashboard/summary` |
| 当前数据源 | **mysql** |
| 文件位置 | `backend/modules/dashboard`、`registerApiRoutes.js` |
| 是否存在 fallback | **NO** |
| 风险等级 | **LOW** |

## 店铺管理 /store-management

| 项 | 内容 |
|----|------|
| 接口 | `GET /api/shops`、`POST /api/shops/health/refresh` 等 |
| 当前数据源 | **mysql** |
| 文件位置 | `backend/modules/shops/*` |
| 是否存在 fallback | **NO**（健康刷新已改 MySQL） |
| 风险等级 | **LOW** |

## 实时订单（大屏右侧列表）

| 项 | 内容 |
|----|------|
| 接口 | `GET /api/dashboard/orders` |
| 当前数据源 | **mysql** |
| 文件位置 | `backend/modules/dashboard/warRoomOrders.js` |
| 是否存在 fallback | **NO** |
| 风险等级 | **LOW** |

## OpenAPI 同步 Worker

| 项 | 内容 |
|----|------|
| 接口 | 无 HTTP；`tiktok-openapi-sync` / `scheduler.collectOnce` |
| 当前数据源 | 主写 **mysql**；副写 `orders-cache.json`（**@deprecated**） |
| 文件位置 | `backend/tiktok-api/scheduler.js` |
| 是否存在 fallback | N/A（写盘，非读统计） |
| 风险等级 | **MEDIUM**（cache 文件可能与 MySQL 漂移，不参与 SaaS KPI） |

## Ops 运维

| 项 | 内容 |
|----|------|
| 接口 | `GET /api/ops/orders/reconcile`、`POST /api/ops/orders/rebuild-cache` |
| 当前数据源 | 对账读 cache；重建 **从 MySQL → cache** |
| 文件位置 | `backend/modules/ops/*` |
| 是否存在 fallback | **YES**（仅限运维，非用户大屏） |
| 风险等级 | **LOW**（已隔离在 `/api/ops`） |

## 统一统计入口（本次新增）

| 模块 | 职责 |
|------|------|
| `backend/services/orderMetricsService.js` | summary / ranking / trend / gmv-compare / product-ranking |
| `backend/lib/dataSourceDebug.js` | API 响应 `debug: { source, filter, table }` |
| `backend/modules/dashboard/filterContract.js` | 时间窗 + 状态筛选唯一契约 |

## 统一时间窗（今日）

实现：`getTimeRangeBounds('today')` → 服务器本地自然日 `[00:00:00, now]`（epoch），**非**滚动 24h。

事件时间表达式：

```sql
COALESCE(o.paid_at, o.created_at_platform, o.created_at)
```

## 有效订单（valid）

与 `backend/lib/orderFilter.js` 中 `VALID_CANON` 一致，包含 PAID / COMPLETED / SHIPPED / DELIVERED 等；**不含** UNPAID、CANCELLED；样品单独 `sample` 筛选。

## 前端

| 页面 | 禁止项 | 当前 |
|------|--------|------|
| `/legacy` | `/api/dashboard?` 聚合、local json | 仅契约子接口 |
| 右上角 | — | 临时展示 `DATA: MYSQL \| FILTER: …` |

## 验收 SQL（参考）

```sql
-- 与契约「今日」对齐需在应用层加 tenant / shop / status 条件；裸 CURDATE 仅作数量级核对
SELECT COUNT(DISTINCT platform_order_id)
FROM orders
WHERE DATE(COALESCE(paid_at, created_at_platform, created_at)) = CURDATE();
```

## 剩余风险

1. Worker 仍可能写 `orders-cache.json`（不读则不影响 KPI）。
2. Ops rebuild-cache 若误当作主源需流程约束。
3. Legacy 路由 `/api/legacy-dashboard` 仍存在，勿与新契约混用。
