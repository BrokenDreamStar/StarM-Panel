/**
 * 「系统状态」卡片清单纯逻辑的单测。
 *
 * 覆盖两条易错路径：
 *   1. 旧值（纯字符串 / 缺 device）与新值（显式设备）混存时的展开与去重；
 *   2. 对「自动」条目做移除 / 拖拽时先物化成具体设备，且不产生重复。
 */
import { describe, expect, test } from 'bun:test'
import {
  cardEntryId,
  readMonitorCards,
  type MonitorCardEntry,
  type MonitorCardKind,
} from '@/api/settings'
import {
  expandCards,
  listCandidates,
  materializeKinds,
  moveCard,
  removeCard,
  sameCardEntries,
  type DeviceSlot,
} from './stat-cards'

const SLOTS: Partial<Record<MonitorCardKind, DeviceSlot[]>> = {
  disk: [
    { device: '/', hint: '根目录' },
    { device: '/data', hint: '数据盘' },
  ],
  gpu: [
    { device: '0', hint: 'RTX 4090' },
    { device: '1', hint: 'RTX 4090' },
  ],
  network: [{ device: 'eth0', hint: '千兆' }],
}

const slots = (kind: MonitorCardKind): readonly DeviceSlot[] => SLOTS[kind] ?? []
const exists = (kind: MonitorCardKind, device: string): boolean =>
  slots(kind).some((s) => s.device === device)

const ids = (list: readonly MonitorCardEntry[]): string[] => list.map(cardEntryId)

describe('readMonitorCards', () => {
  test('兼容旧值：字符串条目 = 自动条目', () => {
    expect(readMonitorCards({ 'monitor.cards': ['cpu', 'disk'] })).toEqual([
      { kind: 'cpu' },
      { kind: 'disk' },
    ])
  })

  test('解析显式设备条目并保留顺序', () => {
    expect(
      readMonitorCards({
        'monitor.cards': [{ kind: 'gpu', device: '1' }, { kind: 'memory' }],
      }),
    ).toEqual([{ kind: 'gpu', device: '1' }, { kind: 'memory' }])
  })

  test('剔除未知 kind、空 device 回落成自动、按 id 去重', () => {
    expect(
      readMonitorCards({
        'monitor.cards': [
          { kind: 'bogus' },
          { kind: 'disk', device: '' },
          { kind: 'disk' },
          { kind: 'disk', device: '/data' },
          { kind: 'disk', device: '/data' },
        ],
      }),
    ).toEqual([{ kind: 'disk' }, { kind: 'disk', device: '/data' }])
  })
})

describe('expandCards', () => {
  test('自动条目按设备展开成多张卡', () => {
    const cards = expandCards([{ kind: 'disk' }, { kind: 'gpu' }], slots, exists)
    expect(cards.map((c) => c.id)).toEqual([
      'disk:/',
      'disk:/data',
      'gpu:0',
      'gpu:1',
    ])
    expect(cards.every((c) => c.auto)).toBe(true)
  })

  test('显式设备卡片优先，自动条目跳过已占用设备', () => {
    const cards = expandCards([{ kind: 'gpu', device: '1' }, { kind: 'gpu' }], slots, exists)
    expect(cards.map((c) => c.id)).toEqual(['gpu:1', 'gpu:0'])
  })

  test('设备已消失的显式卡片不再渲染', () => {
    const gone = (_kind: MonitorCardKind, device: string): boolean => device !== 'ghost'
    const cards = expandCards([{ kind: 'network', device: 'ghost' }], slots, gone)
    expect(cards).toEqual([])
  })
})

describe('listCandidates', () => {
  test('自动条目覆盖的设备不再作为候选', () => {
    expect(ids(listCandidates([{ kind: 'disk' }, { kind: 'cpu' }], slots))).toEqual([
      'memory:',
      'network:eth0',
      'gpu:0',
      'gpu:1',
      'system:',
    ])
  })

  test('显式占用的设备从候选中剔除，其余逐台列出', () => {
    expect(
      ids(listCandidates([{ kind: 'gpu', device: '0' }, { kind: 'cpu' }], slots)),
    ).toEqual(['memory:', 'disk:/', 'disk:/data', 'network:eth0', 'gpu:1', 'system:'])
  })
})

describe('materializeKinds', () => {
  test('把自动条目物化成具体设备，并跳过已显式占用的设备', () => {
    const next = materializeKinds(
      [{ kind: 'disk' }, { kind: 'disk', device: '/data' }, { kind: 'cpu' }],
      new Set<MonitorCardKind>(['disk']),
      slots,
    )
    expect(ids(next)).toEqual(['disk:/', 'disk:/data', 'cpu:'])
  })
})

describe('removeCard', () => {
  test('移除自动展开的一张卡时物化兄弟设备', () => {
    const next = removeCard(
      [{ kind: 'cpu' }, { kind: 'disk' }],
      { kind: 'disk', device: '/', auto: true, id: 'disk:/' },
      slots,
    )
    expect(ids(next)).toEqual(['cpu:', 'disk:/data'])
  })

  test('已不存在卡片（设备被显式占用）时为无操作', () => {
    const entries: MonitorCardEntry[] = [{ kind: 'disk', device: '/data' }, { kind: 'disk' }]
    const next = removeCard(
      entries,
      { kind: 'disk', device: '/data', auto: true, id: 'disk:/data' },
      slots,
    )
    expect(ids(next)).toEqual(ids(entries))
  })

  test('移除显式卡片只删这一条', () => {
    const next = removeCard(
      [{ kind: 'gpu', device: '0' }, { kind: 'gpu', device: '1' }],
      { kind: 'gpu', device: '0', id: 'gpu:0' },
      slots,
    )
    expect(ids(next)).toEqual(['gpu:1'])
  })
})

describe('moveCard', () => {
  test('按设备粒度移动，自动条目先物化', () => {
    const next = moveCard(
      [{ kind: 'cpu' }, { kind: 'disk' }],
      { kind: 'cpu', id: 'cpu:' },
      { kind: 'disk', device: '/data', auto: true, id: 'disk:/data' },
      slots,
    )
    expect(ids(next)).toEqual(['disk:/', 'disk:/data', 'cpu:'])
  })

  test('移动显式设备卡片只改顺序', () => {
    const entries: MonitorCardEntry[] = [
      { kind: 'gpu', device: '0' },
      { kind: 'gpu', device: '1' },
      { kind: 'cpu' },
    ]
    const next = moveCard(
      entries,
      { kind: 'cpu', id: 'cpu:' },
      { kind: 'gpu', device: '0', id: 'gpu:0' },
      slots,
    )
    expect(ids(next)).toEqual(['cpu:', 'gpu:0', 'gpu:1'])
  })
})

describe('sameCardEntries', () => {
  test('忽略 auto 标记，只比较 kind + device', () => {
    expect(
      sameCardEntries([{ kind: 'disk', device: '/' }], [{ kind: 'disk', device: '/' }]),
    ).toBe(true)
    expect(
      sameCardEntries([{ kind: 'disk', device: '/' }], [{ kind: 'disk', device: '/data' }]),
    ).toBe(false)
  })
})
