/**
 * 内外网 URL 解析的单元测试。
 *
 * docs/DESIGN.md §6 要求覆盖「3 种卡片偏好 × 2 种落地模式」的优先级矩阵，
 * 以及各字段缺失时的回退。全局 mode 只接收 lan / wan：'auto' 由调用方
 * （network store）按 isLanHost 的访问方式判定落地，这里同时覆盖该判定。
 */
import { describe, expect, test } from 'bun:test'
import { describeSource, isLanHost, resolveUrl } from './resolve-url'
import type { Item, NetworkPref } from './types'

const LAN = 'http://192.168.1.5:5000/'
const WAN = 'https://nas.example.com/'

/** 构造一张只关心网络字段的卡片 */
function makeItem(
  lanUrl: string | null,
  wanUrl: string | null,
  networkPref: NetworkPref = 'auto',
): Item {
  return {
    id: 1,
    groupId: null,
    title: 't',
    subtitle: null,
    iconType: 'iconify',
    iconValue: null,
    iconColor: null,
    bgColor: null,
    lanUrl,
    wanUrl,
    networkPref,
    sort: 0,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('resolveUrl — 卡片级偏好优先于全局模式', () => {
  const modes = ['lan', 'wan'] as const

  for (const mode of modes) {
    test(`pref=lan 时，全局 mode=${mode} 不影响结果`, () => {
      const r = resolveUrl(makeItem(LAN, WAN, 'lan'), { mode })
      expect(r.url).toBe(LAN)
      expect(r.source).toBe('lan')
    })

    test(`pref=wan 时，全局 mode=${mode} 不影响结果`, () => {
      const r = resolveUrl(makeItem(LAN, WAN, 'wan'), { mode })
      expect(r.url).toBe(WAN)
      expect(r.source).toBe('wan')
    })
  }
})

describe('resolveUrl — 全局模式（卡片 pref=auto）', () => {
  test('mode=lan 选内网', () => {
    const r = resolveUrl(makeItem(LAN, WAN), { mode: 'lan' })
    expect(r.url).toBe(LAN)
    expect(r.source).toBe('lan')
  })

  test('mode=wan 选外网', () => {
    const r = resolveUrl(makeItem(LAN, WAN), { mode: 'wan' })
    expect(r.url).toBe(WAN)
    expect(r.source).toBe('wan')
  })
})

describe('resolveUrl — 单边地址缺失时回退，绝不返回 null（除非两边都空）', () => {
  test('只有内网地址 + mode=wan → 回退内网', () => {
    const r = resolveUrl(makeItem(LAN, null), { mode: 'wan' })
    expect(r.url).toBe(LAN)
    expect(r.source).toBe('fallback')
  })

  test('只有外网地址 + mode=lan → 回退外网', () => {
    const r = resolveUrl(makeItem(null, WAN), { mode: 'lan' })
    expect(r.url).toBe(WAN)
    expect(r.source).toBe('fallback')
  })

  test('只有内网地址 + pref=wan → 回退内网', () => {
    const r = resolveUrl(makeItem(LAN, null, 'wan'), { mode: 'lan' })
    expect(r.url).toBe(LAN)
    expect(r.source).toBe('fallback')
  })

  test('只有外网地址 + pref=lan → 回退外网', () => {
    const r = resolveUrl(makeItem(null, WAN, 'lan'), { mode: 'wan' })
    expect(r.url).toBe(WAN)
    expect(r.source).toBe('fallback')
  })

  test('两边都为空 → null / none', () => {
    for (const pref of ['auto', 'lan', 'wan'] as NetworkPref[]) {
      for (const mode of ['lan', 'wan'] as const) {
        const r = resolveUrl(makeItem(null, null, pref), { mode })
        expect(r.url).toBeNull()
        expect(r.source).toBe('none')
      }
    }
  })
})

describe('resolveUrl — 任意组合下都不会返回「空 URL 但有地址可选」', () => {
  const prefs: NetworkPref[] = ['auto', 'lan', 'wan']
  const modes = ['lan', 'wan'] as const
  const urls: Array<[string | null, string | null]> = [
    [LAN, WAN],
    [LAN, null],
    [null, WAN],
  ]

  test('穷举 3×2×3：只要存在任一地址就必有结果', () => {
    for (const pref of prefs) {
      for (const mode of modes) {
        for (const [lan, wan] of urls) {
          const r = resolveUrl(makeItem(lan, wan, pref), { mode })
          expect(r.url).not.toBeNull()
          expect([LAN, WAN]).toContain(r.url!)
          expect(r.source).not.toBe('none')
        }
      }
    }
  })
})

describe('isLanHost — IP 字面量 / 本机视为内网', () => {
  const lanHosts = [
    '192.168.1.10',
    '192.168.0.1',
    '10.2.3.4',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '172.15.0.1',
    '172.32.0.1',
    '127.0.0.1',
    '0.0.0.0',
    '169.254.9.9',
    '11.0.0.1',
    '192.169.1.1',
    '100.64.0.1',
    '8.8.8.8',
    'localhost',
    'panel.localhost',
    '::1',
    '::',
    '[::1]',
    'fe80::1',
    'febf::abcd',
    'fc00::abcd',
    'fd12:3456::1',
    '2408:8207::1',
    '2606:4700::1111',
  ]

  for (const host of lanHosts) {
    test(`${host} → 内网`, () => {
      expect(isLanHost(host)).toBe(true)
    })
  }
})

describe('isLanHost — 域名视为外网', () => {
  const wanHosts = [
    'nas.example.com',
    'panel.home.arpa',
    'mynas.local',
    '999.1.1.1',
    '',
  ]

  for (const host of wanHosts) {
    test(`${host === '' ? '(空)' : host} → 外网`, () => {
      expect(isLanHost(host)).toBe(false)
    })
  }
})

describe('describeSource', () => {
  test('返回中文可读文案', () => {
    expect(describeSource('lan')).toBe('内网')
    expect(describeSource('wan')).toBe('外网')
    expect(describeSource('fallback')).toBe('回退')
    expect(describeSource('none')).toBe('未配置')
  })
})
