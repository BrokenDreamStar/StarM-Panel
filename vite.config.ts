import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: r('./src/web'),
  plugins: [vue()],
  resolve: {
    alias: {
      '@': r('./src/web'),
      '@shared': r('./src/shared'),
    },
  },
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
    target: 'esnext',
    // 桌面面板不需要为老浏览器降级，省体积
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // 内容哈希 → 配合 immutable 缓存头（见 server/static.ts）
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3002',
        changeOrigin: true,
        // root 是 src/web，所以 src/web/api/client.ts 会以 /api/client.ts 被请求，
        // 正好落在代理前缀里、被转发到后端变成 404。只放行这种「单段 + 源码后缀」
        // 的路径给 Vite 的模块服务；/api/items、/api/assets/xxx.png 等真实接口照旧代理。
        bypass: (req) =>
          /^\/api\/[^/]+\.(?:ts|js|map)(?:\?|$)/.test(req.url ?? '') ? req.url : undefined,
      },
    },
  },
})
