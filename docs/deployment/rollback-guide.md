# 回滚指南

当 Staging / Production 发布后出现严重问题时，按本指南回滚。项目内 `scripts/rollback/rollback.example.sh` 为**仅提示模板**，不自动删除或覆盖文件。

## 1. 何时回滚

- `/api/health` 持续非 200
- 核心功能不可用（登录、租户、订单、同步等）
- 数据库迁移导致数据异常且无法快速修复
- 灰度阶段错误率超过约定阈值

## 2. 快速回滚（蓝绿）

若使用蓝绿部署且**旧槽位未销毁**：

1. 将流量切回上一活跃槽位（在负载均衡 / 网关操作，非本仓库脚本）。
2. 执行健康检查：
   ```bash
   export API_BASE_URL="https://your-host.example"
   export RUN_CURL=1
   bash scripts/health/check-api.example.sh
   ```
3. 通知相关方回滚完成。

## 3. 基于备份的回滚

### 3.1 确认备份

在 `BACKUP_DIR`（默认 `${APP_ROOT}/backups`）找到：

- `backup_yyyyMMdd_HHmmss.tar.gz` — 含 `frontend/`、`backend/`、`scripts/`、`docs/`、`package.json`（排除 `node_modules`、`dist`、`logs`、`.git`）；由 `deploy-staging.sh` 发布前自动创建
- 可选：`db_yyyyMMdd_HHmmss.sql` — 数据库快照

### 3.2 恢复代码（自动脚本）

**Staging：**

```bash
cd /home/admin/daping-staging
bash scripts/rollback/rollback.sh staging
```

**Production：**

```bash
bash /home/admin/daping-prod/scripts/rollback/rollback.sh prod
```

脚本将：选取最新 `backup_*.tar.gz` → 解压到 `/tmp/daping-rollback-*` → `rsync -a --delete --no-owner --no-group --omit-dir-times` 覆盖项目（排除 `node_modules` / `dist` / `.env` / `backups`）→ `npm install` / `npm run build` → `pm2 restart` → 健康检查；失败时输出 `pm2 logs --lines 100`。

仍可按模板人工步骤（`rollback.example.sh`）：

1. 再次备份**当前**故障版本（便于事后分析）。
2. 解压目标 `backup_*.tar.gz` 到临时目录。
3. 将 `frontend`、`backend`、`legacy`、`docs` 同步回 `APP_ROOT`。
4. **不要**在未确认的情况下执行 `rm -rf`。

### 3.3 恢复数据库

若本次发布执行了迁移：

```bash
# 示例，连接信息以环境为准
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" < "${BACKUP_DIR}/db_<timestamp>.sql"
```

无 DB 备份时，按迁移记录的逆向 SQL 执行。

### 3.4 重启应用

由运维执行（模板不调用 pm2）：

```bash
# 示例
pm2 restart <your-app-name>
pm2 logs <your-app-name> --lines 100
```

## 4. 回滚后验证

| 检查项 | 方式 |
|--------|------|
| 健康 | `GET /api/health` |
| 登录 | `GET /api/auth/me` |
| 租户 | `GET /api/tenants` |
| 业务 | 登录大屏、抽单店铺 |

使用：

```bash
export API_BASE_URL="https://your-host.example"
export AUTH_TOKEN="<token>"
export RUN_CURL=1
bash scripts/health/check-api.example.sh
```

## 5. 事故记录（建议）

- 回滚开始 / 结束时间
- 使用的 `backup_*.tar.gz` / `db_*.sql` 文件名
- Git commit / 发布单号
- 根因与后续改进项

## 6. 预防

- 每次发布前强制执行 `backup-project.sh`
- Staging 与 Prod 使用相同模板流程
- 数据库变更必须可逆或具备快照

## 7. 相关文档

- [staging-workflow.md](./staging-workflow.md)
- [prod-workflow.md](./prod-workflow.md)
