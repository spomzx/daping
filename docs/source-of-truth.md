# Source of Truth（字段真源）

> 每个业务概念 **只有一个写库/统计真源**；其它字段为 DTO、缓存或 Deprecated alias。  
> 禁止前端/页面自行推导替代真源（见 `field-governance-rules.md`）。

---

## 授权 / Token

| 概念 | 真源 | 禁止 |
|------|------|------|
| 访问令牌 | `shop_auth_tokens.access_token` | `shops` 表存 token；前端 `token missing` 启发式 |
| 刷新令牌 | `shop_auth_tokens.refresh_token` | 别名 `token` / `auth_token` 作新主字段 |
| 店铺 cipher | `shop_auth_tokens.raw_auth_json`（`shop_cipher` 键） | 独立 `shops.shop_cipher` 列（不存在） |
| 令牌是否有效 | `shop_sync_status.is_token_valid` + `token_expire_at` | 仅凭 `shops.auth_status` 或 `shops.status=active` |

**页面规则**：展示「未授权 / token 失效」必须来自 API 的 `sync_status` / `is_token_valid` / `health_status`，禁止本地 `!access_token` 猜测。

---

## 订单统计状态

| 概念 | 真源 | 禁止 |
|------|------|------|
| KPI / 大屏筛选 | `orders.analytics_status` | `order_status` 直接作 KPI WHERE |
| UI「付款订单」 | Query `orderFilter=paid`（SQL 组合条件） | `analytics_status = 'paid'` 写库或筛选 |
| 平台原始状态 | `orders.order_status` | 与 `analytics_status` 混用 |

枚举真源：`valid` | `cancelled` | `sample` | `unpaid` | `other`。

---

## 订单业务日期

| 概念 | 真源 | 禁止 |
|------|------|------|
| 下单日 / 时间窗 | `orders.created_at_platform` | `orders.created_at` 作 BI/大屏日期 |
| 付款筛选 | `orders.paid_at` | `paid_at` 作默认 KPI 日期 |
| 入库审计 | `orders.created_at` | 参与 dashboard 时间窗 |

平台 JSON 的 `createTime` 等 **仅** 在 persist 边界映射 → `created_at_platform`。

---

## GMV / 金额

| 概念 | 真源 | 禁止 |
|------|------|------|
| 订单金额 | `orders.total_amount` | DTO `amount` 写库；`gmv` 作 orders 列 |
| 聚合 GMV | `SUM(total_amount)`（+ 汇率模块） | `SUM(ROUND(...))` 非标准 rollup；`points.reduce` 作 KPI |
| 今日店铺 GMV | API `today_gmv`（查询 DTO） | `today_gmv` 写回 `shops` / `orders` |
| USD 展示 | 汇率表 + `amountToUsdWithStatus` | 未登记字段名混用 |

---

## 同步与健康

| 概念 | 真源 | 禁止 |
|------|------|------|
| 同步状态 | `shop_sync_status.sync_status` | 用 `shops.status` 推断同步失败 |
| 最近错误 | `shop_sync_status.last_error` | 用 `shops.last_health_message` 覆盖同步错误 |
| 列表健康摘要 | API `health_status` + `display` 契约 | 前端覆盖 `last_error` 文案 |
| OpenAPI 错误摘要 | DTO `last_sync_error` | MySQL 列 `last_sync_error` |

---

## Dashboard 契约（已锁定，本阶段不可改）

| 链路 | 真源模块 |
|------|----------|
| 默认 KPI 筛选 | `LOCKED_KPI_ORDER_FILTER = valid` |
| paid vs valid | `backend/lib/orderFilter.js` |
| 模块统一筛选 | `filterContract.js` + `filterBuilder.js` |
| 订单入库 | `orderPersistenceService.js` |

---

## 多真源冲突处理

若代码出现两个字段表达同一语义（如 `createTime` 与 `created_at_platform`）：

1. 写库 / SQL 仅用 canonical（registry）  
2. 读平台 JSON 允许 alias → 立即映射  
3. 在 `deprecated-fields.md` 登记 alias  
4. `diagnose-field-registry.js` 的 `multiple_truth_hits` 会报告未在白名单路径的并存用法
