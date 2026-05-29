# 用户删除 → 租户状态同步

分支：`feature/user-delete-tenant-sync-fix`  
Tag：`staging-user-delete-tenant-sync-fix-v1`

## 删除逻辑

| 被删用户 | tenant 状态 |
|----------|-------------|
| 普通 viewer | 不变 |
| 租户 admin（同 tenant 仍有其他 active admin） | 保持 `active` |
| 租户 admin（删除后无 active admin） | ~~orphaned~~ → 见 `user-delete-remove-empty-tenant.md`（`status=deleted` 软删除） |
| 平台 super_admin | 最后一个禁止删除；不影响业务 tenant |
| 当前登录用户 | 400 `cannot_delete_self` |
| cqchic 唯一 admin | 400 `cannot_delete_cqchic_primary_admin` |

事务内顺序：删 `user_shop_permissions` → `user_tenants` → `users` → 按 admin 租户检查并 `UPDATE tenants` → commit → `syncCurrentUsersCache`。

## Rollback

```bash
git checkout staging-sync-stability-phase2-validated-v1
# 或 revert 本 feature commit
cd frontend && npm run build
pm2 restart daping-staging --update-env
```

手工恢复误标 orphaned 的租户（按需）：

```sql
UPDATE tenants SET status = 'active', plan_remark = NULL WHERE status = 'orphaned' AND id = ?;
```
