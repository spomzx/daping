# 字段治理 Field Governance v1

> **范围**：大屏数据中台 MySQL 主数据 + Dashboard/SaaS API DTO。  
> **本版只建规则**，不修改数据库结构、KPI contract、filter contract、persist/worker 业务逻辑。

## 1. `orders` 正式字段白名单（DB 层）

以下列为 `orders` 表唯一合法持久化字段（与 `backend/db/schema.sql` 对齐）：

| 字段 | 用途 |
|------|------|
| `id` | 内部主键 |
| `tenant_id` | 租户隔离 |
| `shop_id` | FK → `shops.id` |
| `platform_shop_id` | TikTok 平台店铺 ID |
| `platform` | 平台标识（默认 tiktok） |
| `platform_order_id` | 平台订单号（唯一键组成部分） |
| `shop_name` | 冗余店名 |
| `market` | 市场 |
| `currency` | 原币 |
| `buyer_name` | 买家 |
| `order_status` | **平台原始订单状态**（见 §4） |
| `analytics_status` | **分析统计状态**（见 §3） |
| `total_amount` | 订单原币金额（见 §6） |
| `created_at_platform` | 平台下单时间（见 §5） |
| `paid_at` | 付款时间（见 §5） |
| `raw_json` | 平台原始 JSON（入库/推导用；dashboard 默认 WHERE 不解析） |
| `created_at` | 系统入库时间（见 §5） |
| `updated_at` | 系统更新时间（见 §5） |

**禁止**将未列入白名单的列写入 `orders` 或作为 MySQL 统计主字段。

---

## 2. `shops` 正式字段白名单（DB 层）

| 字段 | 用途 |
|------|------|
| `id` | 主键 |
| `tenant_id` | 租户 |
| `platform` | 平台 |
| `platform_shop_id` | 平台店铺 ID |
| `shop_name` | 店铺名 |
| `display_name` | 展示名 |
| `market` | 市场 |
| `region` | 区域 |
| `currency` | 币种 |
| `hidden` | 是否隐藏 |
| `sync_enabled` | 是否启用同步 |
| `status` | 店铺生命周期（active/disabled/deleted） |
| `auth_status` | OAuth 授权状态 |
| `last_sync_at` | 店铺表上的最近同步时间 |
| `last_order_seen_at` | 最近见单时间 |
| `last_order_count` | 历史/缓存订单计数 |
| `last_gmv_amount` | 历史/缓存 GMV |
| `last_health_status` | 健康状态缓存 |
| `last_health_message` | 健康说明 |
| `last_health_checked_at` | 健康检查时间 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

**关联表**（非 `shops` 列，可经 API 合并）：`shop_sync_status`（`last_error`、`sync_status` 等）、`shop_auth_tokens`。

API 层附加字段（非 DB 列）：`today_orders`、`today_gmv`、`last_sync_error`、`health_label` 等 — 见 `docs/field-contract-map.md`。

---

## 3. 统计状态字段 `analytics_status`

**只允许**以下枚举值写入/筛选（入库由 `deriveAnalyticsStatusFromOrder` 计算）：

- `valid`
- `cancelled`
- `sample`
- `unpaid`
- `other`

**禁止**：

- 将 `paid` 写入 `analytics_status`（`paid` 为 **UI/API orderFilter** 语义，对应 SQL 组合条件，见 `orderFilter.js`）
- 用 `analytics_status` 表示平台原始状态

KPI 默认契约：`analytics_status = 'valid'`（已锁定，本阶段不可改）。

---

## 4. 原始平台状态 `order_status`

- **只保存** TikTok / 平台返回的原始订单状态字符串。
- **禁止**直接作为大屏 KPI / GMV 默认统计口径。
- 统计、筛选默认以 `analytics_status` + dashboard `orderFilter` 为准；`order_status` 仅作展示或 `analytics_status` 为空时的兜底推导（persist 阶段）。

---

## 5. 时间字段

| 字段 | 定义 | 统计用途 |
|------|------|----------|
| `created_at_platform` | 平台下单时间 | **订单日期归属优先字段**；dashboard 时间窗主字段 |
| `paid_at` | 付款时间 | 仅用于 **付款筛选**（`orderFilter=paid` 等）；**不作为**默认 KPI 日期字段 |
| `created_at` | 系统入库时间 | **禁止**用于业务统计日期 / 大屏时间窗 |
| `updated_at` | 系统更新时间 | **禁止**用于业务统计日期 / 大屏时间窗 |

---

## 6. 金额字段

| 字段 | 层 | 定义 |
|------|-----|------|
| `total_amount` | DB `orders` | 订单原币金额；SUM/GMV SQL 主字段 |
| `usd_amount` | DTO | 汇率换算后的 USD；**非** `orders` 表列 |
| `today_gmv` | Dashboard DTO | 店铺今日 GMV（MySQL CURDATE 聚合）；**非** `orders` 表列 |
| `amount` | DTO | 实时订单展示原币；**禁止**代替 `total_amount` 写库 |

---

## 7. Deprecated Fields（废弃字段清单）

以下名称 **可作为短期兼容 alias**（读平台 JSON、旧 cache、诊断脚本），**禁止作为新代码主字段**：

### 时间类

- `createTime` / `createdTime` / `order_create_time`
- `pay_time` / `payment_time`

→ 落库/统计统一：`created_at_platform`、`paid_at`

### 状态类

- `status` 作为 **订单统计状态**（店铺 `shops.status` 除外）
- `paid` 作为 **`analytics_status` 枚举值**

→ 统计：`analytics_status`；UI 筛选：`orderFilter=paid`

### 金额类

- `amount` 直接代替 **`total_amount` 写库**
- `gmv` 作为 **`orders` / `shops` DB 列名**（`last_gmv_amount` 为 shops 缓存列，语义见类型注释）

### 错误类

- `last_sync_error` 作为 **MySQL 表列**（仅 API/DTO：`enrichShopRows` 输出）

### 其它

- 任意未在白名单中的 `orders` / `shops` 新列，须先更新本文档再实现

---

## 8. SELECT * 与接口列清单

1. **Dashboard / BI 查询**：禁止 `SELECT *`；必须显式列出白名单列。
2. **API list**：必须显式列字段（如 `repository.listOrders` SELECT 列表）。
3. **API detail**：可短期保留 `SELECT o.*`，须标记 **deprecated**，新接口须先定义 DTO。
4. **新增接口**：先定义后端返回形状 + 前端 `frontend/src/types/*` 类型，再写查询。

本阶段 **不强制改代码**，仅建立规则；违规由 `diagnose-field-governance.js` 报告。

---

## 9. 诊断与 CI 建议

```bash
cd backend
node scripts/diagnose-field-governance.js
```

- `ok: true`：无 `high_risk_hits`
- `deprecated_field_hits` / `allowed_alias_hits`：供人工审查，不单独判失败

---

## 10. 已锁定链路（本阶段不可改）

- KPI contract（默认 `orderFilter=valid` / `analytics_status=valid`）
- `paid` vs `valid` SQL 语义（`orderFilter.js`）
- Dashboard filter contract（`filterContract.js` / `filterBuilder.js`）
- Order persist 路径
- Worker / sync 调度

相关文档：`docs/field-contract-map.md`、前端 `frontend/src/types/*`。
