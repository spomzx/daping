# Field Contract Registry v2

> 大屏 SaaS 数据中台 **字段注册表（真源清单）**。  
> 本 registry 只定义契约，不修改业务实现。  
> 关联：`source-of-truth.md`、`deprecated-fields.md`、`dto-contracts.md`、`field-governance-rules.md`（v1：`field-governance.md`）。

---

## A. Tenant / User

### `tenants`（DB）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT PK | 租户 ID |
| `tenant_code` | VARCHAR(64) UK | 租户编码 |
| `tenant_name` | VARCHAR(255) | 租户名称 |
| `status` | VARCHAR(32) | 租户状态（registry 别名 `tenant_status`） |
| `plan_type` | VARCHAR(64) | 套餐（registry 别名 `tenant_plan`） |
| `timezone` | VARCHAR(64) | 时区 |
| `base_currency` | VARCHAR(8) | 基准币 |
| `max_shops` | INT | 店铺上限（registry 别名 `max_shop_count`） |
| `created_at` | DATETIME(3) | 创建时间 |
| `updated_at` | DATETIME(3) | 更新时间 |

### `users`（DB）

| 字段 | 说明 |
|------|------|
| `id` | 用户 ID |
| `username` | 登录名 |
| `password_hash` | 密码哈希 |
| `display_name` / `email` / `phone` / `contact` | 资料 |
| `status` | 用户状态 |
| `scope` | `tenant` \| `platform` |
| `last_login_at` | 最近登录 |
| `created_at` / `updated_at` | 审计时间 |

> `tenant_id` 不在 `users` 表；租户关系见 `user_tenants`。

### `user_tenants`（DB）

| 字段 | 说明 |
|------|------|
| `user_id` | FK → users |
| `tenant_id` | FK → tenants |
| `role` | `platform_admin` \| `tenant_admin` \| `user`（及扩展 code） |
| `status` | 成员状态 |
| `created_at` | 绑定时间 |

### `roles`（DB，可选扩展）

| 字段 | 说明 |
|------|------|
| `role_code` | 角色代码 |
| `role_name` | 展示名 |

---

## B. Shops

### `shops`（DB）

| 字段 | 说明 |
|------|------|
| `id` | 主键 |
| `tenant_id` | 租户 |
| `platform` | 平台（默认 tiktok） |
| `platform_shop_id` | 平台店铺 ID |
| `shop_name` | 店铺名 |
| `display_name` | 展示名 |
| `market` / `region` | 市场 / 区域 |
| `currency` | 币种 |
| `sort_order` | 排序 |
| `hidden` | **展示字段**（列表隐藏，非删除） |
| `sync_enabled` | 是否参与同步 |
| `remarks` | 备注 |
| `imported_from_cache` | 是否来自 cache 导入 |
| `last_cache_sync_at` | cache 同步时间 |
| `status` | **店铺生命周期**（active/disabled/deleted） |
| `auth_status` | OAuth 摘要；**不是 token 真源** |
| `last_sync_at` | 店铺表上的同步时间戳 |
| `last_order_seen_at` | 最近见单 |
| `last_order_count` / `last_gmv_amount` | 历史缓存计数/GMV |
| `last_health_status` / `last_health_message` / `last_health_checked_at` | 健康缓存 |
| `created_at` / `updated_at` | 审计时间 |

**禁止**：在 `shops` 表存储 `access_token` / `refresh_token`。

---

## C. Auth Token

### `shop_auth_tokens`（DB）

| 字段 | 说明 |
|------|------|
| `id` | 主键 |
| `tenant_id` | 租户 |
| `shop_id` | FK → shops |
| `platform` | 平台 |
| `access_token` | **Token 真源** |
| `refresh_token` | 刷新令牌 |
| `token_expire_at` | 访问令牌过期 |
| `refresh_token_expire_at` | 刷新令牌过期 |
| `scope_json` | 授权 scope |
| `raw_auth_json` | 原始授权 JSON（可含 `shop_cipher`） |
| `created_at` / `updated_at` | 审计时间 |

| 概念 | 说明 |
|------|------|
| `shop_cipher` | 存于 `raw_auth_json` 或运行时从 OpenAPI 解析；**加密缓存**，非独立 DB 列 |
| `token` / `auth_token` | **Deprecated**，见 `deprecated-fields.md` |

---

## D. Sync / Health

### `shop_sync_status`（DB）

| 字段 | 说明 |
|------|------|
| `shop_id` + `platform` | 复合主键 |
| `tenant_id` | 租户 |
| `sync_status` | idle / success / failed / token_expired / … |
| `last_sync_at` | 最近同步尝试 |
| `last_success_sync_at` | 最近成功同步 |
| `last_error` | 最近错误文本 |
| `last_error_code` | 错误码 |
| `sync_fail_count` | 连续失败次数 |
| `is_token_valid` | 令牌是否有效（摘要） |
| `token_expired_at` | 令牌过期时间 |
| `current_job_id` / `sync_lock_until` / `avg_sync_ms` | 运维字段 |
| `updated_at` | 更新时间 |

