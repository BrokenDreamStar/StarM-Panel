/**
 * 版本比较 / 发布包识别的纯函数单测。
 *
 * 这些规则决定「要不要提示更新」和「下载哪个文件」—— 判错会让人反复更新
 * 或装错平台，因此按边界情况逐个钉住。
 */
import { describe, expect, test } from 'bun:test'
import {
  assetNameCandidates,
  compareVersions,
  isAllowedDownloadUrl,
  isAllowedSourceUrl,
  isNewerRelease,
  isLoopbackHost,
  isPlatformExecutableHeader,
  parseReleaseTag,
  parseUpdateManifest,
  platformFromAssetName,
  platformSuffix,
  tagFromReleaseLocation,
} from './update'

describe('parseReleaseTag', () => {
  test('解析带运行序号的发布 tag', () => {
    expect(parseReleaseTag('v0.1.0-5')).toEqual({ tag: 'v0.1.0-5', version: '0.1.0', build: 5 })
  })

  test('解析不带序号的版本', () => {
    expect(parseReleaseTag('0.2.1')).toEqual({ tag: '0.2.1', version: '0.2.1', build: null })
  })

  test('去掉数字段的前导零', () => {
    expect(parseReleaseTag('v01.002.0003-07')?.version).toBe('1.2.3')
    expect(parseReleaseTag('v01.002.0003-07')?.build).toBe(7)
  })

  test('非法 / 预发布 tag 返回 null', () => {
    expect(parseReleaseTag('v0.1.0-beta.1')).toBeNull()
    expect(parseReleaseTag('latest')).toBeNull()
    expect(parseReleaseTag('v0.1')).toBeNull()
    expect(parseReleaseTag('')).toBeNull()
    expect(parseReleaseTag(null)).toBeNull()
  })
})

describe('compareVersions', () => {
  test('按数字段比较而不是字符串比较', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1)
  })
})

describe('isNewerRelease', () => {
  const current = { tag: 'v0.1.0-5', version: '0.1.0', build: 5 }

  test('版本号更高 → 有更新', () => {
    expect(isNewerRelease({ tag: 'v0.2.0-1', version: '0.2.0', build: 1 }, current)).toBe(true)
  })

  test('同版本序号更大 → 有更新；更小 → 没有', () => {
    expect(isNewerRelease({ tag: 'v0.1.0-6', version: '0.1.0', build: 6 }, current)).toBe(true)
    expect(isNewerRelease({ tag: 'v0.1.0-4', version: '0.1.0', build: 4 }, current)).toBe(false)
  })

  test('版本号回退时不因序号大而提示更新', () => {
    expect(isNewerRelease({ tag: 'v0.0.9-99', version: '0.0.9', build: 99 }, current)).toBe(false)
  })

  test('缺发布序号时只认版本号（避免同版本反复提示更新）', () => {
    expect(isNewerRelease({ tag: 'v0.1.0', version: '0.1.0', build: null }, current)).toBe(false)
    expect(
      isNewerRelease({ tag: 'v0.1.0-6', version: '0.1.0', build: 6 }, {
        tag: 'v0.1.0',
        version: '0.1.0',
        build: null,
      }),
    ).toBe(false)
  })
})

describe('platformSuffix', () => {
  test('平台后缀与 release 矩阵一致', () => {
    expect(platformSuffix('darwin', 'arm64')).toBe('darwin-arm64')
    expect(platformSuffix('linux', 'x64')).toBe('linux-x64')
    expect(platformSuffix('win32', 'x64')).toBe('windows-x64')
    expect(platformSuffix('linux', 'ia32')).toBeNull()
    expect(platformSuffix('freebsd', 'x64')).toBeNull()
  })
})

describe('platformFromAssetName', () => {
  test('兼容带版本号 / 不带版本号 / Windows .exe', () => {
    expect(platformFromAssetName('starm-panel-v0.1.0-linux-x64')).toBe('linux-x64')
    expect(platformFromAssetName('starm-panel-linux-x64')).toBe('linux-x64')
    expect(platformFromAssetName('starm-panel-v0.1.0-windows-arm64.exe')).toBe('windows-arm64')
    expect(platformFromAssetName('starm-panel-darwin-arm64')).toBe('darwin-arm64')
  })

  test('识别不出的文件返回 null', () => {
    expect(platformFromAssetName('latest.json')).toBeNull()
    expect(platformFromAssetName('starm-panel-linux-riscv64')).toBeNull()
    expect(platformFromAssetName('starm-panel')).toBeNull()
  })
})

