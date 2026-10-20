/**
 * 发布归档的解包 —— 更新器与归档生成脚本（scripts/gen-update-manifest.ts）共用。
 *
 * Release 只发布归档：Windows 是 `.zip`，macOS / Linux 是 `.tar.gz`（见
 * docs/DESIGN.md ADR-008）。两种格式各走一条路径：
 *
 *   - `.tar.gz`：直接用 Bun 内置的 `Bun.Archive`，零解析代码；
 *   - `.zip`：Bun 1.4 的 `Bun.Archive` 还不认 zip（会报 Unrecognized archive format），
 *     这里自己解析「单文件 + store/deflate」的 zip。范围刻意收得很窄 ——
 *     我们不支持多文件、ZIP64、加密、data descriptor，遇到就报错，
 *     因为生产归档只由本仓库的发布脚本产出。
 *
 * 只返回「一个文件名 + 内容」，把路径安全校验留给调用方（它必须核对文件名）。
 */
import { inflateRawSync } from 'node:zlib'
import type { UpdateArchiveKind } from '@shared/update'

/** 解包结果：归档里那唯一一个文件的文件名与内容 */
export interface ArchivedFile {
  name: string
  bytes: Uint8Array
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 解开一个归档，返回其中唯一的文件。
 *
 * 归档里必须恰好有一个文件（发布脚本产出就是这样），否则抛错 ——
 * 让「装错东西」在解包这一步就停下来。
 */
export async function extractArchive(bytes: Uint8Array, kind: UpdateArchiveKind): Promise<ArchivedFile> {
  if (bytes.byteLength === 0) throw new Error('归档为空')
  const file = kind === 'tar.gz' ? await extractTarGz(bytes) : extractZip(bytes)
  if (file.bytes.byteLength === 0) throw new Error('归档里的文件是空的')
  return file
}

/** `.tar.gz`：交给 Bun.Archive（只接受含单个文件的归档） */
async function extractTarGz(bytes: Uint8Array): Promise<ArchivedFile> {
  let files: Map<string, File>
  try {
    files = await new Bun.Archive(bytes).files()
  } catch (err) {
    throw new Error(`解压失败（tar.gz）：${message(err)}`)
  }
  // 目录条目也占一项，过滤掉再判断
  const entries = [...files].filter(([name]) => name !== '' && !name.endsWith('/'))
  if (entries.length !== 1) throw new Error(`归档里应当只有一个文件，实际 ${entries.length} 个`)
  const [name, file] = entries[0]!
  return { name, bytes: new Uint8Array(await file.arrayBuffer()) }
}

/** zip 的签名 */
const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
/** ZIP64 用 0xffffffff 占位，本项目不会产出这么大的归档，直接拒绝 */
const ZIP64_MARKER = 0xffffffff

/**
 * `.zip`：解析单文件归档。
 *
 * 读取顺序：EOCD（尾部）→ 中央目录（记录大小与压缩方式）→ 本地头（定位数据起点）。
 * 只用中央目录里的 size 与本地头的偏移，避免依赖 data descriptor。
 */
function extractZip(bytes: Uint8Array): ArchivedFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(view)

  const entryCount = view.getUint16(eocd + 10, true)
  if (entryCount !== 1) throw new Error(`zip 里应当只有一个文件，实际 ${entryCount} 个`)

  const centralOffset = view.getUint32(eocd + 16, true)
  if (centralOffset + 46 > bytes.byteLength || view.getUint32(centralOffset, true) !== SIG_CENTRAL) {
    throw new Error('zip 中央目录损坏')
  }

  const method = view.getUint16(centralOffset + 10, true)
  const compressedSize = view.getUint32(centralOffset + 20, true)
  const uncompressedSize = view.getUint32(centralOffset + 24, true)
  const nameLength = view.getUint16(centralOffset + 28, true)
  const localOffset = view.getUint32(centralOffset + 42, true)
  if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
    throw new Error('不支持 ZIP64 归档')
  }
  if (centralOffset + 46 + nameLength > bytes.byteLength) throw new Error('zip 中央目录被截断')
  const name = new TextDecoder().decode(bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength))

  // 本地头里的文件名长度/扩展区长度可能和中央目录不同，必须以本地头为准算数据起点
  if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== SIG_LOCAL) {
    throw new Error('zip 本地头损坏')
  }
  const localNameLength = view.getUint16(localOffset + 26, true)
  const localExtraLength = view.getUint16(localOffset + 28, true)
  const dataStart = localOffset + 30 + localNameLength + localExtraLength
  if (dataStart + compressedSize > bytes.byteLength) throw new Error('zip 数据被截断')

  const payload = bytes.subarray(dataStart, dataStart + compressedSize)
  let out: Uint8Array
  if (method === 0) {
    out = payload.slice()
  } else if (method === 8) {
    try {
      out = new Uint8Array(inflateRawSync(payload))
    } catch (err) {
      throw new Error(`解压失败（zip）：${message(err)}`)
    }
  } else {
    throw new Error(`不支持的 zip 压缩方式（${method}）`)
  }

  if (out.byteLength !== uncompressedSize) {
    throw new Error(`zip 解压后长度与目录记录不一致（${out.byteLength} ≠ ${uncompressedSize}）`)
  }
  return { name, bytes: out }
}

/**
 * 从文件尾部往前找 EOCD。
 *
 * zip 结尾的注释最长 0xffff 字节，所以最多回退 22 + 0xffff。
 */
function findEndOfCentralDirectory(view: DataView): number {
  const minEocdSize = 22
  if (view.byteLength < minEocdSize) throw new Error('不是有效的 zip 归档（文件太小）')
  const lowest = Math.max(0, view.byteLength - minEocdSize - 0xffff)
  for (let i = view.byteLength - minEocdSize; i >= lowest; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i
  }
  throw new Error('不是有效的 zip 归档（找不到中央目录结束标记）')
}
