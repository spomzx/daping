# 隔离诊断 / 迁移脚本

自 `backend/scripts/` 迁入。运行方式：

```bash
cd backend
node legacy-quarantine/scripts/<name>.js
```

`require` 已指向 `backend/` 下模块（`../../db`、`../../tiktok-api` 等）。  
勿在生产 cron 中引用；仅 staging 排障或一次性迁移。
