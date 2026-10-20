/**
 * 硬件监控服务 —— 进程级单例。
 *
 * 关键设计（见 docs/DESIGN.md §7.3）：
 *   - 主循环采集 CPU/内存/磁盘/网络；GPU 由**独立**的 3s 采样器负责，
 *     因为 si.graphics() 在 NVIDIA 平台会 spawn nvidia-smi 子进程。
 *   - 订阅者数量决定采样频率：无人观看时降频，而不是停止，
 *     这样用户切回页面能立刻拿到数据。
 *   - 数据只存内存环形缓冲，不落库（避免写放大与闪存磨损）。
 */
import type { GpuSnapshot, SystemSnapshot } from '@shared/types'
import {
  collectGpu,
  collectSnapshot,
  createCollectorState,
  readCpuTimes,
  setLastGpuMetrics,
  type CollectorState,
} from './system-info'

/** 环形缓冲长度：300 点 @3s ≈ 15 分钟趋势 */
const RING_SIZE = 300

/**
 * GPU 采样间隔（ms）—— **固定值，刻意不做成设置项**（见 DESIGN.md §7.3）。
 *
 * GPU 采集要 spawn `nvidia-smi` / `ioreg`，单次开销比 `si.*` 高一个量级，
 * 所以它不跟随可调的主循环（`monitor.interval` 最小可到 100ms）：主循环调快时
 * GPU 仍按 3s 采。而它可调的方向只有「更慢」和「把机器拖卡」两种，
 * 不值得给用户一个能把自己机器调卡的旋钮。
 */
const GPU_INTERVAL_MS = 3000

/**
 * 两轮采样之间的最小间隔（ms）。
 *
 * 自调度下「本轮耗时已超过间隔」会把下一轮排成立刻开始；给一个小下限，
 * 避免采集异常时变成无缝连跑（那等于没有采样间隔可言）。
 */
const MIN_SAMPLE_GAP_MS = 100

export interface MonitorConfig {
  /** 有订阅者时的采样间隔 */
  intervalMs: number
  /** 无订阅者时的采样间隔 */
  hiddenIntervalMs: number
}

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  intervalMs: 3000,
  hiddenIntervalMs: 10_000,
}

class MonitorService {
  private ring: SystemSnapshot[] = []
  private subscribers = new Set<(s: SystemSnapshot) => void>()

  private state: CollectorState = createCollectorState()
  /**
   * 主循环定时器。
   *
   * **刻意不用 `setInterval`**：一轮采集一旦慢于间隔（低功耗机器上 spawn
   * `df`/`ps` 完全可能跑到秒级），`setInterval` 会把积压的 tick 一连串补发，
   * 于是几毫秒内连做两轮采样 —— 而 CPU 使用率是「两次读数之间的平均」，
   * 这种补发会让窗口在 0.1s / 2s 之间来回跳，读数直接变成 8%↔60% 的方波。
   * 改成「本轮结束后再排下一轮」的自调度后，慢轮只会推迟下一轮，节奏恒定。
   */
  private mainTimer: ReturnType<typeof setTimeout> | null = null
  private gpuTimer: ReturnType<typeof setInterval> | null = null

  private gpus: GpuSnapshot[] = []
  private config: MonitorConfig = { ...DEFAULT_MONITOR_CONFIG }

  /** 防止采样耗时超过间隔导致叠加执行 */
  private sampling = false

  /** 慢轮告警节流：慢轮可能连着出现，不要每轮刷一行日志 */
  private lastSlowWarnAt = 0

  /**
   * 已停止。退出流程里 `stop()` 可能落在一轮采集**进行中**，
   * 那一轮结束时不能再把自己排回去（否则定时器会在进程关停后复活）。
   */
  private stopped = false

  /**
   * 同上，针对独立的 GPU 采样器。超时上限（3s）与 GPU 采样间隔（固定 3s，
   * 见 GPU_INTERVAL_MS）同量级，卡死的那一轮必须挡住后续 tick，否则会同时
   * 发起多个 collectGpu()。
   */
  private gpuSampling = false

  start(config: Partial<MonitorConfig> = {}): void {
    this.config = { ...DEFAULT_MONITOR_CONFIG, ...config }
    this.stopped = false

    // 先记下 CPU 计数器基线：第一轮要等足一个测量窗口（见下面的 reschedule），
    // 这样首帧就是真值，而不是「窗口为 0」时只能给出的 0%
    this.state.cpu = readCpuTimes()

    // 启动即采一次 GPU，拿到静态信息并确定可用指标（只更新状态，不打印启动日志）
    void collectGpu()
      .then((g) => {
        this.gpus = g.dynamic
        setLastGpuMetrics(g.allMetrics)
      })
      .catch((err) => console.warn('[monitor] GPU 初始化失败:', err?.message ?? err))

    // 首轮延后一个 CPU 测量窗口（0.8×间隔，默认 2.4s）再采：
    // 立刻采的话窗口为 0，CPU 只有一个假的 0%；而这段空窗期里
    // /api/system/snapshot 返回 503 NOT_READY，前端已按正常状态处理。
    this.reschedule(Math.round(this.config.intervalMs * 0.8))
  }

