# Legacy JSON 架构（已降级）

本目录记录 **单页 BI / JSON 驱动** 时期的遗留设计，仅供备份与一次性迁移参考。

## 不再作为主业务源

| 文件 | 原用途 | 现用途 |
|------|--------|--------|
| `storage/shops.json` | OpenAPI 同步店铺列表 | 备份 / `importLegacyShopsJson.js` |
| `storage.local.bak/shops.json` | 历史备份 | 归档 / 单店导入 Cavera |
| `storage/orders-cache.json` | 大屏主统计 | worker 合并缓存、reconcile、**禁止主统计** |

## 当前唯一主源（SSOT）

- **MySQL**：`shops`、`shop_auth_tokens`、`orders`、`order_items`、`tenants`、`users`
- **统一读取**：`backend/lib/readSyncShops.js`
- **Dashboard**：`DASHBOARD_DATA_SOURCE=mysql`（默认）

## 环境变量

```env
OPENAPI_SHOPS_SOURCE=mysql   # 默认
OPENAPI_SHOPS_SOURCE=json    # 紧急回滚，禁止生产默认
DASHBOARD_DATA_SOURCE=mysql
```

## 迁移 / 修复脚本

```bash
node backend/db/migrateOrders30PlatformShopId.js  # 经 repairOrderShopMapping 调用
node backend/scripts/importLegacyShopsJson.js --tenant_id=1
node backend/scripts/repairOrderShopMapping.js
node backend/scripts/rebuildOrdersCacheFromMysql.js --tenant_id=1
node backend/scripts/auditSyncShops.js
node backend/scripts/auditBrokenOrders.js
```

## 旧逻辑说明

- `pickDashboardShop()` 曾优先 `CQ Chic Jewelry`，导致调试 API 单店偏差
- `orders.shop_id` 曾被误写为 `platform_shop_id`，已通过 migration + repair 修正
- 健康「同步停滞」曾仅看 cache/json，现已改为 `shops.last_sync_at` + MySQL 订单窗口
