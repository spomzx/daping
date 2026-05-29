# 数据库映射（阶段十锁定）

> 表结构本阶段**不修改**。权限与 tenant 规则见 `docs/system-architecture.md`。

## 核心表

| 逻辑模块 | 物理表 | tenant_id | 备注 |
|----------|--------|-----------|------|
| 租户 | `tenants` | — | |
| 用户 | `users` | — | `scope`: tenant / platform |
| 用户-租户-角色 | `user_tenants` | ✓ | **仍用 role 字符串**；`roles` 表仅种子兼容 |
| 店铺 | `shops` | ✓ | `platform_shop_id` = TikTok ID |
| 授权 token | `shop_auth_tokens` | ✓ | shop_cipher 在 raw_auth_json |
| 订单 | `orders` | ✓ | `shop_id` → `shops.id` |
| 订单行 | `order_items` | ✓ | |
| 操作日志 | `operation_logs` | ✓ | |
| 同步任务 | `sync_jobs` | ✓ | 粗粒度任务 |
| 同步店铺日志 | `sync_shop_logs` | ✓ | **阶段四**：worker + 手动 sync 写入；含 fetched/inserted/updated/duration |
| 系统配置 | `system_settings` | ✓/NULL | 租户或全局键值 |
| 汇率 | `exchange_rates` | — | **SaaS 主源**；`gmv-cache.json` 仅 legacy；迁移 `scripts/migrateGmvCacheToExchangeRates.js` |
| 角色（预留） | `roles` | — | 不替代 user_tenants.role |
| 权限（预留） | `permissions` | — | 后续 RBAC |

## 关联规则（强制）

```
orders.shop_id          = shops.id
orders.platform_shop_id = shops.platform_shop_id
shop_auth_tokens.shop_id = shops.id
```

## Migration

| 脚本 | 作用 |
|------|------|
| `db/migrateSaaS31Tables.js` | sync_shop_logs / system_settings / exchange_rates / roles / permissions |
| `db/migrateOrders30PlatformShopId.js` | orders.platform_shop_id + shop_id 误写修复（由 migrate35 链式调用） |
| `db/migrateOrders34PlatformShopId.js` | orders.platform_shop_id 列/索引/回填（由 migrate35 调用） |
| `db/migrateOrders35PlatformShopIdAudit.js` | **staging 审计**：orders + sync_shop_logs.platform_shop_id、索引、回填 |
| `db/migrateSyncShopLogs32.js` | sync_shop_logs 阶段四字段；**先补** platform_shop_id 再 ADD platform |
| `db/init.js` | 全量 schema + 链式 migrate（含 migrate35） |
