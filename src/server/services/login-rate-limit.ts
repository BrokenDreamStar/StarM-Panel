/**
 * 登录失败限流 —— 按客户端 IP 计数，超限后锁定一段时间。
 *
 * 为什么用固定窗口而不是令牌桶：这里的目的是「让在线爆破变得不可行」，
 * 而不是平滑流量。固定窗口实现简单、内存占用可预测、行为容易解释：
 * 15 分钟内错 5 次 → 锁 15 分钟，锁定期间即使密码正确也不放行
 * （否则爆破方只要持续发请求，总有一次撞上解锁瞬间的窗口）。
 *
 * 状态只存内存：进程重启即清零。攻击者无法让服务重启，所以这不构成绕过路径；
 * 反过来把它写进数据库只会带来无谓的写放大（见 ADR-006 的同类取舍）。
 */
export interface RateLimitDecision {
  /** 是否放行本次尝试 */
  allowed: boolean
  /** 被锁定时还需等待的秒数（0 = 未锁定） */
  retryAfterSec: number
  /** 锁定前还剩几次机会 */
  remaining: number
}

export interface LoginRateLimiterOptions {
  /** 窗口内允许的失败次数 */
  maxFailures?: number
  /** 计数窗口（毫秒） */
  windowMs?: number
  /** 触发上限后的锁定时长（毫秒） */
  blockMs?: number
  /** 内存上限：超过后清掉已过期条目，避免大量伪造 IP 撑爆内存 */
  maxEntries?: number
}

interface Entry {
  count: number
  windowStart: number
  blockedUntil: number
}

export class LoginRateLimiter {
  private readonly entries = new Map<string, Entry>()
  private readonly maxFailures: number
  private readonly windowMs: number
  private readonly blockMs: number
  private readonly maxEntries: number

  constructor(opts: LoginRateLimiterOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 5
    this.windowMs = opts.windowMs ?? 15 * 60 * 1000
    this.blockMs = opts.blockMs ?? 15 * 60 * 1000
    this.maxEntries = opts.maxEntries ?? 4096
  }

  /** 只读检查：当前是否被锁定 */
  check(key: string, now: number = Date.now()): RateLimitDecision {
    const entry = this.entries.get(key)
    if (!entry) return { allowed: true, retryAfterSec: 0, remaining: this.maxFailures }

    if (entry.blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSec: Math.ceil((entry.blockedUntil - now) / 1000),
        remaining: 0,
      }
    }

    if (now - entry.windowStart > this.windowMs) {
      // 窗口已过期，计数作废（下次失败从 0 重新计）
      return { allowed: true, retryAfterSec: 0, remaining: this.maxFailures }
    }

    return {
      allowed: true,
      retryAfterSec: 0,
      remaining: Math.max(0, this.maxFailures - entry.count),
    }
  }

  /** 记录一次失败，返回记录之后的状态 */
  fail(key: string, now: number = Date.now()): RateLimitDecision {
    const entry = this.entries.get(key)
    const expired = entry !== undefined && now - entry.windowStart > this.windowMs

    const next: Entry =
      entry === undefined || expired
        ? { count: 1, windowStart: now, blockedUntil: 0 }
        : { ...entry, count: entry.count + 1 }

    if (next.count >= this.maxFailures) {
      next.blockedUntil = now + this.blockMs
    }

    this.entries.set(key, next)
    this.prune(now)
    return this.check(key, now)
  }

  /** 登录成功：清掉该 IP 的失败记录 */
  succeed(key: string): void {
    this.entries.delete(key)
  }

  /** 仅供测试 / 自检 */
  size(): number {
    return this.entries.size
  }

  /** 清掉已完全过期的条目；条目数超上限时连窗口内的记录也一起清（宁松勿爆内存） */
  private prune(now: number): void {
    if (this.entries.size <= this.maxEntries) return
    for (const [key, entry] of this.entries) {
      const done = entry.blockedUntil <= now && now - entry.windowStart > this.windowMs
      if (done) this.entries.delete(key)
    }
    if (this.entries.size > this.maxEntries) this.entries.clear()
  }
}