### API enrich（非 `shop_sync_status` 列）

| 字段 | 来源 |
|------|------|
| `health_status` | `enrichShopRows` / 健康 v2 计算 |
| `health_label` | `applyShopListDisplayContract` |
| `health_reason` | 同上 |
| `last_sync_error` | OpenAPI 摘要 DTO |
| `display` / `sync_label` | 列表展示契约 |

**禁止**：页面仅凭 `shops.status=active` 推断 token 有效；须读 `shop_sync_status` + `shop_auth_tokens`。

---

## E. Orders

### `orders`（DB）

| 字段 | 说明 |
|------|------|
| `id` | 主键 |
| `tenant_id` | 租户 |
| `shop_id` | FK → shops.id |
| `platform_shop_id` | 平台店铺 ID |
| `platform` | 平台 |
| `platform_order_id` | 平台订单号 |
| `shop_name` | 冗余店名 |
| `market` | 市场 |
| `currency` | 原币 |
| `buyer_name` | 买家 |
| `order_status` | **平台原始状态** |
| `analytics_status` | **统计状态**（valid/unpaid/sample/cancelled/other） |
| `total_amount` | 原币金额 |
| `created_at_platform` | **业务日期真源** |
| `paid_at` | 付款时间 |
| `raw_json` | 平台 JSON |
| `created_at` | 入库时间（非 BI 日期） |
| `updated_at` | 更新时间（非 BI 日期） |

---

## F. Order Items

### `order_items`（DB）

| 字段 | 说明 |
|------|------|
| `id` | 主键 |
| `tenant_id` | 租户 |
| `order_id` | FK → orders.id |
| `platform` / `platform_order_id` | 关联订单 |
| `platform_item_id` | 行 ID |
| `shop_id` / `shop_name` / `market` | 冗余 |
| `product_id` / `sku_id` | 商品/SKU |
| `product_name` / `sku_name` | 名称 |
| `quantity` | 数量 |
| `currency` | 币种 |
| `unit_price` | 单价 |
| `total_amount` | 行金额（registry 别名 `item_amount` → 用 `total_amount`） |
| `raw_json` | 原始 JSON |
| `created_at_platform` | 平台时间 |
| `created_at` / `updated_at` | 审计 |

---

## G. Dashboard KPI（Query Result DTO）

非 DB 列；由 dashboard 模块聚合返回。

| DTO 字段 | 典型来源 | 说明 |
|----------|----------|------|
| `today_orders` | SUM/COUNT orders | 今日订单数 |
| `today_gmv` | SUM(total_amount) + FX | 今日 GMV（USD 契约见 summary） |
| `average_order_value` | gmv/orders | 客单价 |
| `ranking_total_gmv` | ranking 模块 | 店铺排行 GMV |
| `trend_total_gmv` | gmv-compare 曲线合计 | 趋势 GMV |
| `valid_orders` / `paid_orders` / … | 诊断/分解计数 | **paid_orders ≠ analytics_status=paid** |

KPI 锁定：`orderFilter=valid` → `analytics_status=valid`（见 `orderFilter.js`）。

---

## H. Currency

### `exchange_rates`（DB）

| 字段 | 说明 |
|------|------|
| `base_currency` | 源币种（registry 别名 `source_currency`） |
| `target_currency` | 目标币种 |
| `rate` | 汇率（registry 别名 `exchange_rate`） |
| `source` | 数据来源 |
| `effective_at` | 生效时间 |
| `created_at` / `updated_at` | 审计 |

---

## I. Frontend DTO 命名

| 层 | 规则 |
|----|------|
| DB / API list | `snake_case` |
| 前端类型（可选 camelCase） | 须在 `frontend/src/types/*` 或 `dto-contracts.md` 登记 |

| DB | camelCase（类型层） |
|----|---------------------|
| `created_at_platform` | `createdAtPlatform` |
| `analytics_status` | `analyticsStatus` |
| `order_status` | `orderStatus` |
| `total_amount` | `totalAmount` |
| `platform_order_id` | `platformOrderId` |
| `last_sync_error` | `lastSyncError` |
| `last_error` | `lastError` |
| `last_error_full` | `lastErrorFull` |
| `today_gmv` | `todayGmv` |
| `today_orders` | `todayOrders` |
| `health_status` | `healthStatus` |
| `health_label` | `healthLabel` |

Legacy 作战室 payload（`WarRoomShopMetric`）使用 camelCase，**不与** `ShopListApiRow` 混用。

---

## 登记流程

1. 新增 DB 列 → 更新本 registry + `schema.sql` 迁移说明  
2. 新增 API 字段 → 更新 `dto-contracts.md` + `frontend/src/types/*`  
3. 废弃字段 → `deprecated-fields.md`  
4. CI / staging：`node backend/scripts/diagnose-field-registry.js`
