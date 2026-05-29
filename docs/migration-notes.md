# 迁移说明（分阶段）

## 原则

1. 每阶段可独立上线，保证登录 + 核心页可用。
2. 不一次性删除旧大屏。
3. MySQL = SSOT；JSON = cache / archive / rollback only。

## 阶段状态

| 阶段 | 内容 | 状态 |
|------|------|------|
| 1 | 全项目审计 | ✅ 见 `audit-phase1-report.md` |
| 2 | 模块目录边界 | ✅ README + legacy 占位 |
| 3 | 数据库确认 | ✅ 见 `database-map.md` |
| 4 | 店铺模块 | 待做：全量可见 + 分页 |
| 5 | 授权明细页 | 待做 |
| 6 | 订单中心页 | 待做 |
| 7 | 同步中心 + sync_logs | 待做 |
| 8 | Dashboard 统一 `/analytics` | 待做 |
| 9 | 权限收口 | 部分已有 userScope |
| 10 | 旧大屏清理 | 待做 |

## Staging 检查命令

```bash
node backend/scripts/auditSyncShops.js
node backend/scripts/auditBrokenOrders.js
node backend/scripts/repairOrderShopMapping.js   # 先 dry-run 可加 --dry-run
```

## 环境

```env
DASHBOARD_DATA_SOURCE=mysql
OPENAPI_SHOPS_SOURCE=mysql
```
