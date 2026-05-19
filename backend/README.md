# Backend（本地 GMV API）

## 端口

- 默认监听 **`http://localhost:3001`**（`server.js` 中 `PORT`，未设置环境变量时）。
- 可通过环境变量 **`PORT`** 覆盖（见 `.env` / `.env.example`）。

## MySQL（远程）

- 数据库配置由 **`backend/config/database.js`** 从环境变量读取：`DB_HOST`、`DB_PORT`（默认 3306）、`DB_USER`、`DB_PASSWORD`、`DB_NAME`；连接池在 **`backend/db/mysqlPool.js`** 创建。
- **本地联调请连接远程 MySQL**：复制 `.env.example` 为 `.env`，填写服务器公网 IP 或内网可达地址，以及线上库账号（须与线上一致）；**勿将含真实密码的 `.env` 提交 git**（已加入 `.gitignore`）。
- 云厂商安全组 / 防火墙需放行：**你的本机出口 IP → 服务器 `DB_HOST:3306`**，否则会出现连接超时或 `ECONNREFUSED`（若误连本机 3306 也会表现为连不上远程）。

## 启动

```bash
cd backend
npm install
cp .env.example .env   # 首次：再编辑 .env 填入远程 DB_* 与 JWT_SECRET
npm run dev
```

前端本地开发时，在 `../frontend` 执行 `npm run dev`，Vite 会将 `/api`、`/ext` 代理到本机 **`http://127.0.0.1:3001`**（须先启动本 backend）。
