/**
 * 图片 ETag / 响应头单测。
 *
 * 重点固化「同名换图」这个场景：大小一样、mtime 撞在同一毫秒（文件系统精度只到
 * 秒时更糟），只有内容头部哈希能把它们区分开 —— 否则浏览器会一直显示旧图。
 */
import { describe, expect, test } from 'bun:test'
import { imageEtag, imageHeaders } from './image-file'

const png = (fill: number): Uint8Array => {
  // 真 PNG 头 + 填充，模拟「同一张图换了填充内容」
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return Uint8Array.from([...head, ...new Array(32).fill(fill)])
}

describe('imageEtag', () => {
  test('大小 / mtime / 内容任一变化都会换一个 ETag', () => {
    const base = imageEtag(png(1), 100, 1_700_000_000_000)
    expect(imageEtag(png(1), 100, 1_700_000_000_000)).toBe(base)
    expect(imageEtag(png(2), 100, 1_700_000_000_000)).not.toBe(base) // 内容变了
    expect(imageEtag(png(1), 101, 1_700_000_000_000)).not.toBe(base) // 大小变了
    expect(imageEtag(png(1), 100, 1_700_000_000_001)).not.toBe(base) // mtime 变了
  })

  test('同大小 + 同 mtime（同毫秒替换）也能识别出换图', () => {
    const old = png(0xaa)
    const next = png(0xbb)
    expect(next.byteLength).toBe(old.byteLength)
    const mtime = 1_700_000_000_000
    expect(imageEtag(next, next.byteLength, mtime)).not.toBe(
      imageEtag(old, old.byteLength, mtime),
    )
  })

  test('是合法的强 ETag（带引号）', () => {
    const etag = imageEtag(png(1), 100, 1)
    expect(etag.startsWith('"')).toBe(true)
    expect(etag.endsWith('"')).toBe(true)
  })
})

describe('imageHeaders', () => {
  test('普通图片：no-cache + ETag，不带 CSP', () => {
    const headers = imageHeaders('image/png', '"x"')
    expect(headers['cache-control']).toBe('no-cache')
    expect(headers['etag']).toBe('"x"')
    expect(headers['content-security-policy']).toBeUndefined()
  })

  test('SVG 额外加 sandbox CSP（直接打开时不执行内嵌脚本）', () => {
    const headers = imageHeaders('image/svg+xml', '"x"')
    expect(headers['content-security-policy']).toContain("default-src 'none'")
    expect(headers['content-security-policy']).toContain('sandbox')
  })
})
