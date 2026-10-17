/**
 * 壁纸文件存储（`<data-dir>/bg/`）。
 *
 * 设计要点（见 docs/DESIGN.md ADR-005 修订）：
 *   - 用户上传的**壁纸**不再进 SQLite BLOB，而是以**原始文件名**落盘到
 *     `<data-dir>/bg/`，数据库只留元数据（assets.file_name 指向文件名）。
 *     壁纸动辄几 MB，是数据库体积的主要来源，而它本来就是「一张图片文件」，
 *     放进 bg/ 之后可以随手用系统看图器打开、用 rsync 同步、换图不用碰库。
 *   - **图标 / favicon 仍然存 BLOB**：体积小、数量多，落盘会让数据目录
 *     变成几百个小文件，得不偿失。
 *   - 文件名重名且**内容不同**时追加 `-1` / `-2` 后缀；内容相同则直接复用
 *     已有文件（与 assets.id 的内容寻址语义一致，不重复占空间）。
 *   - 所有落盘路径都过 `sanitizeBgName()`：只取 basename、剔除路径分隔符与
 *     控制字符；读取时 `bgFilePath()` 再校验解析结果确实落在 bg/ 内，
 *     双保险防目录穿越（数据库里的 file_name 也可能是被手工改过的）。
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { getConfig } from '../env'
import { HttpError } from '../middleware/error'

/** MIME → 扩展名：仅当原始文件名没有扩展名时用来兜底 */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
}

/** 文件名主干上限（UTF-8 字节）：给 `-999` 后缀与扩展名留出空间，多数文件系统限 255 字节 */
const MAX_STEM_BYTES = 180
/** 扩展名长度上限（不含点）；超长的多半不是扩展名，按无扩展名处理 */
const MAX_EXT_CHARS = 12
/** Windows 保留设备名：用这些名字建文件会失败，加下划线前缀躲开 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 按 UTF-8 字节数截断（不能用 String.slice —— 中文一字 3 字节） */
function clampBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder()
  if (enc.encode(s).byteLength <= maxBytes) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const n = enc.encode(ch).byteLength
    if (used + n > maxBytes) break
    out += ch
    used += n
  }
  return out
}

function extFor(mime: string): string {
  return MIME_EXT[mime] ?? 'img'
}

/** 数据目录下的壁纸目录（`<data-dir>/bg`）—— 惰性取值，import 本模块不产生副作用 */
export function bgDir(): string {
  return join(getConfig().dataDir, 'bg')
}

/**
 * 建好壁纸目录（幂等）。
 *
 * 启动时显式调一次：目录布局 `<data-dir>/{db,bg}` 立刻可见，数据目录不可写
 * 也在启动阶段就报错，而不是等用户第一次上传壁纸才失败。
 */
export function ensureBgDir(dir: string = bgDir()): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 清洗上传时的原始文件名为「安全的单段文件名」。
 *
 * 保留原始名字（含中文、空格、大小写），只做必要处理：取 basename、去控制
 * 字符与文件系统保留字符、去前导点、按字节截断、补扩展名。
 *
 * 另外剔除 `#` 与 `%`：文件名要能直接拼进 `/bg/<名>` 这个 URL 路径里，
 * 留着它们会被解释成 fragment / 转义序列。
 */
export function sanitizeBgName(raw: string, mime: string): string {
  // 反斜杠先换成斜杠：Windows 客户端可能传来 `C:\Users\x\bg.png` 这种路径
  let name = basename(String(raw ?? '').replaceAll('\\', '/'))
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*#%]/g, '')
  // 去前导点：顺带挡掉 "." / ".." / 隐藏文件
  name = name.replace(/^\.+/, '')
  // 去尾部点号与空格：Windows 会静默吃掉它们，留着会让「库里记的名字」和
  // 「磁盘上实际的名字」对不上
  name = name.replace(/[. ]+$/, '')
  name = name.trim()
  if (!name) name = `wallpaper.${extFor(mime)}`

  let ext = extname(name)
  if (ext.length - 1 > MAX_EXT_CHARS) ext = ''
  let stem = ext ? name.slice(0, -ext.length) : name
  if (!ext) ext = `.${extFor(mime)}`

  stem = clampBytes(stem, MAX_STEM_BYTES).trim() || 'wallpaper'
  if (RESERVED.test(stem)) stem = `_${stem}`
  return `${stem}${ext}`
}

