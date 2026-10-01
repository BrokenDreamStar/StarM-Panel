/**
 * 内网可达性探测服务 —— 调度与缓存。
 *
 * 纯逻辑（地址白名单、TCP 探测）在 ./net-probe.ts，本文件只负责：
 *   - 定期对全部卡片的内网地址做探测
 *   - 维护 itemId → 探测结果 的缓存
 *   - 卡片增删改时的即时重探
 *
 * 为什么探测必须放在服务端（见 docs/DESIGN.md §6.4）：
 *   1. 面板若以 https 提供服务，浏览器会以混合内容为由阻断对 http 内网地址的请求
 *   2. 前端「先探测再打开」会引入延迟，window.open 在非用户手势调用栈中会被弹窗拦截
 *   3. 跨源探测内网设备必然被 CORS 拦住，而内网设备通常不返回 CORS 头
 */
import { asc, eq } from 'drizzle-orm'
import { db } from '../db'
import { items } from '../db/schema'
import type { ProbeEntry, ProbeStatus } from '@shared/types'
import { getSetting } from './settings'
import { probeTcp, resolveProbeTarget } from './net-probe'

/** 同时进行的探测上限，避免一次性打爆网络栈 */
const MAX_CONCURRENCY = 8

interface CacheEntry {
  reachable: boolean | null
  checkedAt: number
  reason?: ProbeEntry['reason']
}

class ProbeService {
  private cache = new Map<number, CacheEntry>()
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  getStatus(): ProbeStatus {
    const out: ProbeStatus = {}
    for (const [id, entry] of this.cache) {
      out[id] = {
        reachable: entry.reachable,
        checkedAt: entry.checkedAt,
        ...(entry.reason !== undefined && { reason: entry.reason }),
      }
    }
    return out
  }

  /** 探测任意一个地址，供卡片编辑器的「测试」按钮使用 */
  async checkUrl(rawUrl: string): Promise<ProbeEntry> {
    const target = await resolveProbeTarget(rawUrl)
    if (!target.allowed) {
      // reachable = null 表示「未实际探测」，前端应保守地按不可达处理
      return {
        reachable: null,
        checkedAt: Date.now(),
        reason: target.reason === 'bad-url' ? 'no-url' : 'blocked',
      }
    }
    const reachable = await probeTcp(
      target.host!,
      target.port!,
      getSetting('network.probeTimeout'),
    )
    return { reachable, checkedAt: Date.now() }
  }

  start(): void {
    this.reschedule()
    void this.refreshAll()
  }

  /** 设置变更后调用：重设周期并立即重探一次 */
  applySettings(): void {
    this.reschedule()
    void this.refreshAll()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private reschedule(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(
      () => void this.refreshAll(),
      getSetting('network.probeInterval'),
    )
  }

  /** 卡片增删改后调用：立即重探该卡片（查不到记录则顺手清理缓存） */
  async refreshOne(itemId: number): Promise<void> {
    const row = db.select().from(items).where(eq(items.id, itemId)).get()
    if (!row || !row.lanUrl || row.networkPref === 'wan') {
      this.cache.delete(itemId)
      return
    }
    await this.probeItem(itemId, row.lanUrl)
  }

  async refreshAll(): Promise<void> {
    if (this.running) return
    if (!getSetting('network.autoProbe')) return
    this.running = true

    try {
      const rows = db
        .select({ id: items.id, lanUrl: items.lanUrl, networkPref: items.networkPref })
        .from(items)
        .orderBy(asc(items.id))
        .all()

      const targets = rows.filter(
        (r): r is { id: number; lanUrl: string; networkPref: string } =>
          Boolean(r.lanUrl) && r.networkPref !== 'wan',
      )

      // 清理已删除或已移除内网地址的卡片缓存
      const liveIds = new Set(targets.map((t) => t.id))
      for (const id of [...this.cache.keys()]) {
        if (!liveIds.has(id)) this.cache.delete(id)
      }

      await this.runWithConcurrency(targets, MAX_CONCURRENCY, (t) =>
        this.probeItem(t.id, t.lanUrl),
      )
    } finally {
      this.running = false
    }
  }

  private async probeItem(itemId: number, lanUrl: string): Promise<void> {
    const target = await resolveProbeTarget(lanUrl)
    if (!target.allowed) {
      this.cache.set(itemId, {
        reachable: null,
        checkedAt: Date.now(),
        reason: target.reason === 'bad-url' ? 'no-url' : 'blocked',
      })
      return
    }

    const reachable = await probeTcp(
      target.host!,
      target.port!,
      getSetting('network.probeTimeout'),
    )
    this.cache.set(itemId, { reachable, checkedAt: Date.now() })
  }

  /** 带上限的并发执行，每条带少量抖动避免同刻齐发冲击网络 */
  private async runWithConcurrency<T>(
    list: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    let cursor = 0
    const workerCount = Math.min(limit, list.length)
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < list.length) {
        const item = list[cursor++]!
        await new Promise((r) => setTimeout(r, Math.random() * 200))
        try {
          await fn(item)
        } catch (err) {
          console.warn('[probe] 探测异常:', (err as Error)?.message ?? err)
        }
      }
    })
    await Promise.all(workers)
  }
}

export const probe = new ProbeService()
