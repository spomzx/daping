# 旧缓存（Legacy）

| 文件 | 角色 |
|------|------|
| `backend/storage/orders-cache.json` | Worker 合并缓存；reconcile 对照 |
| `backend/storage/gmv-cache.json` | 汇率侧车；非订单 SSOT |

禁止作为主统计源。重建：`node backend/scripts/rebuildOrdersCacheFromMysql.js`
