# 旧同步逻辑参考（Legacy）

仍运行但已 MySQL 化：

- `backend/tiktok-api/scheduler.js`
- `backend/lib/readSyncShops.js`（替代 shops.json 主列表）

历史问题文档：`docs/legacy/README.md`（shops.json 串店、shop_id 误写）

审计工具：

- `backend/scripts/auditSyncShops.js`
- `backend/scripts/auditBrokenOrders.js`