/** 文件内容是否与给定字节完全一致（不存在 / 读不了都算不一致） */
function sameContent(path: string, bytes: Uint8Array): boolean {
  try {
    const current = readFileSync(path)
    if (current.length !== bytes.byteLength) return false
    for (let i = 0; i < current.length; i++) {
      if (current[i] !== bytes[i]) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * 把壁纸字节落盘，返回实际使用的文件名。
 *
 * 优先用原始文件名；重名且内容不同则依次尝试 `<stem>-1.<ext>`、`-2`…
 * 内容相同（含后缀候选）直接复用，不重复写盘。
 */
export function writeBgFile(
  bytes: Uint8Array,
  rawName: string,
  mime: string,
  dir: string = bgDir(),
): string {
  ensureBgDir(dir)

  const name = sanitizeBgName(rawName, mime)
  const target = join(dir, name)
  if (!existsSync(target)) {
    writeFileSync(target, bytes)
    return name
  }
  if (sameContent(target, bytes)) return name

  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; i <= 999; i++) {
    const candidate = `${stem}-${i}${ext}`
    const path = join(dir, candidate)
    if (!existsSync(path)) {
      writeFileSync(path, bytes)
      return candidate
    }
    if (sameContent(path, bytes)) return candidate
  }
  throw new HttpError(500, 'BG_NAME_EXHAUSTED', `同名壁纸过多，无法落盘：${name}`)
}

/**
 * 文件名 → 绝对路径；名字含路径分隔符或解析后越出 bg/ 时返回 null。
 *
 * 落盘时已清洗过，这里是针对「数据库被手工改过」的二次校验。
 */
export function bgFilePath(fileName: string, dir: string = bgDir()): string | null {
  if (!fileName) return null
  if (fileName.includes('/') || fileName.includes('\\')) return null
  if (fileName === '.' || fileName === '..') return null
  const base = resolve(dir)
  const path = resolve(base, fileName)
  if (path !== base && !path.startsWith(base + sep)) return null
  return path
}

/** 扩展名 → MIME：服务 `/bg/<名>` 时用（手工丢进 bg/ 的文件没有库记录） */
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  cur: 'image/x-icon',
}

/**
 * 按扩展名判定 MIME；不是受支持的图片类型时返回 null。
 *
 * `/bg/<名>` 只服务图片：bg/ 是用户能直接写文件的目录，不能让丢进去的
 * `.html` 之类被当作同源文档执行。
 */
export function mimeForBgFile(name: string): string | null {
  return EXT_MIME[extname(name).slice(1).toLowerCase()] ?? null
}

/** 壁纸文件的绝对路径与统计信息；不存在 / 名字越界时返回 null */
export function bgFileStat(
  fileName: string,
  dir: string = bgDir(),
): { path: string; size: number; mtimeMs: number } | null {
  const path = bgFilePath(fileName, dir)
  if (!path) return null
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    return { path, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

/** 壁纸文件是否存在（比 readBgFile 便宜：不读内容） */
export function bgFileExists(fileName: string, dir: string = bgDir()): boolean {
  const path = bgFilePath(fileName, dir)
  return Boolean(path && existsSync(path))
}

/** 读取壁纸文件；文件不存在或被拒时返回 null */
export function readBgFile(
  fileName: string,
  dir: string = bgDir(),
): Uint8Array<ArrayBuffer> | null {
  const path = bgFilePath(fileName, dir)
  if (!path || !existsSync(path)) return null
  try {
    return new Uint8Array(readFileSync(path))
  } catch {
    return null
  }
}

/** 删除壁纸文件；返回是否真的删掉了（文件已不在也算成功路径，返回 false） */
export function deleteBgFile(fileName: string, dir: string = bgDir()): boolean {
  const path = bgFilePath(fileName, dir)
  if (!path || !existsSync(path)) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    // 删不掉（权限 / 占用）只留下一个孤儿文件，不该让删除接口失败
    return false
  }
}