describe('parseUpdateManifest', () => {
  const sha = 'a'.repeat(64)
  const base = {
    schema: 1,
    tag: 'v0.1.0-6',
    version: '0.1.0',
    publishedAt: '2026-10-19T00:00:00.000Z',
    assets: [
      { platform: 'linux-x64', name: 'starm-panel-v0.1.0-linux-x64', size: 123, sha256: sha },
      { platform: 'windows-arm64', name: 'starm-panel-v0.1.0-windows-arm64.exe', size: 456, sha256: sha.toUpperCase() },
    ],
  }

  test('合法清单：派生版本、统一 sha256 小写', () => {
    const manifest = parseUpdateManifest(base)
    expect(manifest).not.toBeNull()
    expect(manifest?.tag).toBe('v0.1.0-6')
    expect(manifest?.version).toBe('0.1.0')
    expect(manifest?.assets).toHaveLength(2)
    expect(manifest?.assets[1]?.sha256).toBe(sha)
  })

  test('缺少 publishedAt 不算坏清单', () => {
    const { publishedAt: _omit, ...rest } = base
    expect(parseUpdateManifest(rest)?.publishedAt).toBeNull()
  })

  test('拒绝结构 / 版本 / 平台 / 大小 / sha256 不合法的清单', () => {
    expect(parseUpdateManifest(null)).toBeNull()
    expect(parseUpdateManifest({ ...base, schema: 2 })).toBeNull()
    expect(parseUpdateManifest({ ...base, tag: 'latest' })).toBeNull()
    expect(parseUpdateManifest({ ...base, version: '0.2.0' })).toBeNull()
    expect(parseUpdateManifest({ ...base, assets: [] })).toBeNull()
    expect(
      parseUpdateManifest({
        ...base,
        assets: [{ platform: 'linux-x64', name: 'x', size: 0, sha256: sha }],
      }),
    ).toBeNull()
    expect(
      parseUpdateManifest({
        ...base,
        assets: [{ platform: 'linux-x64', name: 'x', size: 1, sha256: 'nope' }],
      }),
    ).toBeNull()
    expect(
      parseUpdateManifest({
        ...base,
        assets: [{ platform: 'linux-riscv64', name: 'x', size: 1, sha256: sha }],
      }),
    ).toBeNull()
  })

  test('忽略未知平台，但不会因此接受空清单', () => {
    const withFuture = parseUpdateManifest({
      ...base,
      assets: [
        ...base.assets,
        { platform: 'linux-riscv64', name: 'starm-panel-linux-riscv64', size: 1, sha256: sha },
      ],
    })
    expect(withFuture?.assets).toHaveLength(2)
    expect(
      parseUpdateManifest({
        ...base,
        assets: [{ platform: 'linux-riscv64', name: 'starm-panel-linux-riscv64', size: 1, sha256: sha }],
      }),
    ).toBeNull()
  })

  test('拒绝重复平台与带路径分隔符的资产名', () => {
    expect(
      parseUpdateManifest({
        ...base,
        assets: [
          { platform: 'linux-x64', name: 'a', size: 1, sha256: sha },
          { platform: 'linux-x64', name: 'b', size: 1, sha256: sha },
        ],
      }),
    ).toBeNull()
    expect(
      parseUpdateManifest({
        ...base,
        assets: [{ platform: 'linux-x64', name: '../starm-panel', size: 1, sha256: sha }],
      }),
    ).toBeNull()
  })
})

