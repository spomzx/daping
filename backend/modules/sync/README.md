# sync 模块（阶段四）

## 数据流

```
readSyncShops (MySQL)
  → shopSyncRunner.syncOneShop
      → TikTok OpenAPI fetchTodayOrders
      → orderPersistenceService (MySQL)
      → syncShopLogService (sync_shop_logs)
  → scheduler.collectOnce (legacy orders-cache 合并，不扩展)
```

## API

- `GET /api/sync/status`
- `GET /api/sync/logs`
- `POST /api/sync/run/:shopId`
- `POST /api/sync/retry/:shopId`

## 日志状态

`running` → `success` | `failed` | `partial_success`
