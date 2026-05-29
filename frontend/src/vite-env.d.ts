/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 生产构建：API 根地址（无尾斜杠）。开发环境由 Vite 代理 /api，客户端忽略此值。 */
  readonly VITE_API_BASE_URL?: string
  /** 仅 Vite 开发代理读取（见 vite.config）；勿指向 localhost */
  readonly VITE_API_PROXY_TARGET?: string
  /** 为 true 时显示 TikTok 授权调试/Partner 锁定提示 */
  readonly VITE_SHOW_AUTH_DEBUG_HINT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
