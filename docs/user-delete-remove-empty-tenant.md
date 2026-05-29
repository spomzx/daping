# 删除唯一管理员 → 软删除租户

分支：`feature/user-delete-remove-empty-tenant`  
Tag：`staging-user-delete-remove-empty-tenant-v1`

## 删除逻辑

| 场景 | 行为 |
|------|------|
| 删除 viewer | 仅硬删该用户，租户不变 |
| 删除 admin 且仍有其他 active admin | 租户保留 |
| 删除 admin 且无剩余 active admin | 租户 **软删除**（`status=deleted`），列表默认不展示 |
| 删自己 / 最后平台管理员 / cqchic 唯一管理员 | 禁止 |

软删除租户时（同事务在删用户之后）：

- `tenants`: `status=deleted`, `deleted_at=NOW()`, `plan_remark`, `is_active=0`
- `user_tenants` / 剩余 `users`: `status=deleted`
- `user_shop_permissions`: 按 tenant 店铺 DELETE
- `shops`: `sync_enabled=0`, `status=disabled`（已 deleted 的店不动）
- `shop_sync_status`: `sync_status=disabled`
- `sync_jobs`: 未完成 → `cancelled`

## Migration

`backend/db/migrateTenantsDeletedAt42.js`（`node db/init.js` 自动执行）

- 新增 `tenants.deleted_at`
- 将 `status=orphaned` 及无 active 管理员的租户修复为 `deleted`

## 验收

```bash
cd backend && node db/init.js
cd ../frontend && npm run build
# staging: 删「参天树五部」唯一管理员 → 用户列表无该用户，租户列表无该租户
```

## Rollback

```bash
git revert <commit>   # 或 checkout 上一 tag
cd frontend && npm run build
pm2 restart daping-staging --update-env
```

恢复误删租户（手工）：

```sql
UPDATE tenants SET status='active', deleted_at=NULL, plan_remark=NULL, is_active=1 WHERE id=?;
```
