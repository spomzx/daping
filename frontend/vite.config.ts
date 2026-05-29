import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 本地前后端联调：/api、/ext → 本机 backend（默认 3001）
const LOCAL_API = 'http://127.0.0.1:3001'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: LOCAL_API,
        changeOrigin: true,
        secure: false,
      },
      '/ext': {
        target: LOCAL_API,
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
