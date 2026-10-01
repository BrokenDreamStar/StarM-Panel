/**
 * 资源存储服务。
 *
 * 二进制直接存 SQLite BLOB（见 docs/DESIGN.md §2.2 ADR-005）：
 * 整个应用状态收敛为 data/app.db + data/secret.key 两个文件，
 * 备份即复制，不存在「数据库与文件系统不同步」问题。
 *
 * id 为内容哈希，因此相同内容重复上传自动去重。
 */
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { assets } from '../db/schema'
import { HttpError } from '../middleware/error'
import type { Asset, AssetKind } from '@shared/types'

/** 单文件体积上限 */
export const SIZE_LIMITS: Record<AssetKind, number> = {
  icon: 512 * 1024,
  favicon: 512 * 1024,
  wallpaper: 5 * 1024 * 1024,
}

/** 允许的图片类型 —— 与 sniffImageMime 的返回值域保持一致 */
export const ALLOWED_MIME: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/bmp',
  'image/tiff',
  'image/svg+xml',
  'image/x-icon',
])

/**
 * 按文件头（magic bytes）嗅探真实图片类型。
 *
 * ⚠️ 为什么不能信任客户端声明的 MIME：
 *   实测 Bun 的 fetch + FormData 会**忽略 File 对象上的 type，改从文件名后缀
 *   推断** part 的 Content-Type（`test.txt` 即使声明 type=image/png，服务端
 *   收到的仍是 text/plain）。这意味着 file.type 完全由客户端摆布 ——
 *   把任意文件命名为 .png 就能让它"变成" image/png。
 *   因此这里以字节内容为准，客户端声明只作参考。
 *
 * 返回 null 表示无法识别为受支持的图片格式。
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const b = bytes
  const startsWith = (...sig: number[]) =>
    b.length >= sig.length && sig.every((v, i) => b[i] === v)

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  // JPEG: FF D8 FF
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
  // GIF87a / GIF89a
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  // BMP: 42 4D
  if (startsWith(0x42, 0x4d)) return 'image/bmp'
  // ICO / CUR: 00 00 01 00 或 00 00 02 00
  if (startsWith(0x00, 0x00, 0x01, 0x00) || startsWith(0x00, 0x00, 0x02, 0x00)) {
    return 'image/x-icon'
  }
  // TIFF: 49 49 2A 00 / 4D 4D 00 2A
  if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)) {
    return 'image/tiff'
  }
  // RIFF....WEBP
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    b.length >= 12 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'image/webp'
  }
  // ISO-BMFF: ....ftyp{avif|avis|heic|heif|mif1}
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'heif' || brand === 'mif1') {
      return 'image/heic'
    }
  }

  // SVG 是文本格式，需要单独判断：跳过 BOM 与空白后查找 <svg
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(b.subarray(0, Math.min(b.length, 4096)))
    .replace(/^\uFEFF/, '')
    .trimStart()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml'
  }

  return null
}

export function contentId(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(bytes)
  return hasher.digest('hex').slice(0, 16)
}

export function toAsset(row: {
  id: string
  kind: string
  name: string
  mime: string
  size: number
  createdAt: number
}): Asset {
  return {
    id: row.id,
    kind: row.kind as AssetKind,
    name: row.name,
    mime: row.mime,
    size: row.size,
    createdAt: row.createdAt,
  }
}

export function parseKind(raw: unknown): AssetKind {
  if (raw === 'icon' || raw === 'wallpaper' || raw === 'favicon') return raw
  throw new HttpError(400, 'BAD_KIND', 'kind 必须是 icon / wallpaper / favicon')
}

/**
 * 存入 BLOB 并返回元数据；内容已存在时直接复用（去重）。
 *
 * MIME **由字节内容嗅探得出**，不接受客户端声明（见 sniffImageMime 的说明）。
 * 副作用：同一份字节以不同 kind 上传时会复用同一条记录，kind 保持首次上传的值
 * —— 这是内容寻址存储的预期行为，避免重复占用空间。
 *
 * @param declaredMime 客户端声明的类型，仅用于错误提示，不参与判定
 */
export function storeAsset(
  bytes: Uint8Array,
  kind: AssetKind,
  name: string,
  declaredMime?: string,
): Asset {
  const limit = SIZE_LIMITS[kind]
  if (bytes.byteLength === 0) {
    throw new HttpError(400, 'EMPTY_FILE', '文件内容为空')
  }
  if (bytes.byteLength > limit) {
    throw new HttpError(
      413,
      'TOO_LARGE',
      `文件超过 ${Math.round(limit / 1024)}KB 上限`,
      { size: bytes.byteLength, limit },
    )
  }

  const mime = sniffImageMime(bytes)
  if (mime === null || !ALLOWED_MIME.has(mime)) {
    throw new HttpError(
      415,
      'BAD_MIME',
      '文件内容不是受支持的图片格式' +
        (declaredMime ? `（客户端声明为 ${declaredMime}）` : ''),
    )
  }

  const id = contentId(bytes)
  const existing = db.select().from(assets).where(eq(assets.id, id)).get()
  if (existing) return toAsset(existing)

  const row = db
    .insert(assets)
    .values({
      id,
      kind,
      name,
      mime,
      size: bytes.byteLength,
      bytes: Buffer.from(bytes),
      createdAt: Date.now(),
    })
    .returning({
      id: assets.id,
      kind: assets.kind,
      name: assets.name,
      mime: assets.mime,
      size: assets.size,
      createdAt: assets.createdAt,
    })
    .get()

  return toAsset(row)
}
