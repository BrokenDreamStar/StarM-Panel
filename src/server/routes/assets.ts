/**
 * 图标 / 壁纸 / favicon 资源接口。
 */
import { Hono } from 'hono'
import { desc, eq, like } from 'drizzle-orm'
import { db } from '../db'
import { assets, items } from '../db/schema'
import { HttpError } from '../middleware/error'
import { parseKind, readAssetBytes, deleteAsset, storeAsset, toAsset } from '../services/assets'
import { getSetting } from '../services/settings'

export const assetRoutes = new Hono()
  .get('/', (c) => {
    const kind = c.req.query('kind')
    const base = db
      .select({
        id: assets.id,
        kind: assets.kind,
        name: assets.name,
        mime: assets.mime,
        size: assets.size,
        fileName: assets.fileName,
        createdAt: assets.createdAt,
      })
      .from(assets)

    const rows = (kind ? base.where(eq(assets.kind, kind)) : base)
      .orderBy(desc(assets.createdAt))
      .all()

    return c.json(rows.map(toAsset))
  })

  .post('/', async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!(file instanceof File)) {
      throw new HttpError(400, 'NO_FILE', '缺少 file 字段（multipart/form-data）')
    }
    const kind = parseKind(body['kind'] ?? 'icon')

    const bytes = new Uint8Array(await file.arrayBuffer())
    // 注意：file.type 不可信 —— Bun 的 fetch 会按文件名后缀推断 part 的
    // Content-Type，客户端可随意伪造。真实类型由 storeAsset 内部嗅探字节得出。
    const asset = storeAsset(bytes, kind, file.name || 'unnamed', file.type)

    return c.json({ ...asset, url: `/api/assets/${asset.id}` }, 201)
  })

  .get('/:id', (c) => {
    const id = c.req.param('id')
    const row = db
      .select({ mime: assets.mime, bytes: assets.bytes, fileName: assets.fileName })
      .from(assets)
      .where(eq(assets.id, id))
      .get()

    if (!row) throw new HttpError(404, 'NOT_FOUND', `资源 ${id} 不存在`)

    // 图标 / favicon 在 BLOB 里，壁纸在 bg/ 文件里 —— 差异收敛在这一处
    const bytes = readAssetBytes(row)

    const headers: Record<string, string> = {
      'content-type': row.mime,
      // id 即内容哈希，内容永不变化
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    }

    // SVG 可以内嵌 <script>。以 <img> 引用时不会执行，但用户直接打开
    // /api/assets/<id> 时就是同源文档，脚本会执行 → 存储型 XSS。
    // 用一个只允许内联样式的 CSP 掐断它的脚本与外链能力。
    if (row.mime === 'image/svg+xml') {
      headers['content-security-policy'] =
        "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    }

    return new Response(bytes, { headers })
  })

  .delete('/:id', (c) => {
    const id = c.req.param('id')

    const row = db
      .select({ id: assets.id, fileName: assets.fileName })
      .from(assets)
      .where(eq(assets.id, id))
      .get()
    if (!row) throw new HttpError(404, 'NOT_FOUND', `资源 ${id} 不存在`)

    // 先检查引用，避免删除后卡片图标变成裂图
    const refs = db
      .select({ id: items.id, title: items.title })
      .from(items)
      .where(like(items.iconValue, `%/api/assets/${id}%`))
      .all()

    if (refs.length > 0) {
      throw new HttpError(409, 'IN_USE', `该资源正被 ${refs.length} 张卡片引用`, {
        items: refs,
      })
    }

    // 首页壁纸也可能正引用它 —— 壁纸是文件直链（/bg/<文件名>），删了就是背景
    // 直接变白，和卡片图标引用一样得拦下来。（非 asset 类型时那个值不再生效，
    // 不拦）
    const wallpaperValue = getSetting('wallpaper.value')
    const wallpaperUsingThis =
      getSetting('wallpaper.type') === 'asset' &&
      typeof wallpaperValue === 'string' &&
      (wallpaperValue === `/api/assets/${id}` ||
        (row.fileName !== null && wallpaperValue === `/bg/${row.fileName}`))

    if (wallpaperUsingThis) {
      throw new HttpError(409, 'IN_USE', '该资源正被首页壁纸使用', {
        wallpaper: wallpaperValue,
      })
    }

    // 壁纸会连带删掉 bg/ 下的文件
    deleteAsset(id)
    return c.body(null, 204)
  })
