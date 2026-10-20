/**
 * 监控 store —— 持有快照与图表历史，SSE 生命周期交给 useMonitorStream。
 *
 * 图表历史是本地环形数组（最近 `HISTORY_POINTS` 个点），刻意不依赖
 * GET /api/system/history：后者只有服务端 300 点缓冲，且重连后补齐
 * 反而会让折线跳变。60 点 ≈ 3 分钟（默认 3s 采样），足够看趋势。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/api/client'
import type { SystemSnapshot, SystemStaticInfo } from '@shared/types'

/** 前端图表窗口：最近 60 个采样点 */
export const HISTORY_POINTS = 60

export type MonitorStatus = 'idle' | 'connecting' | 'open' | 'retrying' | 'closed'

export interface TrendPoint {
  ts: number
  cpu: number
  mem: number
  netRx: number
  netTx: number
}

export const useMonitorStore = defineStore('monitor', () => {
  const latest = ref<SystemSnapshot | null>(null)
  const staticInfo = ref<SystemStaticInfo | null>(null)
  const status = ref<MonitorStatus>('idle')
  const error = ref<string | null>(null)
  const retryCount = ref(0)
  /** 最近一次成功收到快照的时间戳（用于判断数据是否新鲜） */
  const lastMessageAt = ref<number | null>(null)

  /** 图表历史（环形，最多 HISTORY_POINTS 个点） */
  const trend = ref<TrendPoint[]>([])

  /** 页面可见性 —— 隐藏时暂停图表重绘（SSE 保持连接） */
  const visible = ref(!document.hidden)

  const connected = computed(() => status.value === 'open')
  const hasData = computed(() => latest.value !== null)

  const trendCpu = computed(() => trend.value.map((p) => p.cpu))
  const trendMem = computed(() => trend.value.map((p) => p.mem))
  const trendRx = computed(() => trend.value.map((p) => p.netRx))
  const trendTx = computed(() => trend.value.map((p) => p.netTx))

  const memPercent = computed(() => {
    const m = latest.value?.mem
    if (!m || !m.total) return 0
    return (m.used / m.total) * 100
  })

  const swapPercent = computed(() => {
    const m = latest.value?.mem
    if (!m || !m.swapTotal) return 0
    return (m.swapUsed / m.swapTotal) * 100
  })

  /**
   * 接收一个新快照。
   * 隐藏时只更新最新值、不追加历史 —— 否则重新聚焦时折线会被压缩变形。
   */
  function pushSnapshot(snap: SystemSnapshot): void {
    latest.value = snap
    lastMessageAt.value = Date.now()

    if (!visible.value) return

    const point: TrendPoint = {
      ts: snap.ts,
      cpu: snap.cpu.usage,
      mem: snap.mem.total ? (snap.mem.used / snap.mem.total) * 100 : 0,
      netRx: snap.net.reduce((sum, n) => sum + n.rxBps, 0),
      netTx: snap.net.reduce((sum, n) => sum + n.txBps, 0),
    }
    const next = trend.value.length >= HISTORY_POINTS
      ? [...trend.value.slice(trend.value.length - HISTORY_POINTS + 1), point]
      : [...trend.value, point]
    trend.value = next
  }

  /** 页面重新可见：用一次 REST 快照补齐，避免等待下一个采样周期 */
  async function refresh(): Promise<void> {
    try {
      const snap = await api.system.snapshot()
      pushSnapshot(snap)
    } catch (e) {
      // 503（首次采样未完成）是正常状态，不记为错误。
      // 这里匹配的是**后端返回的报错原文**，不是界面文案 —— 所以刻意不进
      // @shared/text：抄一份进文案表反而会变成第三个真相。
      const message = e instanceof Error ? e.message : String(e)
      if (!message.includes('503') && !message.includes('尚未完成首次采样')) {
        error.value = message
      }
    }
  }

  async function loadStaticInfo(force = false): Promise<void> {
    if (staticInfo.value && !force) return
    try {
      staticInfo.value = await api.system.info()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  function resetTrend(): void {
    trend.value = []
  }

  /** 文件大小 / 速率格式化 —— 多个组件共用，放 store 便于复用 */
  return {
    latest,
    staticInfo,
    status,
    error,
    retryCount,
    lastMessageAt,
    trend,
    trendCpu,
    trendMem,
    trendRx,
    trendTx,
    visible,
    connected,
    hasData,
    memPercent,
    swapPercent,
    pushSnapshot,
    refresh,
    loadStaticInfo,
    resetTrend,
  }
})
