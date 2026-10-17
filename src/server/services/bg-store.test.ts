/**
 * 壁纸文件存储单测。
 *
 * 全部用例都把目录显式传进去（`dir` 参数），不碰真实的 ~/.starm-panel ——
 * 模块级 `bgDir()` 是惰性的，import 本模块不会产生任何副作用。
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bgFileExists,
  bgFilePath,
  deleteBgFile,
  mimeForBgFile,
  readBgFile,
  sanitizeBgName,
  writeBgFile,
} from './bg-store'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'starm-bg-'))
}

describe('sanitizeBgName — 保留原始名，只做必要清洗', () => {
  test('取 basename：POSIX 与 Windows 路径都不会逃出 bg/', () => {
    expect(sanitizeBgName('../../etc/passwd.png', 'image/png')).toBe('passwd.png')
    expect(sanitizeBgName('C:\\Users\\me\\壁纸.PNG', 'image/png')).toBe('壁纸.PNG')
    expect(sanitizeBgName('a/b/c/d.jpg', 'image/jpeg')).toBe('d.jpg')
  })

  test('保留中文、空格与大小写（不做 slug 化）', () => {
    expect(sanitizeBgName('我的 壁纸 Final.PNG', 'image/png')).toBe('我的 壁纸 Final.PNG')
  })

  test('剔除控制字符与文件系统保留字符', () => {
    expect(sanitizeBgName('a<b>c:d"e|f?g*h\u0000.png', 'image/png')).toBe('abcdefgh.png')
  })

  test('剔除 # 与 %：文件名要能直接拼进 /bg/<名> 这个 URL 路径', () => {
    expect(sanitizeBgName('森林#1%20.png', 'image/png')).toBe('森林120.png')
    expect(sanitizeBgName('#weird%.png', 'image/png')).toBe('weird.png')
  })

  test('空名 / 纯点号回落到 wallpaper.<ext>', () => {
    expect(sanitizeBgName('', 'image/png')).toBe('wallpaper.png')
    expect(sanitizeBgName('..', 'image/jpeg')).toBe('wallpaper.jpg')
    expect(sanitizeBgName('   ', 'image/webp')).toBe('wallpaper.webp')
  })

  test('没有扩展名时按嗅探出的 MIME 补一个', () => {
    expect(sanitizeBgName('photo', 'image/jpeg')).toBe('photo.jpg')
    expect(sanitizeBgName('未知类型', 'image/avif')).toBe('未知类型.avif')
  })

  test('前导点与尾部点号空格都被清掉（隐藏文件 / Windows 会吃掉的结尾）', () => {
    expect(sanitizeBgName('.hidden.png', 'image/png')).toBe('hidden.png')
    expect(sanitizeBgName('bg.png.', 'image/png')).toBe('bg.png')
    expect(sanitizeBgName('bg.png ', 'image/png')).toBe('bg.png')
  })

  test('Windows 保留设备名加下划线前缀', () => {
    expect(sanitizeBgName('con.png', 'image/png')).toBe('_con.png')
    expect(sanitizeBgName('LPT1.jpg', 'image/jpeg')).toBe('_LPT1.jpg')
    // 只是前缀相同，不是保留名，不动它
    expect(sanitizeBgName('console.png', 'image/png')).toBe('console.png')
  })

  test('超长名按 UTF-8 字节截断，仍保留扩展名（中文一字 3 字节）', () => {
    const name = sanitizeBgName(`${'壁'.repeat(200)}.png`, 'image/png')
    const stem = name.slice(0, name.lastIndexOf('.'))
    expect(new TextEncoder().encode(stem).byteLength).toBeLessThanOrEqual(180)
    expect(name.endsWith('.png')).toBe(true)
  })
})

describe('mimeForBgFile — /bg/<名> 只服务图片', () => {
  test('常见图片扩展名（大小写不敏感）', () => {
    expect(mimeForBgFile('a.png')).toBe('image/png')
    expect(mimeForBgFile('a.PNG')).toBe('image/png')
    expect(mimeForBgFile('a.jpeg')).toBe('image/jpeg')
    expect(mimeForBgFile('森林 车站.webp')).toBe('image/webp')
    expect(mimeForBgFile('a.svg')).toBe('image/svg+xml')
  })

  test('非图片 / 没有扩展名一律拒绝（bg/ 是用户能直接写文件的目录）', () => {
    expect(mimeForBgFile('evil.html')).toBeNull()
    expect(mimeForBgFile('evil.js')).toBeNull()
    expect(mimeForBgFile('noext')).toBeNull()
    expect(mimeForBgFile('a.png.html')).toBeNull()
  })
})

describe('bgFilePath — 二次校验，挡住被改过的 file_name', () => {
  const dir = '/tmp/starm-bg-check'

  test('普通文件名解析在 bg/ 内', () => {
    expect(bgFilePath('a.png', dir)).toBe(join(dir, 'a.png'))
  })

  test('路径分隔符 / 越界名一律拒绝', () => {
    expect(bgFilePath('../evil.png', dir)).toBeNull()
    expect(bgFilePath('sub/a.png', dir)).toBeNull()
    expect(bgFilePath('sub\\a.png', dir)).toBeNull()
    expect(bgFilePath('..', dir)).toBeNull()
    expect(bgFilePath('', dir)).toBeNull()
  })
})

describe('落盘 / 读取 / 删除', () => {
  test('用原始文件名落盘，读回字节一致', () => {
    const dir = tempDir()
    try {
      const bytes = new Uint8Array([1, 2, 3, 4, 5])
      const name = writeBgFile(bytes, '我的壁纸.png', 'image/png', dir)

      expect(name).toBe('我的壁纸.png')
      expect(existsSync(join(dir, '我的壁纸.png'))).toBe(true)
      expect(readFileSync(join(dir, '我的壁纸.png'))).toEqual(Buffer.from(bytes))
      expect(readBgFile(name, dir)).toEqual(bytes)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('内容相同复用同名文件，内容不同追加 -1 / -2 后缀', () => {
    const dir = tempDir()
    try {
      const first = writeBgFile(new Uint8Array([1]), 'bg.png', 'image/png', dir)
      const same = writeBgFile(new Uint8Array([1]), 'bg.png', 'image/png', dir)
      const other = writeBgFile(new Uint8Array([2]), 'bg.png', 'image/png', dir)
      const third = writeBgFile(new Uint8Array([3]), 'bg.png', 'image/png', dir)

      expect(first).toBe('bg.png')
      expect(same).toBe('bg.png') // 内容一致 → 复用
      expect(other).toBe('bg-1.png')
      expect(third).toBe('bg-2.png')
      expect(readdirSync(dir).sort()).toEqual(['bg-1.png', 'bg-2.png', 'bg.png'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('危险文件名落盘后仍在 dir 内（不会穿越出去）', () => {
    const dir = tempDir()
    try {
      const name = writeBgFile(new Uint8Array([9]), '../../evil.png', 'image/png', dir)
      expect(name).toBe('evil.png')
      expect(existsSync(join(dir, 'evil.png'))).toBe(true)
      expect(existsSync(join(dir, '..', 'evil.png'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('读取不存在的文件返回 null；删除返回是否真的删掉了', () => {
    const dir = tempDir()
    try {
      expect(readBgFile('nope.png', dir)).toBeNull()
      expect(bgFileExists('nope.png', dir)).toBe(false)
      expect(deleteBgFile('nope.png', dir)).toBe(false)

      writeFileSync(join(dir, 'x.png'), Buffer.from([1]))
      expect(bgFileExists('x.png', dir)).toBe(true)
      // 越界名一律视为不存在
      expect(bgFileExists('../x.png', dir)).toBe(false)

      expect(deleteBgFile('x.png', dir)).toBe(true)
      expect(deleteBgFile('x.png', dir)).toBe(false)
      expect(bgFileExists('x.png', dir)).toBe(false)
      expect(existsSync(join(dir, 'x.png'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