  stop(): void {
    this.stopped = true
    if (this.mainTimer) clearTimeout(this.mainTimer)
    if (this.gpuTimer) clearInterval(this.gpuTimer)
    this.mainTimer = null
    this.gpuTimer = null
  }

  /**
   * 设置变更后调用：重设主循环与 GPU 采样器的频率/开关。
   * （采样间隔、GPU 开关都来自 settings 表）
   */
  applySettings(next: Partial<MonitorConfig> = {}): void {
    this.config = { ...this.config, ...next }
    this.reschedule()
  }

  get subscriberCount(): number {
    return this.subscribers.size
  }

  latest(): SystemSnapshot | null {
    return this.ring.at(-1) ?? null
  }

  history(): SystemSnapshot[] {
    return this.ring
  }

  subscribe(fn: (s: SystemSnapshot) => void): () => void {
    this.subscribers.add(fn)
    this.reschedule()

    // 立即推送最新值，避免新连接出现空窗期
    const last = this.latest()
    if (last) fn(last)

    return () => {
      this.subscribers.delete(fn)
      this.reschedule()
    }
  }

  /**
   * 订阅者数量变化 / 设置变更后调用：重设主循环节奏与 GPU 采样器。
   * `delayMs` 默认按当前应有的间隔排下一轮；启动时传 0 表示立刻采一轮。
   */
  private reschedule(delayMs: number = this.targetInterval()): void {
    if (this.stopped) return
    this.schedule(delayMs)

    // GPU 采样器独立调度；无人观看时直接不跑（GPU 无历史价值，不必预热）
    if (this.gpuTimer) clearInterval(this.gpuTimer)
    this.gpuTimer = setInterval(() => void this.sampleGpu(), GPU_INTERVAL_MS)
  }

  /** 当前应有的采样间隔：有人观看用 intervalMs，没人观看降频 */
  private targetInterval(): number {
    return this.subscribers.size > 0 ? this.config.intervalMs : this.config.hiddenIntervalMs
  }

  /** 排下一轮采样（delayMs 后）—— 只保留一个定时器，重复调度以最后一次为准 */
  private schedule(delayMs: number): void {
    if (this.stopped) return
    if (this.mainTimer) clearTimeout(this.mainTimer)
    this.mainTimer = setTimeout(() => void this.runSample(), Math.max(0, delayMs))
  }

  /**
   * 跑一轮采样并按「固定节奏」排下一轮：间隔从本轮**结束**算起，
   * 慢轮因此只会推迟后续采样，而不会积压出补发的一轮。
   */
  private async runSample(): Promise<void> {
    const started = Date.now()
    await this.sample()
    const duration = Date.now() - started
    this.warnIfSlow(duration)
    this.schedule(Math.max(MIN_SAMPLE_GAP_MS, this.targetInterval() - duration))
  }

  /**
   * 单轮超过采样间隔就告警（60s 节流）。
   *
   * 这类问题不看日志极难发现：采样本身变慢并不会报错，只会让 CPU 使用率的
   * 测量窗口变短、读数虚高（线上出现过 8%↔60% 的方波，根因就是慢轮）。
   */
  private warnIfSlow(durationMs: number): void {
    const target = this.targetInterval()
    if (durationMs <= target) return
    const now = Date.now()
    if (now - this.lastSlowWarnAt < 60_000) return
    this.lastSlowWarnAt = now
    console.warn(
      `[monitor] 单轮采样耗时 ${durationMs}ms，已超过采样间隔 ${target}ms` +
        '（CPU 使用率会自动沿用上次值，但数据刷新会变慢，建议排查 spawn 类采集项）',
    )
  }

  private async sampleGpu(): Promise<void> {
    if (this.subscribers.size === 0) return
    if (this.gpuSampling) return
    this.gpuSampling = true
    try {
      const g = await collectGpu()
      this.gpus = g.dynamic
      setLastGpuMetrics(g.allMetrics)
    } catch (err) {
      console.warn('[monitor] GPU 采样失败:', (err as Error)?.message ?? err)
    } finally {
      this.gpuSampling = false
    }
  }

  private async sample(): Promise<void> {
    if (this.sampling) return
    this.sampling = true
    try {
      const { snapshot, next } = await collectSnapshot(this.state, this.gpus, {
        // CPU 使用率的窗口下限跟采样间隔走（0.8×）：窗口短于此值就沿用上次读数，
        // 避免把「采集自身那点开销」当成瞬时 CPU（见 system-info 的 computeCpuUsage）
        minCpuWindowMs: Math.round(this.config.intervalMs * 0.8),
      })
      this.state = next

      this.ring.push(snapshot)
      if (this.ring.length > RING_SIZE) this.ring.shift()

      for (const fn of this.subscribers) {
        try {
          fn(snapshot)
        } catch (err) {
          console.warn('[monitor] 订阅者回调异常:', err)
        }
      }
    } catch (err) {
      console.warn('[monitor] 采样失败:', (err as Error)?.message ?? err)
    } finally {
      this.sampling = false
    }
  }
}

export const monitor = new MonitorService()