describe('下载地址白名单', () => {
  test('允许 GitHub 官方与资产 CDN', () => {
    expect(
      isAllowedDownloadUrl('https://github.com/o/r/releases/download/v0.1.0-5/starm-panel-linux-x64'),
    ).toBe(true)
    expect(
      isAllowedDownloadUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x'),
    ).toBe(true)
    expect(isAllowedDownloadUrl('https://objects.githubusercontent.com/x')).toBe(true)
  })

  test('拒绝非 https、外部域名与伪造域名', () => {
    expect(isAllowedDownloadUrl('http://github.com/o/r')).toBe(false)
    expect(isAllowedDownloadUrl('https://evil.example.com/starm-panel')).toBe(false)
    expect(isAllowedDownloadUrl('https://github.com.evil.example.com/x')).toBe(false)
    expect(isAllowedDownloadUrl('https://notgithub.com/x')).toBe(false)
    expect(isAllowedDownloadUrl('https://user:pass@github.com/x')).toBe(false)
    expect(isAllowedDownloadUrl('not a url')).toBe(false)
  })
})

describe('isAllowedSourceUrl', () => {
  test('https 地址一律放行', () => {
    expect(isAllowedSourceUrl('https://api.github.com')).toBe(true)
    expect(isAllowedSourceUrl('https://ghproxy.example.com/')).toBe(true)
  })

  test('http 只对回环地址放行（本地镜像 / 调试）', () => {
    expect(isAllowedSourceUrl('http://127.0.0.1:43211')).toBe(true)
    expect(isAllowedSourceUrl('http://localhost:8080/')).toBe(true)
    expect(isAllowedSourceUrl('http://[::1]:9000')).toBe(true)
    expect(isAllowedSourceUrl('http://mirror.example.com/')).toBe(false)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
  })

  test('拒绝带凭据 / 非法地址', () => {
    expect(isAllowedSourceUrl('https://user:pass@api.github.com')).toBe(false)
    expect(isAllowedSourceUrl('')).toBe(false)
    expect(isAllowedSourceUrl('not a url')).toBe(false)
  })
})

describe('assetNameCandidates', () => {
  test('新版带版本号，旧版不带；Windows 自动补 .exe', () => {
    expect(assetNameCandidates('0.1.0', 'linux-x64')).toEqual([
      'starm-panel-v0.1.0-linux-x64',
      'starm-panel-linux-x64',
    ])
    expect(assetNameCandidates('0.1.0', 'windows-x64')).toEqual([
      'starm-panel-v0.1.0-windows-x64.exe',
      'starm-panel-windows-x64.exe',
    ])
    expect(assetNameCandidates('1.2.3', 'darwin-arm64')[0]).toBe('starm-panel-v1.2.3-darwin-arm64')
  })
})

describe('tagFromReleaseLocation', () => {
  const web = 'https://github.com'

  test('从绝对 / 相对跳转地址解析 tag', () => {
    expect(
      tagFromReleaseLocation(
        'https://github.com/o/r/releases/tag/v0.1.0-5',
        web,
      ),
    ).toBe('v0.1.0-5')
    expect(tagFromReleaseLocation('/o/r/releases/tag/v0.1.0-5', web)).toBe('v0.1.0-5')
    expect(tagFromReleaseLocation('/o/r/releases/tag/v0.1.0-5/', web)).toBe('v0.1.0-5')
  })

  test('拒绝跨站跳转与无法识别的路径', () => {
    expect(tagFromReleaseLocation('https://evil.example.com/o/r/releases/tag/v0.1.0-5', web)).toBeNull()
    expect(tagFromReleaseLocation('/o/r/releases', web)).toBeNull()
    expect(tagFromReleaseLocation('', web)).toBeNull()
  })
})

describe('isPlatformExecutableHeader', () => {
  const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])
  const macho = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00])
  const pe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00])
  const html = new Uint8Array([0x3c, 0x21, 0x2d, 0x2d])

  test('识别 ELF / Mach-O / PE', () => {
    expect(isPlatformExecutableHeader(elf, 'linux')).toBe(true)
    expect(isPlatformExecutableHeader(macho, 'darwin')).toBe(true)
    expect(isPlatformExecutableHeader(pe, 'win32')).toBe(true)
  })

  test('拒绝 HTML 错误页、错误平台与过短内容', () => {
    expect(isPlatformExecutableHeader(html, 'linux')).toBe(false)
    expect(isPlatformExecutableHeader(html, 'darwin')).toBe(false)
    expect(isPlatformExecutableHeader(html, 'win32')).toBe(false)
    expect(isPlatformExecutableHeader(elf, 'darwin')).toBe(false)
    expect(isPlatformExecutableHeader(new Uint8Array([0x7f, 0x45]), 'linux')).toBe(false)
  })
})
