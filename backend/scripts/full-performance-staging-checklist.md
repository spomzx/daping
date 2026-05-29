# Staging 全链路性能操作清单（只读检测）

配合 `docs/full-performance-audit-report.md` 在 staging 执行。

## 环境开关

```bash
export DASHBOARD_PERF_PROBE=1
export SYNC_PERF_PROBE=1
# 可选 A/B：暂停 sync
# pm2 stop tiktok-openapi-sync
# pm2 stop daping-staging  # 仅当独立 sync worker 进程名存在时
```

## 日志采集

```bash
pm2 logs daping-staging --lines 8000 | tee /tmp/daping-api.log
pm2 logs tiktok-openapi-sync --lines 3000 | tee /tmp/sync.log 2>/dev/null || true

grep '\[perf-probe\]' /tmp/daping-api.log
grep '\[sync-perf-probe\]' /tmp/sync.log
grep '\[sync-queue\]' /tmp/daping-api.log
grep 'shop-sync-result' /tmp/sync.log
```

## 浏览器 Network（Chrome DevTools）

过滤：`/api/dashboard`

| 操作 | 记录 |
|------|------|
| 首次打开 | 请求数、瀑布最慢项 |
| Ctrl+Shift+R | 同上 |
| today→yesterday | 新增请求列表 |
| paid→all→valid | 每次切换请求数 |
| market ALL→TH | 请求数 |
| 点击排行店铺→全部 | 请求数 |
| 静置 5min | 轮询次数（orders/summary/ranking 各几次） |

## EXPLAIN

```bash
cd backend && node scripts/dashboard-perf-explain.js --tenantId=6
```

## 索引

```sql
SHOW INDEX FROM orders;
SHOW INDEX FROM order_items;
SELECT analytics_status, COUNT(*) c FROM orders WHERE tenant_id=6 GROUP BY 1;
```
