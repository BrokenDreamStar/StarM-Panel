/**
 * `collectSnapshot()` 的采样方式回归测试。
 *
 * 三件事必须守住，它们都是「CPU 卡片 8%↔60% 方波」那次线上故障的直接产物：
 *   1. **不再调用 `si.currentLoad()`** —— 它的窗口跟着调用节奏走，是方波的根因；
 *   2. 慢变指标（磁盘容量 / 进程数 / 用户数）按 30s 缓存，不跟着主循环 spawn；
 *   3. 窗口过短时 CPU 读数沿用上一次，不把采集自身开销当成瞬时使用率。
 *
 * 必须独立成文件：`mock.module` 只对「导入被测模块之前」生效。
 */
import { describe, expect, mock, test } from 'bun:test'
import os from 'node:os'

const calls = {
  currentLoad: 0,
  fsSize: 0,
  processes: 0,
  users: 0,
}

mock.module('systeminformation', () => ({
  default: {
    currentLoad: async () => {
      calls.currentLoad += 1
      return { currentLoad: 99, cpus: [{ load: 99 }] }
    },
    // 故意让 si 的 used 虚高（= total − free），验证快照按 total − available 修正
    mem: async () => ({
      total: 8,
      used: 6,
      free: 2,
      available: 6,
      swaptotal: 0,
      swapused: 0,
    }),
    fsSize: async () => {
      calls.fsSize += 1
      return []
    },
    networkStats: async () => [],
    cpuTemperature: async () => ({ main: -1 }),
    time: () => ({ current: 0, uptime: 100, timezone: '', timezoneName: '' }),
    processes: async () => {
      calls.processes += 1
      return { all: 42 }
    },
    users: async () => {
      calls.users += 1
      return [{ user: 'starm' }]
    },
  },
}))

const { collectSnapshot, createCollectorState } = await import('./system-info')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('collectSnapshot 的采样方式', () => {
  test('不再调用 si.currentLoad()，CPU 走 os.cpus() 自维护窗口', async () => {
    const state = createCollectorState()
    const { snapshot } = await collectSnapshot(state, [])
    expect(calls.currentLoad).toBe(0)
    // 首轮只建立基线，不出数（窗口为 0）
    expect(snapshot.cpu.usage).toBe(0)
    expect(snapshot.cpu.perCore).toEqual([])
  })

  test('内存已用按 total − available 报（不用 si 那个含 page cache 的 used）', async () => {
    const { snapshot } = await collectSnapshot(createCollectorState(), [])
    expect(snapshot.mem.total).toBe(8)
    expect(snapshot.mem.available).toBe(6)
    expect(snapshot.mem.used).toBe(2) // 不是 si 报的 6
  })

  test('慢变指标在 TTL 内不重复采集', async () => {
    const before = { ...calls }
    let state = createCollectorState()
    const first = await collectSnapshot(state, [])
    state = first.next
    const afterFirst = { ...calls }
    // 首轮最多各采一次（缓存可能已被上一个用例填过，所以用 <= 1 而不是 === 1）
    expect(afterFirst.fsSize - before.fsSize).toBeLessThanOrEqual(1)
    expect(afterFirst.processes - before.processes).toBeLessThanOrEqual(1)
    expect(afterFirst.users - before.users).toBeLessThanOrEqual(1)

    await collectSnapshot(state, [])
    // 第二轮命中 30s 缓存，一次都不该再 spawn
    expect(calls.fsSize).toBe(afterFirst.fsSize)
    expect(calls.processes).toBe(afterFirst.processes)
    expect(calls.users).toBe(afterFirst.users)
  })

  test('窗口短于下限时沿用上次 CPU 读数，不出现跳变', async () => {
    let state = createCollectorState()
    const first = await collectSnapshot(state, [], { minCpuWindowMs: 50 })
    state = first.next
    await sleep(60)
    const second = await collectSnapshot(state, [], { minCpuWindowMs: 50 })

    // 窗口 60ms ≥ 50ms：真的出了一轮 os.cpus() 差分
    expect(second.snapshot.cpu.perCore.length).toBe(os.cpus().length)

    // 紧接着再来一次（窗口 ~0ms）：沿用上一次的值，而不是把采集开销当负载
    const third = await collectSnapshot(second.next, [], { minCpuWindowMs: 50 })
    expect(third.snapshot.cpu.usage).toBe(second.snapshot.cpu.usage)
    expect(third.snapshot.cpu.perCore).toEqual(second.snapshot.cpu.perCore)
  })
})
