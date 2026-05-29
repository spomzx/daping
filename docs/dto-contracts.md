# DTO Contracts

> 登记所有 **允许前端直接使用** 的 API 形状。新增 DTO 必须先更新本文档 + `frontend/src/types/*`。  
> DB 真源见 `field-registry.md`；废弃名见 `deprecated-fields.md`。

---

## 1. `ShopListApiRow`

| 属性 | 类型 | 来源 | nullable | 前端可直接用 |
|------|------|------|----------|------------|
| `id` | number | `shops.id` | 否 | 是 |
| `tenant_id` | number | `shops` | 是 | 是 |
| `platform_shop_id` | string | `shops` | 否 | 是 |
| `shop_name` / `display_name` | string | `shops` | display 可空 | 是 |
| `market` / `region` | string | `shops` | 是 | 是 |
| `status` | string | `shops.status` | 否 | 是（生命周期，非订单状态） |
| `sync_status` | string | `shop_sync_status` | 是 | 是 |
| `last_error` / `last_error_full` | string | `shop_sync_status` | 是 | 是（展示；可被 display 契约清空） |
| `last_sync_error` | string | enrich OpenAPI | 是 | 是（title/tooltip） |
| `today_orders` / `today_gmv` | number | MySQL CURDATE 聚合 | 是 | 是（KPI 列） |
| `health_status` / `health_label` | string | enrich + display | 是 | 是（优先于 last_error 盖 UI） |
| `display` | string | display 契约 | 是 | 是 |
| `is_token_valid` | bool/0/1 | `shop_sync_status` | 是 | 是 |
| `health_debug` | object | 调试 | 是 | 仅 debug 模式 |

**类型文件**：`frontend/src/types/shopListApi.ts`  
**API**：`GET /api/shops` → `{ list, shops, total, page, page_size, meta }`

---

## 2. `OrdersListItem`

| 属性 | 类型 | 来源 | nullable | 前端可直接用 |
|------|------|------|----------|------------|
| `id` | number | `orders.id` | 否 | 是 |
| `platform_order_id` | string | `orders` | 否 | 是 |
| `shop_id` / `platform_shop_id` | number/string | `orders` | 是 | 是 |
| `shop_name` / `market` / `currency` | string | `orders` | 是 | 是 |
| `buyer_name` | string | `orders` | 是 | 是 |
| `order_status` | string | 平台原始 | 是 | 展示；不作 KPI 筛选 |
| `analytics_status` | string | 分析状态 | 是 | 是（列表状态列） |
| `total_amount` | number | `orders` | 否 | 是 |
| `created_at_platform` | string | `orders` | 是 | 是 |
| `paid_at` | string | `orders` | 是 | 是 |
| `updated_at` | string | `orders` | 是 | 是 |

**类型文件**：`frontend/src/types/ordersListApi.ts`  
**API**：`GET /api/orders/list` → `{ items, total, page, page_size }`

---

## 3. `OrderRealtimeDto`

| 属性 | 类型 | 来源 | nullable | 前端可直接用 |
|------|------|------|----------|------------|
| `platform_order_id` | string | `orders` | 否 | 是 |
| `shop_id` / `shop_name` / `market` | — | join/enrich | 是 | 是 |
| `amount` / `original_amount` | number | 计算 | 否 | 是（展示原币） |
| `usd_amount` | number | FX | 是 | 是 |
| `usd_pending` | boolean | FX 失败 | 是 | 是 |
| `items` | number | `order_items` SUM | 否 | 是 |
| `is_sample` | boolean | `analytics_status` | 是 | 是 |
| `created_at_platform` | string | `orders` | 否 | 是 |
| `order_level` / `market_color` | — | UI 元数据 | 是 | 是 |

**类型文件**：`frontend/src/types/orderRealtimeDto.ts`  
**API**：`GET /api/dashboard/orders`、`GET /api/analytics/recent-orders`

---

## 4. `DashboardSummaryKpi`（DashboardSummaryDto）

解析自 `GET /api/dashboard/summary`，**非** DB 行。

| 属性 | 类型 | 来源 API 字段 | nullable | 前端可直接用 |
|------|------|---------------|----------|------------|
| `currentGmvUsd` | number | `gmv` / `gmv_usd` / `today_gmv_usd` | 是 | 是（禁止静默 0） |
| `previousGmvUsd` | number | `compare.gmv` / `yesterday_gmv` | 是 | 是 |
| `changePercent` | number | `compare.changePercent` | 是 | 是 |
| `orders` | number | `orders` | 是 | 是 |
| `shopCount` | number | `shop_count` | 是 | 是 |
| `gmvCurrency` | string | `gmv_currency` | 否 | 是 |
| `debug` | object | `debug` | 是 | DEV / 排障 |

**类型文件**：`frontend/src/lib/dashboardSummaryKpi.ts`（`parseDashboardSummaryKpi`）  
**锁定**：KPI 默认 `orderFilter=valid`，本阶段不可改 contract。

---

## 5. `DashboardTrendDto`（WarRoomGmvCompareNormalized）

| 属性 | 类型 | 来源 | nullable | 前端可直接用 |
|------|------|------|----------|------------|
| `todaySeries` / `yesterdaySeries` | `{ bucket, gmv }[]` | gmv-compare | 否 | 是 |
| `todayTotal` / `yesterdayTotal` | number | 曲线合计 | 是 | 是 |
| `gmv_currency` | string | meta | 否 | 是 |
| `meta` | object | 缓存/契约 | 是 | 排障 |

**类型文件**：`frontend/src/lib/normalizeGmvCompareResponse.ts`  
**API**：`GET /api/dashboard/gmv-compare`

别名：`trend_total_gmv` = `todayTotal` + 对比逻辑（文档化，非 DB 列）。

---

## 6. `ShopHealthDto`（`ShopListApiRow` 健康子集）

无独立类型文件；健康展示 **必须** 使用 `ShopListApiRow` 下列字段：

| 字段 | 用途 |
|------|------|
| `health_status` | 状态码 |
| `health_label` | 列表 pill 文案 |
| `health_reason` | tooltip |
| `display` | 契约优先级（today_no_orders / ok / auth_error） |
| `sync_status` / `sync_label` | 同步列 |
| `is_token_valid` | 禁止前端自行推导 token |

**禁止**：组件内 `token missing` 字符串拼接覆盖 API `health_label`。

---

## 其它已登记 DTO（简表）

| 名称 | 文件 | API |
|------|------|-----|
| `WarRoomShopMetric` | `legacy/LegacyDashboardPage.tsx` | war-room payload |
| `SyncShopRow` | `services/api/sync.ts` | `/api/sync/status` |
| `ShopsListApiResponse` | `types/shopListApi.ts` | `/api/shops` |
| `OrdersListApiResponse` | `types/ordersListApi.ts` | `/api/orders/list` |

未登记类型 → `diagnose-field-registry.js` → `unregistered_dto_hits`。
