/**
 * CPU 使用率测量窗口的单测。
 *
 * 线上故障（2026-10，Debian 2 核 + 内存吃紧）：CPU 卡片在 8% 与 60% 之间来回跳，
 * 内存 / 磁盘 / 网络却纹丝不动。抓到的原始数据显示采样间隔在 ~1.9s 与 ~0.12s
 * 之间交替，而 CPU 读数与窗口长度严格对应：短窗口 61%、长窗口 12%。
 *
 * 根因是使用率（当时来自 `si.currentLoad()`）恒等于「距上一次调用的平均」，
 * 窗口长度由调用节奏决定 —— 采样节奏一抖，读数就变成方波。
 * 现在窗口由自己维护：不足 `minWindowMs` 就沿用上次值、且不推进基线。
 */
import { describe, expect, test } from 'bun:test'
import {
  cachedCollect,
  computeCpuUsage,
  DEFAULT_MIN_CPU_WINDOW_MS,
  type CpuTimes,
  type CpuUsage,
} from './system-info'

/** 造一份累计计数器读数：n 个核心，各核 idle / busy 相同 */
function times(at: number, idle: number, busy: number, cores = 2): CpuTimes {
  return {
    at,
    perCore: Array.from({ length: cores }, () => ({ idle, total: idle + busy })),
  }
}

describe('computeCpuUsage', () => {
  test('正常 1s 窗口：按 idle 增量占比算使用率', () => {
    const prev = times(0, 1000, 1000) // total 2000
    const curr = times(1000, 1800, 1200) // Δidle=800 Δtotal=1000 → 20% 使用
    const { value, baseline } = computeCpuUsage(prev, curr, null, 800)
    expect(value.usage).toBe(20)
    expect(value.perCore).toEqual([20, 20])
    // 窗口够长 → 基线推进
    expect(baseline).toBe(curr)
  })

  test('每核心分别计算', () => {
    const prev: CpuTimes = {
      at: 0,
      perCore: [
        { idle: 0, total: 0 },
        { idle: 0, total: 0 },
      ],
    }
    const curr: CpuTimes = {
      at: 1000,
      perCore: [
        { idle: 900, total: 1000 }, // 10% 使用
        { idle: 0, total: 1000 }, // 100% 使用
      ],
    }
    const { value } = computeCpuUsage(prev, curr, null, 800)
    // 合计：Δidle=900 / Δtotal=2000 → 55%
    expect(value.usage).toBe(55)
    expect(value.perCore).toEqual([10, 100])
  })

  test('窗口过短：沿用上次值，且**不推进基线**（短窗口并进下一轮）', () => {
    const last: CpuUsage = { usage: 42, perCore: [40, 44] }
    const prev = times(10_000, 1000, 1000)
    const early = times(10_120, 1010, 1080) // 只有 120ms

    const short = computeCpuUsage(prev, early, last, DEFAULT_MIN_CPU_WINDOW_MS)
    expect(short.value).toEqual(last)
    // 关键：基线仍是 prev，下一轮量的是 [prev.at, 下一轮]
    expect(short.baseline).toBe(prev)

    // 下一轮窗口从上一轮的基线算起 → 覆盖了 2s，正常出数
    const later = times(12_000, 1800, 1100)
    const normal = computeCpuUsage(short.baseline, later, short.value, DEFAULT_MIN_CPU_WINDOW_MS)
    // Δidle=800 / Δtotal=(1800+1100)-(1000+1000)=900 → 11.1%
    expect(normal.value.usage).toBe(11.1)
    expect(normal.baseline).toBe(later)
  })

  test('用户报的那条曲线：长/短窗口交替时不再出现 8%↔60% 方波', () => {
    // 同一段真实负载，被两种节奏切成窗口：
    //   慢轮 1.9s 后紧跟一轮 120ms（setInterval 补发的典型形态）
    const last: CpuUsage = { usage: 12, perCore: [12, 12] }
    const base = times(0, 0, 0)
    const slow = times(1900, 1672, 228) // 12% 使用
    const first = computeCpuUsage(base, slow, last, 800)
    expect(first.value.usage).toBe(12)

    const burst = times(2020, 1688, 232) // 120ms 窗口：短窗口里的采集开销
    const second = computeCpuUsage(first.baseline, burst, first.value, 800)
    // 沿用上一次的值，而不是把这一格的「采集自身开销」当成 CPU 使用率报出去
    expect(second.value).toEqual(first.value)
    expect(second.baseline).toBe(slow)
  })

  test('首次采样：只记基线，不出数（避免开局一个假尖峰）', () => {
    const curr = times(1000, 500, 500)
    const { value, baseline } = computeCpuUsage(null, curr, null, 800)
    expect(value).toEqual({ usage: 0, perCore: [] })
    expect(baseline).toBe(curr)
  })

  test('核心数变化（热插拔）：沿用上次值并重建基线', () => {
    const last: CpuUsage = { usage: 30, perCore: [30, 30] }
    const prev = times(0, 0, 0, 2)
    const curr = times(1000, 500, 500, 4)
    const { value, baseline } = computeCpuUsage(prev, curr, last, 800)
    expect(value).toEqual(last)
    expect(baseline).toBe(curr)
  })

  test('计数器没走动：沿用上次值，但推进基线（避免窗口无限增长）', () => {
    const last: CpuUsage = { usage: 7, perCore: [7, 7] }
    const prev = times(0, 1000, 1000)
    const curr = times(1000, 1000, 1000)
    const { value, baseline } = computeCpuUsage(prev, curr, last, 800)
    expect(value).toEqual(last)
    expect(baseline).toBe(curr)
  })

  test('计数器回绕 / 复位不会给出 >100%', () => {
    const prev = times(0, 5000, 5000)
    const curr = times(1000, 100, 100) // 计数器归零
    const { value } = computeCpuUsage(prev, curr, null, 800)
    expect(value.usage).toBe(0)
    expect(value.perCore.every((v) => v >= 0 && v <= 100)).toBe(true)
  })
})

describe('cachedCollect（慢变指标的 30s 缓存）', () => {
  test('TTL 内命中缓存，过期后重采', async () => {
    let calls = 0
    const fn = async () => {
      calls += 1
      return calls
    }
    expect(await cachedCollect('test-ttl', 50, fn, 0)).toBe(1)
    expect(await cachedCollect('test-ttl', 50, fn, 0)).toBe(1)
    expect(calls).toBe(1)

    await new Promise((r) => setTimeout(r, 60))
    expect(await cachedCollect('test-ttl', 50, fn, 0)).toBe(2)
  })

  test('降级结果不入缓存：下一轮立刻重试', async () => {
    let calls = 0
    const boom = async (): Promise<number> => {
      calls += 1
      throw new Error('boom')
    }
    expect(await cachedCollect('test-fail', 10_000, boom, -1)).toBe(-1)
    expect(await cachedCollect('test-fail', 10_000, boom, -1)).toBe(-1)
    expect(calls).toBe(2)
  })
})
