/**
 * 内外网 URL 解析的单元测试。
 *
 * 这是本项目最核心的逻辑，docs/DESIGN.md §6 要求覆盖
 * 「3 种卡片偏好 × 3 种全局模式」的完整优先级矩阵，以及各字段缺失时的回退。
 */
import { describe, expect, test } from 'bun:test'
import { describeSource, resolveUrl } from './resolve-url'
import type { Item, NetworkMode, NetworkPref } from './types'

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
  const modes: NetworkMode[] = ['lan', 'wan', 'auto']

  for (const mode of modes) {
    test(`pref=lan 时，全局 mode=${mode} 不影响结果`, () => {
      const r = resolveUrl(makeItem(LAN, WAN, 'lan'), { mode, lanReachable: false })
      expect(r.url).toBe(LAN)
      expect(r.source).toBe('lan')
    })

    test(`pref=wan 时，全局 mode=${mode} 不影响结果`, () => {
      const r = resolveUrl(makeItem(LAN, WAN, 'wan'), { mode, lanReachable: true })
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

describe('resolveUrl — 全局 auto 依赖探测结果', () => {
  test('探测可达 → 内网', () => {
    const r = resolveUrl(makeItem(LAN, WAN), { mode: 'auto', lanReachable: true })
    expect(r.url).toBe(LAN)
    expect(r.source).toBe('lan')
  })

  test('探测不可达 → 外网', () => {
    const r = resolveUrl(makeItem(LAN, WAN), { mode: 'auto', lanReachable: false })
    expect(r.url).toBe(WAN)
    expect(r.source).toBe('wan')
  })

  test('探测结果未知 → 保守选外网（外网在任何网络下都更可能可达）', () => {
    const r = resolveUrl(makeItem(LAN, WAN), { mode: 'auto' })
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

  test('只有内网地址 + auto 且不可达 → 仍回退内网（总比打不开好）', () => {
    const r = resolveUrl(makeItem(LAN, null), { mode: 'auto', lanReachable: false })
    expect(r.url).toBe(LAN)
    expect(r.source).toBe('fallback')
  })

  test('两边都为空 → null / none', () => {
    for (const pref of ['auto', 'lan', 'wan'] as NetworkPref[]) {
      for (const mode of ['lan', 'wan', 'auto'] as NetworkMode[]) {
        const r = resolveUrl(makeItem(null, null, pref), { mode })
        expect(r.url).toBeNull()
        expect(r.source).toBe('none')
      }
    }
  })
})

describe('resolveUrl — 任意组合下都不会返回「空 URL 但有地址可选」', () => {
  const prefs: NetworkPref[] = ['auto', 'lan', 'wan']
  const modes: NetworkMode[] = ['lan', 'wan', 'auto']
  const urls: Array<[string | null, string | null]> = [
    [LAN, WAN],
    [LAN, null],
    [null, WAN],
  ]

  test('穷举 3×3×3×2：只要存在任一地址就必有结果', () => {
    for (const pref of prefs) {
      for (const mode of modes) {
        for (const [lan, wan] of urls) {
          for (const reachable of [true, false, undefined]) {
            const r = resolveUrl(makeItem(lan, wan, pref), {
              mode,
              lanReachable: reachable,
            })
            expect(r.url).not.toBeNull()
            expect([LAN, WAN]).toContain(r.url!)
            expect(r.source).not.toBe('none')
          }
        }
      }
    }
  })
})

describe('describeSource', () => {
  test('返回中文可读文案', () => {
    expect(describeSource('lan')).toBe('内网')
    expect(describeSource('wan')).toBe('外网')
    expect(describeSource('fallback')).toBe('回退')
    expect(describeSource('none')).toBe('未配置')
  })
})
