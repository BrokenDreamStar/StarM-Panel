/**
 * 壁纸接口。
 *
 * `GET /api/wallpaper/bing` 直接返回当天的 Bing 每日壁纸字节流，
 * 前端以 CSS `background-image: url("/api/wallpaper/bing")` 引用。
 */
import { Hono } from 'hono'
import { getBingWallpaper } from '../services/bing-wallpaper'

export const wallpaperRoutes = new Hono()
  .get('/bing', async (c) => {
    const wallpaper = await getBingWallpaper(c.req.query('mkt'))

    // 复制一份，保证底层为 ArrayBuffer（BodyInit 的类型要求）
    return new Response(new Uint8Array(wallpaper.bytes), {
      headers: {
        'content-type': wallpaper.mime,
        // 上游每天更新一次，1 小时客户端缓存足够，兼顾时效与流量
        'cache-control': 'public, max-age=3600',
        'x-wallpaper-date': wallpaper.date,
        'x-content-type-options': 'nosniff',
      },
    })
  })

  .get('/bing/info', async (c) => {
    const wallpaper = await getBingWallpaper(c.req.query('mkt'))
    return c.json({
      date: wallpaper.date,
      copyright: wallpaper.copyright,
      source: wallpaper.source,
      url: '/api/wallpaper/bing',
    })
  })
