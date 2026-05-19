# Staging 稳定版 · staging-2026-05-18-stable-v1

| 项 | 值 |
|----|-----|
| **版本号** | `staging-2026-05-18-stable-v1` |
| **锁定日期** | 2026-05-18 |
| **环境** | Staging（`daping-staging`） |
| **状态** | 已锁定 · 一期交付基线 |

## 本版已验收能力

- **tenant / order 数据隔离已修复** — 写入与查询均按登录租户隔离，禁止 dashboard 兜底 tenant 写库
- **orders 全部 `tenant_id=6`** — 当前 staging 租户数据一致（以验收时 DB 快照为准）
- **`orphan_orders=0`** — 无孤儿订单（`tenant_id` 与店铺归属一致）
- **OpenAPI 同步恢复** — `tiktok-openapi-sync` 可正常拉单入库
- **legacy 大屏可用** — `/legacy` War-Room 可访问；设备级响应式 + GMV 趋势空白已修复
- **sync / users 基础 UI 已收口** — 同步中心列与操作区、用户页权限展示符合一期范围

## 范围说明

- 本版本为 **Staging 一期稳定基线**，用于部署回滚与问题对照
- **后续 UI 细节进入二期优化**（响应式微调、动效、表格列宽等），不阻塞本版锁定

## 部署对照（Staging）

```bash
cd /home/admin/daping-staging/frontend && npm run build
cd /home/admin/daping-staging/backend   # 若后端有变更则重启
pm2 restart daping-staging
pm2 restart tiktok-openapi-sync   # 按需
```

## Git 标签（可选，由团队执行）

```bash
git tag -a staging-2026-05-18-stable-v1 -m "Staging stable v1: tenant isolation, legacy dashboard, sync/users UI"
git push origin staging-2026-05-18-stable-v1
```

## 关联文档

- [version-lock.md](../version-lock.md) — 维护期原则与版本索引
- [staging-tenant-cleanup.sql](../staging-tenant-cleanup.sql) — 租户数据清理参考（如有）
