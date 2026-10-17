/**
 * 壁纸地址映射单测。
 *
 * 这张表是「本机路径 vs URL」的唯一判据，判错了就是背景裂图，所以逐条固化。
 */
import { describe, expect, test } from 'bun:test'
import { isGatedWallpaper, localImageUrl, toWallpaperCssUrl } from './wallpaper-url'

describe('toWallpaperCssUrl', () => {
  test('本机绝对路径走服务端读取', () => {
    expect(toWallpaperCssUrl('/Users/me/Pictures/x.jpg')).toBe(
      '/api/local-image?path=%2FUsers%2Fme%2FPictures%2Fx.jpg',
    )
    expect(toWallpaperCssUrl('/Users/starm/Pictures/a b.jpg')).toBe(
      '/api/local-image?path=%2FUsers%2Fstarm%2FPictures%2Fa%20b.jpg',
    )
  })

  test('~/ 与 file:// 同样走服务端读取（面板外/内都能写这两种）', () => {
    expect(toWallpaperCssUrl('~/Pictures/x.jpg')).toBe('/api/local-image?path=~%2FPictures%2Fx.jpg')
    expect(toWallpaperCssUrl('file:///tmp/x.png')).toBe(
      '/api/local-image?path=file%3A%2F%2F%2Ftmp%2Fx.png',
    )
  })

  test('面板自己的地址原样保留（别把它当成本机路径）', () => {
    expect(toWallpaperCssUrl('/bg/我的壁纸.png')).toBe('/bg/我的壁纸.png')
    expect(toWallpaperCssUrl('/api/assets/1c8b36b2f12eab82')).toBe('/api/assets/1c8b36b2f12eab82')
    expect(toWallpaperCssUrl('/assets/index-a1b2c3d4.js')).toBe('/assets/index-a1b2c3d4.js')
  })

  test('完整 URL / 协议相对 / data: / 相对地址原样交给浏览器', () => {
    expect(toWallpaperCssUrl('https://example.com/bg.jpg')).toBe('https://example.com/bg.jpg')
    expect(toWallpaperCssUrl('//cdn.example.com/bg.jpg')).toBe('//cdn.example.com/bg.jpg')
    expect(toWallpaperCssUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(toWallpaperCssUrl('bg/x.jpg')).toBe('bg/x.jpg')
  })

  test('空值返回空串（调用方据此不设背景），首尾空格忽略', () => {
    expect(toWallpaperCssUrl('')).toBe('')
    expect(toWallpaperCssUrl('   ')).toBe('')
    expect(toWallpaperCssUrl('  /tmp/x.png  ')).toBe(localImageUrl('/tmp/x.png'))
  })
})

describe('isGatedWallpaper', () => {
  test('图片类壁纸要等登录后才能请求', () => {
    // 这两个地址分别落在 /bg/* 与 /api/wallpaper/*，都在门禁后面
    expect(isGatedWallpaper('asset')).toBe(true)
    expect(isGatedWallpaper('bing')).toBe(true)
  })

  test('纯 CSS 壁纸随时可渲染（登录页也能用）', () => {
    expect(isGatedWallpaper('solid')).toBe(false)
    expect(isGatedWallpaper('gradient')).toBe(false)
    expect(isGatedWallpaper('')).toBe(false)
  })
})
