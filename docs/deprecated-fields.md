# Deprecated Fields Registry

> 以下字段 **可短期作为兼容 alias 存在**，**禁止作为新代码主字段**。  
> 登记字段须同步更新 `diagnose-field-registry.js` 模式表。

| 字段 / 模式 | risk | replacement | migration_status |
|-------------|------|-------------|------------------|
| `createTime` | high | `created_at_platform`（DB）；persist 边界读取平台 JSON | allowed_at_ingest |
| `createdTime` | high | `created_at_platform` | pending_removal |
| `order_create_time` | high | `created_at_platform` | pending_removal |
| `pay_time` | high | `paid_at` | pending_removal |
| `payment_time` | high | `paid_at` | pending_removal |
| `paid` as `analytics_status` | critical | `orderFilter=paid` + SQL in `orderFilter.js` | locked_semantics |
| `status` as order analytics | high | `analytics_status` | pending_removal |
| `amount` as DB order column | critical | `total_amount` | pending_removal |
| `gmv` as DB column | critical | `total_amount` / `today_gmv` DTO | pending_removal |
| `item_amount` (order_items) | medium | `order_items.total_amount` | renamed_in_schema |
| `token` (generic) | high | `access_token` | pending_removal |
| `auth_token` | high | `access_token` | pending_removal |
| `last_sync_error` as DB column | critical | API DTO only (`enrichShopRows`) | never_in_mysql |
| `todayGmv` (camelCase DTO) | low | `today_gmv` API snake_case；类型层 `todayGmv` 须登记 | dto_only |
| `totalGmv` | medium | `today_gmv` / `ranking_total_gmv` | dto_only |
| `usdAmount` without type | medium | `usd_amount` / `OrderRealtimeDto.usd_amount` | register_in_types |
| `shop_cipher` on `shops` table | critical | `raw_auth_json.shop_cipher` | never_on_shops |
| `tenant_status` | low | `tenants.status` | alias_only |
| `tenant_plan` | low | `tenants.plan_type` | alias_only |
| `max_shop_count` | low | `tenants.max_shops` | alias_only |
| `source_currency` | low | `exchange_rates.base_currency` | alias_only |
| `exchange_rate` column name | low | `exchange_rates.rate` | alias_only |
| `SELECT *` on dashboard/BI | medium | explicit column list | deprecated_detail_ok |

### migration_status 说明

| 值 | 含义 |
|----|------|
| `allowed_at_ingest` | 仅 tiktok-api / persist / reconcile 可读平台字段 |
| `dto_only` | 仅响应或前端类型，不落库 |
| `locked_semantics` | 文档化语义，禁止“修复”为 analytics 枚举 |
| `pending_removal` | 新代码禁止；存量逐步收敛 |
| `never_in_mysql` | 不得进入 CREATE/ALTER TABLE |

### 允许读取 alias 的路径（非 deprecated hit）

- `backend/modules/orders/orderPersistenceService.js`
- `backend/tiktok-api/**`
- `backend/db/orderRepository.js`
- `backend/scripts/diagnose-*`
- `docs/**`

详见 `diagnose-field-registry.js` → `ALLOWED_ALIAS_FILE_RE`。
