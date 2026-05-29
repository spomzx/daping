# 字段契约映射 Field Contract Map

> DB 层统一 **snake_case**；API 可返回 snake_case（当前主路径）或在类型层声明 **camelCase**。  
> 禁止页面组件「猜字段」；禁止后端随意新增未文档化的 alias。

## 规则摘要

1. **MySQL**：仅使用 `field-governance.md` 白名单列名。
2. **API list**：显式 SELECT → 响应 snake_case 与 DB 一致（如 `/api/orders/list`）。
3. **API enrich/DTO**：允许附加计算字段，须在类型文件或本文档登记。
4. **前端**：优先 `frontend/src/types/*.ts`；camelCase 仅出现在 Legacy war-room payload，须单独类型（`WarRoomShopMetric`）。
5. **兼容 alias**：仅允许在 ingest/诊断层读取平台字段，映射后写入 canonical 列。

---

## `orders` 映射

| DB / API snake_case | 推荐 camelCase（若封装） | 层 | 说明 |
|---------------------|-------------------------|-----|------|
| `id` | `id` | DB | 主键 |
| `tenant_id` | `tenantId` | DB | |
| `shop_id` | `shopId` | DB | |
| `platform_shop_id` | `platformShopId` | DB | |
| `platform_order_id` | `platformOrderId` | DB/API | |
| `shop_name` | `shopName` | DB/API | |
| `market` | `market` | DB/API | |
| `currency` | `currency` | DB/API | |
| `buyer_name` | `buyerName` | DB/API | |
| `order_status` | `orderStatus` | DB/API | 平台原始状态 |
| `analytics_status` | `analyticsStatus` | DB/API | 统计状态 |
| `total_amount` | `totalAmount` | DB/API | 原币金额 |
| `created_at_platform` | `createdAtPlatform` | DB/API | 业务日期主字段 |
| `paid_at` | `paidAt` | DB/API | 付款筛选 |
| `created_at` | `createdAt` | DB | 入库时间，非统计日期 |
| `updated_at` | `updatedAt` | DB/API | |
| — | `amount` | DTO only | 实时单展示原币，见 `OrderRealtimeDto` |
| — | `usd_amount` | `usdAmount` | DTO only | 汇率换算，非 DB 列 |
| — | `usd_amount` | DTO | `/api/dashboard/orders` |

**禁止映射为 DB 列**：`createTime` → 必须映射到 `created_at_platform`；`pay_time` → `paid_at`。

**UI `orderFilter=paid`**：查询参数，**不等于** `analytics_status='paid'`。

---

## `shops` 映射

| DB / API snake_case | 推荐 camelCase | 层 | 说明 |
|---------------------|----------------|-----|------|
| `id` | `id` | DB | |
| `tenant_id` | `tenantId` | DB | |
| `platform_shop_id` | `platformShopId` | DB/API | |
| `shop_name` | `shopName` | DB/API | |
| `display_name` | `displayName` | DB/API | |
| `last_error` | `lastError` | API（`shop_sync_status`） | 同步错误 |
| `last_error_full` | `lastErrorFull` | API | 与 `last_error` 同源全文 |
| `last_sync_error` | `lastSyncError` | **DTO only** | OpenAPI 摘要，非 DB 列 |
| `last_gmv_amount` | `lastGmvAmount` | DB/API | 历史缓存；enrich 后常≈今日 KPI |
| `today_gmv` | `todayGmv` | DTO only | CURDATE 聚合 |
| `today_orders` | `todayOrders` | DTO only | CURDATE 计数 |
| `health_status` | `healthStatus` | API | 健康 v2 |
| `health_label` | `healthLabel` | API | 展示文案 |
| `sync_status` | `syncStatus` | API | `shop_sync_status` |
| `display` | `display` | API | 列表展示契约 |

**Legacy war-room（camelCase，非 `/api/shops`）**：

| Payload 字段 | 含义 |
|--------------|------|
| `shopId` | 店铺筛选键（platform_shop_id 小写或 id 字符串） |
| `todayOrders` / `todayGmvBase` / `todayGmvTarget` | 作战室 KPI 卡片，来源 `/api/dashboard/summary` 等 |

类型：`WarRoomShopMetric`（`LegacyDashboardPage.tsx`）。

---

## 前端类型入口

| 契约 | 文件 |
|------|------|
| `GET /api/shops` 列表 | `frontend/src/types/shopListApi.ts` → `ShopListApiRow` |
| `GET /api/orders/list` | `frontend/src/types/ordersListApi.ts` → `OrdersListItem` |
| 实时/分析订单 DTO | `frontend/src/types/orderRealtimeDto.ts` → `OrderRealtimeDto` |

新增字段流程：**本文档 → `field-governance.md` → 类型文件 → 后端 SELECT/DTO → 诊断脚本通过**。
