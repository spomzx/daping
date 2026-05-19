# Staging 版本记录

## phase2-saas-mysql-only-stable

| 项 | 值 |
|----|-----|
| **版本名** | `phase2-saas-mysql-only-stable` |
| **Git 标签** | `phase2-stable-v1` |
| **记录日期** | 2026-05-19 |
| **状态** | Phase2 Stable（已验收） |

### 已完成

- [x] `deploy-staging.sh` 发布成功（`[INFO] STAGING DEPLOY SUCCESS`）
- [x] `rollback.sh staging` 回滚成功（`[INFO] ROLLBACK SUCCESS`）
- [x] SaaS 路由冒烟：`npm run check:saas-routes` → **ALL OK**（无 404/500）
- [x] `registerApiRoutes` → **mounted=15 failed=0**
- [x] SaaS 主链路 **MySQL-only** 锁定（legacy cache/json 不参与 SaaS API）
- [x] `/api/operation-logs`、`/api/logs` 独立挂载正常

### 当前环境

| 环境 | 路径 | PM2 进程 | 健康检查端口 |
|------|------|----------|--------------|
| **Staging** | `/home/admin/daping-staging` | `daping-staging` | `3081` → `http://127.0.0.1:3081/api/health` |
| **Production** | `/home/admin/daping-prod` | `daping-prod` | `3080` → `http://127.0.0.1:3080/api/health` |

### 相关文档

- [docs/deployment/phase2-stable-release.md](docs/deployment/phase2-stable-release.md)
- [docs/audit/phase2-mysql-only.md](docs/audit/phase2-mysql-only.md)
- [docs/audit/phase2-saas-routes-fix.md](docs/audit/phase2-saas-routes-fix.md)

### 备注

- OpenAPI 同步 worker：`tiktok-openapi-sync`（全局单实例，通常由 staging 侧运维维护）
- Legacy 大屏：`/legacy` + `GET /api/dashboard`（war-room）仍保留，与 SaaS 主链路隔离
