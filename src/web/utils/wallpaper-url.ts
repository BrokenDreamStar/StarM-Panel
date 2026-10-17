/**
 * 壁纸值 → `url()` 里能用的地址。
 *
 * 设置里的「图片地址」允许三种写法，规则在这里统一：
 *   1. 面板自己的地址（`/api/…`、`/bg/…`、`/assets/…`）、完整 URL（`http(s)://`、
 *      `//cdn/…`）、`data:`  → 原样交给浏览器；
 *   2. 本机绝对路径（`/Users/me/Pictures/x.jpg`、`~/Pictures/x.jpg`、`file:///…`）
 *      → 走 `/api/local-image?path=…`，由服务端读盘返回；
 *   3. 空值 → 空串（调用方据此不设背景）。
 *
 * 之所以要转换：`url("/Users/…")` 会被浏览器当成**面板域名下的路径**去请求
 * （`http://面板/Users/…`），服务端没有这个路由，只会拿到 SPA fallback 的 HTML。
 */

/** 面板自己提供的绝对路径前缀 —— 这些不能当成本机文件路径 */
const PANEL_PREFIXES = ['/api/', '/bg/', '/assets/']

/**
 * 这类壁纸要不要走需要登录的接口。
 *
 * `asset`（`/bg/*`、`/api/local-image`）与 `bing`（`/api/wallpaper/bing`）都挂在
 * 鉴权门禁后面：登录页还没会话时请求必然 401，而同一个 URL 失败后浏览器不会重试，
 * 登录后就算算出来的地址一样，图片也不会自己回来。所以登录前只渲染
 * `solid` / `gradient` 这两种纯 CSS 壁纸（见 App.vue 的 wallpaperStyle）。
 */
export function isGatedWallpaper(type: string): boolean {
  return type === 'asset' || type === 'bing'
}

/** 本机图片的服务端地址 */
export function localImageUrl(path: string): string {
  return `/api/local-image?path=${encodeURIComponent(path)}`
}

export function toWallpaperCssUrl(value: string): string {
  const v = value.trim()
  if (v === '') return ''
  // 协议相对地址 //cdn/x.jpg 也是 URL，别误判成绝对路径
  if (v.startsWith('//')) return v
  if (v.startsWith('file://') || v.startsWith('~/')) return localImageUrl(v)
  if (v.startsWith('/') && !PANEL_PREFIXES.some((p) => v.startsWith(p))) {
    return localImageUrl(v)
  }
  return v
}
