/**
 * 登录限流的单元测试。
 *
 * 时间全部注入（不 sleep），因此窗口与解锁的边界可以精确断言 ——
 * 「锁多久」「什么时候重新计数」这类问题靠真实等待测不准。
 */
import { describe, expect, test } from 'bun:test'
import { LoginRateLimiter } from './login-rate-limit'

const T0 = 1_700_000_000_000

function limiter(overrides = {}) {
  return new LoginRateLimiter({ maxFailures: 3, windowMs: 60_000, blockMs: 120_000, ...overrides })
}

describe('计数与锁定', () => {
  test('未失败过一律放行，remaining = 上限', () => {
    const rl = limiter()
    expect(rl.check('1.2.3.4', T0)).toEqual({ allowed: true, retryAfterSec: 0, remaining: 3 })
  })

  test('失败次数累积，remaining 递减', () => {
    const rl = limiter()
    expect(rl.fail('ip', T0).remaining).toBe(2)
    expect(rl.check('ip', T0).remaining).toBe(2)
    expect(rl.fail('ip', T0 + 1000).remaining).toBe(1)
    expect(rl.check('ip', T0 + 1000).allowed).toBe(true)
  })

  test('达到上限即锁定，且锁定期间不给机会', () => {
    const rl = limiter()
    for (let i = 0; i < 3; i++) rl.fail('ip', T0 + i)
    const decision = rl.check('ip', T0 + 10)
    expect(decision.allowed).toBe(false)
    expect(decision.remaining).toBe(0)
    expect(decision.retryAfterSec).toBe(120)
  })

  test('锁定期间「正确密码」也会被 check 拦下（由调用方统一拒绝）', () => {
    const rl = limiter()
    for (let i = 0; i < 3; i++) rl.fail('ip', T0)
    expect(rl.check('ip', T0 + 60_000).allowed).toBe(false)
  })

  test('锁定期满自动解锁，计数从零开始', () => {
    const rl = limiter()
    for (let i = 0; i < 3; i++) rl.fail('ip', T0)
    const after = rl.check('ip', T0 + 120_000)
    expect(after.allowed).toBe(true)
    expect(after.remaining).toBe(3)
  })

  test('重试等待秒数向上取整（不返回 0 秒）', () => {
    const rl = limiter()
    for (let i = 0; i < 3; i++) rl.fail('ip', T0)
    // 剩余 119.5 秒 → 120
    expect(rl.check('ip', T0 + 500).retryAfterSec).toBe(120)
  })

  test('窗口过期后计数作废（不会攒着几天前的失败）', () => {
    const rl = limiter()
    rl.fail('ip', T0)
    rl.fail('ip', T0 + 1000)
    expect(rl.check('ip', T0 + 60_001).remaining).toBe(3)
    // 过期之后再失败一次 = 新的第一次
    expect(rl.fail('ip', T0 + 60_002).remaining).toBe(2)
  })

  test('登录成功清空该 IP 的失败记录', () => {
    const rl = limiter()
    rl.fail('ip', T0)
    rl.fail('ip', T0 + 1)
    rl.succeed('ip')
    expect(rl.check('ip', T0 + 2).remaining).toBe(3)
  })

  test('不同 IP 互不影响', () => {
    const rl = limiter()
    for (let i = 0; i < 3; i++) rl.fail('a', T0)
    expect(rl.check('a', T0).allowed).toBe(false)
    expect(rl.check('b', T0).allowed).toBe(true)
  })
})

describe('内存控制', () => {
  test('条目数超过上限时清理，不会无限增长', () => {
    const rl = limiter({ maxEntries: 8 })
    for (let i = 0; i < 50; i++) rl.fail(`ip-${i}`, T0 + i * 1000)
    expect(rl.size()).toBeLessThanOrEqual(8)
  })
})
