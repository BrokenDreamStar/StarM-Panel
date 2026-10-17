/**
 * 本地图片路径解析单测（纯函数，不碰数据库、不碰文件系统）。
 */
import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandHome, localImagePath } from './local-image'

describe('expandHome', () => {
  test('展开 ~ 与 ~/…', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/Pictures/x.jpg')).toBe(join(homedir(), 'Pictures/x.jpg'))
  })

  test('中间 / 结尾的 ~ 与 ~user 不动', () => {
    expect(expandHome('/a/~/b.png')).toBe('/a/~/b.png')
    expect(expandHome('~other/x.png')).toBe('~other/x.png')
    expect(expandHome('/tmp/~')).toBe('/tmp/~')
  })
})

describe('localImagePath', () => {
  test('绝对路径归一化后返回', () => {
    expect(localImagePath('/Users/me/Pictures/x.jpg')).toBe('/Users/me/Pictures/x.jpg')
    // . 与 .. 会被消掉，避免同一张图有两种写法
    expect(localImagePath('/Users/me/./Pictures/../Pictures/x.jpg')).toBe(
      '/Users/me/Pictures/x.jpg',
    )
    expect(localImagePath('  /tmp/x.png  ')).toBe('/tmp/x.png')
  })

  test('file:// URL 与 ~ 开头的路径', () => {
    expect(localImagePath('file:///tmp/x.png')).toBe('/tmp/x.png')
    expect(localImagePath('file:///tmp/%E6%A3%AE%E6%9E%97.png')).toBe('/tmp/森林.png')
    expect(localImagePath('~/Pictures/x.png')).toBe(join(homedir(), 'Pictures/x.png'))
  })

  test('URL / 协议相对地址 / 相对地址 / 空值都不是本地路径', () => {
    expect(localImagePath('https://a.example/b.jpg')).toBeNull()
    expect(localImagePath('//cdn.example.com/b.jpg')).toBeNull()
    expect(localImagePath('data:image/png;base64,AAAA')).toBeNull()
    expect(localImagePath('bg/x.jpg')).toBeNull()
    expect(localImagePath('')).toBeNull()
    expect(localImagePath('   ')).toBeNull()
    expect(localImagePath(undefined)).toBeNull()
    expect(localImagePath(123)).toBeNull()
  })
})
