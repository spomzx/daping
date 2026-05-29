# 服务器文件权限指南（daping-staging）

## 问题现象

在 `/home/admin/daping-staging` 若混用 **root** 与 **admin** 执行命令，常见错误：

- `npm install` → `EACCES: permission denied`
- `chmod` / 解压备份 → `Operation not permitted`
- `rollback` / `backup` 写入 `backups/` 失败
- PM2 以 admin 运行，但 `node_modules` 属主为 root

## 原则

| 规则 | 说明 |
|------|------|
| **不要用 root 跑 npm** | `npm install`、`npm run build` 一律用 **admin** |
| **统一部署用户** | 发布、回滚、备份均用 **admin** |
| **统一部署入口** | `bash scripts/deploy/deploy-staging.sh` |
| **不改业务配置** | 本指南不修改 `.env` 内容，仅修正属主与权限 |

## 一键修复

在服务器上（建议已切换到 admin，或具备 sudo）：

```bash
cd /home/admin/daping-staging
chmod +x scripts/maintenance/fix-permissions.sh
bash scripts/maintenance/fix-permissions.sh
```

脚本将执行：

1. `sudo chown -R admin:admin /home/admin/daping-staging`（含 `node_modules`）
2. 目录 `find … -type d -exec chmod 755 {} \;`
3. 文件 `find … -type f -exec chmod 644 {} \;`
4. `scripts/deploy|rollback|health|maintenance/*.sh` → `chmod +x`
5. 输出 `ls -ld` 检查项：
   - `/home/admin/daping-staging`
   - `/home/admin/daping-staging/backend/node_modules`
   - `/home/admin/daping-staging/scripts/deploy`

> **说明**：脚本不修改 `.env` 文件内容；`.env` 会随整体 `chown` 归 admin 所有，避免 root 创建后 admin 无法读取。

## 日常部署流程（推荐）

```bash
# 1. 使用 admin 登录
whoami   # 应为 admin

# 2. 若曾用 root 操作过，先修权限
bash scripts/maintenance/fix-permissions.sh

# 3. 拉代码后部署
cd /home/admin/daping-staging
git pull   # 按团队方式
bash scripts/deploy/deploy-staging.sh

# 4. 可选 API 检查
bash scripts/health/check-api.sh staging
```

## 禁止做法

- `sudo npm install` / 以 root 进入项目目录执行 npm
- root 执行 `deploy-staging.sh` 后再用 admin 跑 PM2（易产生属主不一致）
- 手动 `chmod -R 777`（安全隐患，且不能替代正确 owner）

## 与备份 / 回滚的关系

- **备份**（`deploy-prod.sh` 或模板）写入 `${APP_ROOT}/backups/` 时，目录须可写且属主为 admin。
- **回滚**（`scripts/rollback/rollback.sh`）解压覆盖 `frontend/`、`backend/` 等时，须对目标路径有写权限。

权限异常时，先执行 `fix-permissions.sh`，再重试部署或回滚。

## Production（daping-prod）

生产目录 `/home/admin/daping-prod` 若出现相同问题，可复制本脚本中的 `APP_ROOT` 为 prod 路径后执行相同步骤，或单独维护 `fix-permissions-prod.sh`（当前仓库默认仅写死 staging 路径）。

## 相关文档

- [staging-workflow.md](./staging-workflow.md) — Staging 发布
- [rollback-guide.md](./rollback-guide.md) — 回滚
- `scripts/maintenance/fix-permissions.sh` — 权限修复脚本
