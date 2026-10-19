/**
 * 程序文件替换的文件操作单测。
 *
 * 更新流程里最不可逆的一步就是「旧文件改名、新文件就位」，
 * 这里用临时目录把它单独钉住（不涉及网络与数据库）。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decompressZstdPackage, installBinary } from './update'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'starm-panel-update-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
})

describe('installBinary', () => {
  test('新文件替换目标，旧文件保留为 .old 回滚点', () => {
    const dir = tempDir()
    const target = join(dir, 'starm-panel')
    const tmp = join(dir, '.starm-panel-update-1')
    writeFileSync(target, 'old-binary')
    writeFileSync(tmp, 'new-binary')

    installBinary(tmp, target)

    expect(readFileSync(target, 'utf8')).toBe('new-binary')
    expect(readFileSync(`${target}.old`, 'utf8')).toBe('old-binary')
    // 临时文件已经改名，不应残留
    expect(existsSync(tmp)).toBe(false)
  })

  test('保留原文件的可执行权限', () => {
    if (process.platform === 'win32') return
    const dir = tempDir()
    const target = join(dir, 'starm-panel')
    const tmp = join(dir, '.starm-panel-update-2')
    writeFileSync(target, 'old')
    chmodSync(target, 0o755)
    writeFileSync(tmp, 'new')

    installBinary(tmp, target)

    expect(statSync(target).mode & 0o777).toBe(0o755)
  })

  test('目标无法改名时抛错，临时文件被清理且原目标保留', () => {
    const dir = tempDir()
    const target = join(dir, 'starm-panel')
    writeFileSync(target, 'old-binary')
    // 回滚点位置被一个非空目录占住：rename(文件 → 非空目录) 必然失败
    const backup = `${target}.old`
    mkdirSync(backup)
    writeFileSync(join(backup, 'occupied'), 'x')

    const tmp = join(dir, '.starm-panel-update-4')
    writeFileSync(tmp, 'new-binary')

    expect(() => installBinary(tmp, target)).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('old-binary')
    expect(existsSync(tmp)).toBe(false)
  })
})

describe('decompressZstdPackage', () => {
  test('解开清单里那份 zstd 压缩包', () => {
    const payload = new TextEncoder().encode('\x7fELF starm-panel binary')
    const packed = Bun.zstdCompressSync(payload)
    const raw = decompressZstdPackage(packed)
    expect(raw.byteLength).toBe(payload.byteLength)
    expect(new TextDecoder().decode(raw)).toBe('\x7fELF starm-panel binary')
  })

  test('不是 zstd 数据时抛错，不会装上半截文件', () => {
    // 代理返回的 HTML 错误页 / 空响应都不该被当成安装包
    expect(() => decompressZstdPackage(new TextEncoder().encode('<html>404</html>'))).toThrow()
    expect(() => decompressZstdPackage(new Uint8Array())).toThrow()
  })
})
