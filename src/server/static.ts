/**
 * 静态资源服务 —— 从编译进二进制的资源清单中响应请求。
 *
 * ⚠️ 已知 Bun 限制（见 docs/DESIGN.md §13 R2）：
 *    不要使用 `Bun.serve({ routes: { '/x/*': { dir: <嵌入路径> } } })`，
 *    该写法在指向嵌入路径时会在启动阶段 abort。
 *    必须使用 `Bun.file(<嵌入路径>)` 手工构造 Response。
 */
import type { Hono } from 'hono'
import { assets } from './generated/assets'

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
  sql: 'application/sql; charset=utf-8',
}

/** 带内容哈希的构建产物永不变化，可永久缓存 */
const IMMUTABLE = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i

function extOf(pathname: string): string {
  const i = pathname.lastIndexOf('.')
  return i < 0 ? '' : pathname.slice(i + 1).toLowerCase()
}

function headersFor(pathname: string): Record<string, string> {
  return {
    'content-type': MIME[extOf(pathname)] ?? 'application/octet-stream',
    'cache-control': IMMUTABLE.test(pathname)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'x-content-type-options': 'nosniff',
  }
}

export function registerStatic(app: Hono): void {
  // 必须最后注册：Hono 按注册顺序执行处理器，
  // 更具体的路由已经返回 Response 时不会走到这里。
  app.get('*', (c) => {
    const pathname = c.req.path

    // API 路径不应落到 SPA fallback 上，返回结构化 404 便于前端排查
    if (pathname.startsWith('/api/') || pathname === '/healthz') {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `没有匹配的路由：${pathname}` } },
        404,
      )
    }

    const wanted = pathname === '/' ? '/index.html' : pathname
    const embedded = assets.get(wanted)

    if (embedded) {
      return new Response(Bun.file(embedded), { headers: headersFor(wanted) })
    }

    // SPA fallback —— 交给前端路由处理（/settings 之类刷新时直达）
    const index = assets.get('/index.html')
    if (!index) {
      return c.text(
        '构建产物缺失：index.html 未被嵌入二进制。请先执行 bun run build:web && bun run build:assets。',
        500,
      )
    }
    return new Response(Bun.file(index), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      },
    })
  })
}
