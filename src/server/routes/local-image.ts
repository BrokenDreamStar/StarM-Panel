/**
 * 本地图片直链：`GET /api/local-image?path=<绝对路径>`。
 *
 * 壁纸可以直接指向本机的一张图（`/Users/me/Pictures/x.jpg`），不必先上传到 bg/。
 * 服务端读盘返回，文件原地不动：换图就是换那个文件（或换个路径），面板不复制一份。
 *
 * 安全边界：
 *   - 只服务**图片**：读文件头按字节嗅探，非图片一律 415 —— 所以 `/etc/passwd`
 *     这类文件读不出来，「借这个接口读任意文件」不成立。
 *   - 路径由管理员在设置里给出（受信输入），但仍只接受**绝对路径**（含 `~/`、
 *     `file://`），不接受相对路径（免得受启动目录影响）。
 *   - 走 `/api/*`，与其他接口一样在登录门禁之后。
 *
 * 缓存：文件名不是内容哈希，文件随时可能被覆盖，因此 `no-cache` + ETag（大小 +
 * mtime + 内容头部哈希）协商，命中回 304；不用 `immutable`。
 */
import { Hono } from 'hono'
import { statSync } from 'node:fs'
import { HttpError } from '../middleware/error'
import { ALLOWED_MIME, sniffImageMime } from '../services/assets'
import { HEAD_BYTES, imageEtag, imageHeaders } from '../services/image-file'
import { localImagePath } from '../services/local-image'

export const localImageRoutes = new Hono().get('/', async (c) => {
  const path = localImagePath(c.req.query('path'))
  if (!path) {
    throw new HttpError(400, 'BAD_PATH', '需要一个绝对路径、~/ 开头路径或 file:// URL')
  }

  let size: number
  let mtimeMs: number
  try {
    const stat = statSync(path)
    if (!stat.isFile()) throw new HttpError(404, 'NOT_FOUND', `不是文件：${path}`)
    size = stat.size
    mtimeMs = stat.mtimeMs
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(404, 'NOT_FOUND', `图片不存在或读不到：${path}`)
  }
  if (size === 0) throw new HttpError(404, 'NOT_FOUND', `文件是空的：${path}`)

  const file = Bun.file(path)

  // 只读文件头：既用来嗅探（挡住非图片），又给 ETag 用，还不用把整个文件读进内存
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer())
  const mime = sniffImageMime(head)
  if (mime === null || !ALLOWED_MIME.has(mime)) {
    throw new HttpError(415, 'BAD_MIME', `该文件不是受支持的图片格式：${path}`)
  }

  const etag = imageEtag(head, size, mtimeMs)
  if (c.req.header('if-none-match') === etag) return c.body(null, 304)

  // 流式返回：几 MB 的图不必整个读进内存
  return new Response(file, { headers: imageHeaders(mime, etag) })
})
