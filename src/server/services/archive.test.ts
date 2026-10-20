/**
 * 发布归档的解包单测。
 *
 * 更新器只认「发布脚本产出的那一种归档」：单个文件、无加密、store 或 deflate。
 * 这里按字节手工造 zip，把解析器的每条拒绝分支都钉住 —— 解包错一步就是装错文件，
 * 比普通的工具函数危险得多。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { extractArchive } from './archive'

/** 造一个单文件 zip；method 0 = store、8 = deflate（CRC 我们不校验，写 0） */
function buildZip(name: string, bytes: Uint8Array, method: 0 | 8): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const payload = method === 8 ? new Uint8Array(deflateRawSync(bytes)) : bytes
  const local = new Uint8Array(30 + nameBytes.byteLength + payload.byteLength)
  const localView = new DataView(local.buffer)
  localView.setUint32(0, 0x04034b50, true)
  localView.setUint16(4, 20, true) // version needed
  localView.setUint16(8, method, true)
  localView.setUint32(14, 0, true) // crc32（解析器不校验）
  localView.setUint32(18, payload.byteLength, true)
  localView.setUint32(22, bytes.byteLength, true)
  localView.setUint16(26, nameBytes.byteLength, true)
  local.set(nameBytes, 30)
  local.set(payload, 30 + nameBytes.byteLength)

  const centralOffset = local.byteLength
  const central = new Uint8Array(46 + nameBytes.byteLength)
  const centralView = new DataView(central.buffer)
  centralView.setUint32(0, 0x02014b50, true)
  centralView.setUint16(4, 0x031e, true) // made by unix
  centralView.setUint16(6, 20, true)
  centralView.setUint16(10, method, true)
  centralView.setUint32(16, 0, true) // crc32
  centralView.setUint32(20, payload.byteLength, true)
  centralView.setUint32(24, bytes.byteLength, true)
  centralView.setUint16(28, nameBytes.byteLength, true)
  centralView.setUint32(38, 0o755 << 16, true) // external attributes：权限位
  centralView.setUint32(42, 0, true) // 本地头偏移
  central.set(nameBytes, 46)

  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, 1, true) // 本盘条目数
  eocdView.setUint16(10, 1, true) // 总条目数
  eocdView.setUint32(12, central.byteLength, true)
  eocdView.setUint32(16, centralOffset, true)

  const zip = new Uint8Array(local.byteLength + central.byteLength + eocd.byteLength)
  zip.set(local, 0)
  zip.set(central, local.byteLength)
  zip.set(eocd, local.byteLength + central.byteLength)
  return zip
}

describe('extractArchive — zip', () => {
  const payload = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8])

  test('store 与 deflate 两种压缩方式都能解', async () => {
    for (const method of [0, 8] as const) {
      const zip = buildZip('starm-panel-v0.1.5-windows-x64.exe', payload, method)
      const file = await extractArchive(zip, 'zip')
      expect(file.name).toBe('starm-panel-v0.1.5-windows-x64.exe')
      expect([...file.bytes]).toEqual([...payload])
    }
  })

  test('拒绝多文件归档、非 zip 数据与空数据', async () => {
    const twoEntries = new Uint8Array(buildZip('a.exe', payload, 0))
    // 把 EOCD 的条目数改成 2，模拟多文件归档
    new DataView(twoEntries.buffer).setUint16(twoEntries.byteLength - 12, 2, true)
    await expect(extractArchive(twoEntries, 'zip')).rejects.toThrow(/只有一个文件/)

    await expect(extractArchive(new TextEncoder().encode('<html>404</html>'), 'zip')).rejects.toThrow(
      /不是有效的 zip/,
    )
    await expect(extractArchive(new Uint8Array(), 'zip')).rejects.toThrow(/归档为空/)
  })

  test('数据被截断时抛错，不会返回半个文件', async () => {
    const zip = buildZip('a.exe', payload, 8)
    await expect(extractArchive(zip.subarray(0, zip.byteLength - 20), 'zip')).rejects.toThrow()
  })
})

describe('extractArchive — tar.gz', () => {
  test('解开含单个文件的 tar.gz', async () => {
    const payload = new TextEncoder().encode('\x7fELF starm-panel binary')
    const dir = mkdtempSync(join(tmpdir(), 'starm-panel-archive-'))
    const archivePath = join(dir, 'test.tar.gz')
    await Bun.Archive.write(archivePath, { 'starm-panel-v0.1.5-linux-x64': payload })
    try {
      const bytes = new Uint8Array(await Bun.file(archivePath).arrayBuffer())
      const file = await extractArchive(bytes, 'tar.gz')
      expect(file.name).toBe('starm-panel-v0.1.5-linux-x64')
      expect(new TextDecoder().decode(file.bytes)).toBe('\x7fELF starm-panel binary')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('不是 tar.gz 的数据直接抛错', async () => {
    await expect(extractArchive(new TextEncoder().encode('not an archive'), 'tar.gz')).rejects.toThrow()
  })
})
