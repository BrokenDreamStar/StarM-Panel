/**
 * 采集失败隔离 + 内存口径的单测。
 *
 * 重点覆盖「卡住」这种失败形态：`si.*` 在资源耗尽（如 fd 打满）时既不 resolve
 * 也不 reject，只靠 try/catch 拦不住，会让接口永久挂起 —— 线上实测过
 * `/api/system/info` 二十小时不返回，前端「关于」页 CPU / 内核全空。
 * 因此 safe() 必须把「超时」和「抛异常」同等降级为 fallback。
 */
import { describe, expect, test } from 'bun:test'
import { safe, usedMemory, withTimeout } from './system-info'

/** 永不 settle 的 Promise —— 模拟卡死的系统调用 */
const never = () => new Promise<never>(() => {})

describe('withTimeout', () => {
  test('按时返回则透传结果', async () => {
    expect(await withTimeout(async () => 42, 1000)).toBe(42)
  })

  test('超时抛错，而不是一直等底层调用', async () => {
    const t0 = Date.now()
    await expect(withTimeout(never, 20, 'probe')).rejects.toThrow('probe 超过 20ms 未返回')
    // 关键：超时后立刻返回，不能继续等那个永不 settle 的 Promise
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  test('底层抛异常时原样抛出', async () => {
    const boom = withTimeout(
      async () => {
        throw new Error('boom')
      },
      1000,
    )
    await expect(boom).rejects.toThrow('boom')
  })
})

describe('safe', () => {
  test('抛异常降级为 fallback', async () => {
    const value = await safe(
      async () => {
        throw new Error('boom')
      },
      'fallback',
    )
    expect(value).toBe('fallback')
  })

  test('卡死超时同样降级为 fallback', async () => {
    expect(await safe(never, -1, 20, 'probe')).toBe(-1)
  })

  test('正常返回时不走 fallback', async () => {
    expect(await safe(async () => 'ok', 'fallback', 20)).toBe('ok')
  })
})

/**
 * 内存口径 —— 用户报「面板 15.9/16.0 GB，活动监视器只有 12.4 GB」那次故障的直接产物。
 *
 * `si.mem().used` 在 Linux / macOS 上是「总量 − 完全空闲」，把可回收的 page cache
 * 也算成占用；活动监视器 / htop / 任务管理器用的都是「总量 − 可用」。
 */
describe('usedMemory', () => {
  const GB = 1024 ** 3

  test('macOS：按 total − available 算，不再把 inactive 算成已用', () => {
    // 实测（16 GB Mac）：si.used 15.6 GB（97.5%），available 4.27 GB，
    // 活动监视器「已使用内存」12.4 GB
    const m = { total: 16 * GB, free: 0.4 * GB, available: 4.27 * GB }
    expect(usedMemory(m)).toBeCloseTo(11.73 * GB, -6)
    expect(((usedMemory(m) / m.total) * 100).toFixed(0)).toBe('73')
  })

  test('Linux：4 GB 机器里 3.8 GB 是缓存时不再虚报 95%', () => {
    const m = { total: 4 * GB, free: 0.18 * GB, available: 1.85 * GB }
    expect(usedMemory(m)).toBeCloseTo(2.15 * GB, -6)
    expect(((usedMemory(m) / m.total) * 100).toFixed(0)).toBe('54')
  })

  test('available 缺失或为 0 时退回 total − free（不给出假的 0%）', () => {
    expect(usedMemory({ total: 8 * GB, free: 2 * GB, available: 0 })).toBeCloseTo(6 * GB, -6)
    expect(
      usedMemory({ total: 8 * GB, free: 2 * GB, available: Number.NaN }),
    ).toBeCloseTo(6 * GB, -6)
    // systeminformation 的 -1 哨兵值
    expect(usedMemory({ total: 8 * GB, free: 2 * GB, available: -1 })).toBeCloseTo(6 * GB, -6)
  })

  test('available ≥ total（异常平台）时按 free 兜底，且结果不为负', () => {
    expect(usedMemory({ total: 8 * GB, free: 1 * GB, available: 9 * GB })).toBeCloseTo(7 * GB, -6)
    expect(usedMemory({ total: 8 * GB, free: 9 * GB, available: 0 })).toBe(0)
    expect(usedMemory({ total: 0, free: 0, available: 0 })).toBe(0)
  })
})
