/**
 * 壁纸文件直链：`GET /bg/<文件名>`。
 *
 * 壁纸就是 `<data-dir>/bg/` 下的普通图片文件，因此对外也直接以文件路径暴露：
 * 设置 →「外观」→「图片地址」里存的是 `/bg/我的壁纸.png`，看得懂、可手工替换，
 * 也能直接往 bg/ 里丢一张图再引用它。图标 / favicon 在数据库里，仍走
 * `/api/assets/<id>`（见 routes/assets.ts）。
 *
 * 注意两点：
 *   - 这条路径不在 `/api/*` 下，因此**必须单独挂 authGate**（见 server/index.ts），
 *     否则壁纸会变成匿名可读。
 *   - 缓存不能像 `/api/assets/<id>` 那样 `immutable`：文件名不是内容哈希，
 *     用户随时可能覆盖同名文件，只能靠 ETag 做协商缓存。
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { assets } from '../db/schema'
import { HttpError } from '../middleware/error'
import { bgFileStat, mimeForBgFile, readBgFile } from '../services/bg-store'
import { HEAD_BYTES, imageEtag, imageHeaders } from '../services/image-file'

export const bgRoutes = new Hono().get('/:name', (c) => {
  const raw = c.req.param('name')
  // 中文名在请求里是百分号编码的；Hono 多数情况已解码，这里兜一层底
  let name = raw
  try {
    name = decodeURIComponent(raw)
  } catch {
    /* 不是合法编码就按原样处理，交给 bgFilePath 校验 */
  }

  const stat = bgFileStat(name)
  if (!stat) throw new HttpError(404, 'NOT_FOUND', `壁纸 ${name} 不存在`)

  // MIME 优先取库里的记录（上传时按字节嗅探得出，最可靠）；手工丢进 bg/ 的
  // 文件没有记录，退化为按扩展名判定，且只认图片类型。
  const row = db
    .select({ mime: assets.mime })
    .from(assets)
    .where(eq(assets.fileName, name))
    .get()
  const mime = row?.mime ?? mimeForBgFile(name)
  if (!mime) throw new HttpError(404, 'NOT_FOUND', `壁纸 ${name} 不是受支持的图片类型`)

  const bytes = readBgFile(name)
  if (!bytes) throw new HttpError(404, 'NOT_FOUND', `壁纸 ${name} 不存在`)

  // 文件可能被换成同名的新图，所以 ETag 带上内容头部哈希（见 services/image-file）
  const etag = imageEtag(bytes.subarray(0, HEAD_BYTES), stat.size, stat.mtimeMs)
  if (c.req.header('if-none-match') === etag) return c.body(null, 304)

  return new Response(bytes, { headers: imageHeaders(mime, etag) })
})
