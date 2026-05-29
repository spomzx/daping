# 发布前备份排除规则

`scripts/backup/create-deploy-backup.sh` 在 `deploy-staging` / `deploy-prod` 发布前生成 `backups/backup_YYYYMMDD_HHmmss.tar.gz`。

## 目的

备份用于**回滚代码**，不得打包会随业务变化的运行时文件（否则 `tar` 可能因文件变更失败，例如 `backend/storage/backups/orders-cache.json`）。

## 纳入

- `frontend/`、`backend/`、`scripts/`、`docs/`
- 根目录 `package.json` / `package-lock.json`（若存在）

## 排除（tar --exclude）

| 模式 | 说明 |
|------|------|
| `node_modules/` | 依赖目录 |
| `dist/` | 前端构建产物（发布脚本会重新 build） |
| `logs/`、`*.log` | 日志 |
| `.git/` | 版本库 |
| `backups/` | 历史备份包自身 |
| `backend/storage/` | 运行时 storage（含 cache、locks） |
| `backend/storage/backups/` | 订单缓存等 |
| `backend/storage/.locks/` | 锁文件 |
| `backend/data/*.db` | SQLite 主库 |
| `backend/data/*.db-shm` / `*.db-wal` | SQLite 附属文件 |

## 验收

```bash
cd /home/admin/daping-staging
bash scripts/deploy/deploy-staging.sh
```

期望：

1. 备份阶段日志**不出现**打包 `backend/storage/backups/orders-cache.json`
2. 输出 `STAGING DEPLOY SUCCESS`
3. `curl -s http://127.0.0.1:3081/api/health` 正常
