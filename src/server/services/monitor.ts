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
  setLastGpuMetrics,
  type CollectorState,
} from './system-info'

/** 环形缓冲长度：300 点 @1s ≈ 5 分钟趋势 */
const RING_SIZE = 300

/**
 * GPU 采样间隔（ms）—— **固定值，刻意不做成设置项**（见 DESIGN.md §7.3）。
 *
 * GPU 采集要 spawn `nvidia-smi` / `ioreg`，单次开销比 `si.*` 高一个量级，
 * 所以它不跟随 1s 主循环。而它可调的方向只有「更慢」和「把机器拖卡」两种，
 * 不值得给用户一个能把自己机器调卡的旋钮。
 */
const GPU_INTERVAL_MS = 3000

export interface MonitorConfig {
  /** 有订阅者时的采样间隔 */
  intervalMs: number
  /** 无订阅者时的采样间隔 */
  hiddenIntervalMs: number
}

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  intervalMs: 1000,
  hiddenIntervalMs: 10_000,
}

class MonitorService {
  private ring: SystemSnapshot[] = []
  private subscribers = new Set<(s: SystemSnapshot) => void>()

  private state: CollectorState = createCollectorState()
  private mainTimer: ReturnType<typeof setInterval> | null = null
  private gpuTimer: ReturnType<typeof setInterval> | null = null

  private gpus: GpuSnapshot[] = []
  private config: MonitorConfig = { ...DEFAULT_MONITOR_CONFIG }

  /** 防止采样耗时超过间隔导致叠加执行 */
  private sampling = false

  /**
   * 同上，针对独立的 GPU 采样器。超时上限（3s）与 GPU 采样间隔（固定 3s，
   * 见 GPU_INTERVAL_MS）同量级，卡死的那一轮必须挡住后续 tick，否则会同时
   * 发起多个 collectGpu()。
   */
  private gpuSampling = false

  start(config: Partial<MonitorConfig> = {}): void {
    this.config = { ...DEFAULT_MONITOR_CONFIG, ...config }

    // 启动即采一次 GPU，拿到静态信息并确定可用指标（只更新状态，不打印启动日志）
    void collectGpu()
      .then((g) => {
        this.gpus = g.dynamic
        setLastGpuMetrics(g.allMetrics)
      })
      .catch((err) => console.warn('[monitor] GPU 初始化失败:', err?.message ?? err))

    this.reschedule()
    void this.sample()
  }

  stop(): void {
    if (this.mainTimer) clearInterval(this.mainTimer)
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

  /** 订阅者数量变化时重设主循环频率 */
  private reschedule(): void {
    const target =
      this.subscribers.size > 0 ? this.config.intervalMs : this.config.hiddenIntervalMs

    if (this.mainTimer) clearInterval(this.mainTimer)
    this.mainTimer = setInterval(() => void this.sample(), target)

    // GPU 采样器独立调度；无人观看时直接不跑（GPU 无历史价值，不必预热）
    if (this.gpuTimer) clearInterval(this.gpuTimer)
    this.gpuTimer = setInterval(() => void this.sampleGpu(), GPU_INTERVAL_MS)
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
      const { snapshot, next } = await collectSnapshot(this.state, this.gpus)
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
