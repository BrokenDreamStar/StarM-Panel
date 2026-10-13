/**
 * 采集失败隔离的单测。
 *
 * 重点覆盖「卡住」这种失败形态：`si.*` 在资源耗尽（如 fd 打满）时既不 resolve
 * 也不 reject，只靠 try/catch 拦不住，会让接口永久挂起 —— 线上实测过
 * `/api/system/info` 二十小时不返回，前端「关于」页 CPU / 内核全空。
 * 因此 safe() 必须把「超时」和「抛异常」同等降级为 fallback。
 */
import { describe, expect, test } from 'bun:test'
import { safe, withTimeout } from './system-info'

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
