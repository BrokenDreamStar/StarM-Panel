/**
 * 系统信息采集
 *
 * 依赖 systeminformation（纯 JS，跨平台）。
 * 设计原则：**字段级失败隔离** —— 任何单项采集失败只让该字段降级，
 * 绝不中断整轮采集，也不把异常抛给调用方。
 */
import os from 'node:os'
import { statSync } from 'node:fs'
import si from 'systeminformation'
import type {
  DisplayInfo,
  GpuMetric,
  GpuSnapshot,
  GpuStaticInfo,
  SystemSnapshot,
  SystemStaticInfo,
} from '@shared/types'
import {
  lookupDiskCounters,
  readDiskCounters,
  type DiskCounters,
} from './diskstats'
import { readMacGpuStats, type MacGpuStat } from './gpu-macos'

/** systeminformation 在指标不可用时返回负数哨兵值（通常是 -1） */
function validNumber(v: unknown): number | null {
  if (typeof v !== 'number') return null
  if (!Number.isFinite(v)) return null
  if (v < 0) return null
  return v
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

/**
 * 内存「已用」的统一定义：**总量 − 可用量**（= 活动监视器的「已使用内存」/
 * htop 的 used / 任务管理器的「使用中」）。
 *
 * `si.mem().used` **不能直接用**：它在 Linux 与 macOS 上算的是「总量 − 完全空闲」，
 * 把内核随时能回收的 page cache（Linux 的 buff/cache、macOS 的 inactive）也算成占用：
 *
 *   - macOS 实测：si 报 15.6/16.0 GB（97.5%，红条），活动监视器「已使用内存」12.4 GB；
 *   - Debian 实测：4 GB 机器上 si 报 3.8 GB 已用（95%），实际 available 还有 1.85 GB。
 *
 * 平台的 `available` 语义正好对齐：
 *   - Linux = `MemAvailable`（含可回收的 buff/cache）；
 *   - macOS = 空闲 + inactive（`si.mem().active` 就是活动监视器那个「已使用」，与
 *     total − available 等价）；
 *   - Windows = `os.freemem()`（`ullAvailPhys`，已含 standby），与原来的 used 一致。
 *
 * 取不到合理的 available 时退回「总量 − 空闲」，宁可延续旧行为也不给出 0。
 * 导出仅供单测使用。
 */
export function usedMemory(m: { total: number; free: number; available: number }): number {
  const total = validNumber(m.total) ?? 0
  if (total <= 0) return 0

  const available = validNumber(m.available)
  if (available !== null && available > 0 && available < total) return total - available

  return Math.max(0, total - (validNumber(m.free) ?? 0))
}

/**
 * 采集超时预算（毫秒）。
 *
 * 「采集失败」不止是抛异常：系统调用卡死时 `si.*` 会一直 pending，既不 resolve
 * 也不 reject，只靠 try/catch 拦不住，会让整个接口永久挂起 —— 实测进程 fd 打满后
 * `/api/system/info` 数十秒不返回，前端「关于」页的 CPU / 内核整块变成「—」。
 * 因此超时与异常同等对待，一律降级为 fallback（字段级失败隔离）。
 *
 *   - 静态信息：按需触发（一个请求采一次），可以等久一点；
 *   - 高频采样：主循环（默认 3s）/ GPU 采样器（3s），等太久会拖住后续整轮采样，必须尽早放弃。
 *
 * 做成可变对象是为了让单测能调得很小（否则一个用例要等 10 秒）。
 */
export const COLLECTOR_TIMEOUTS = {
  static: 10_000,
  sample: 3_000,
}

/** 采集超时 —— 语义上与「该项不可用」等价 */
class CollectorTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} 超过 ${ms}ms 未返回`)
    this.name = 'CollectorTimeoutError'
  }
}

/**
 * 给采集函数套一层超时。
 *
 * 注意：超时只是**放弃等待**，并不会中断底层调用（JS 无法取消已 spawn 的子进程 /
 * 已发出的系统调用）。调用方靠「同一轮采样不叠加执行」的守卫避免无限堆积，
 * 见 monitor.ts 的 `sampling` / `gpuSampling`。
 * 另：`readMacGpuStats()` 用的是同步 `Bun.spawnSync`，卡死时会占住事件循环，
 * 连超时定时器都无法触发 —— 同步调用不受本函数保护。
 *
 * 导出仅供单测使用。
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  label = '采集',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CollectorTimeoutError(label, ms)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 逐项独立捕获失败，任何一项挂掉都不影响其它项。
 * 「挂掉」既包括抛异常，也包括超时（见 withTimeout）。
 * `onFailure` 用于让调用方知道本轮出现过降级（例如据此决定结果能不能进缓存）。
 * 导出仅供单测使用。
 */
export async function safe<T>(
  fn: () => Promise<T>,
  fallback: T,
  timeoutMs = COLLECTOR_TIMEOUTS.sample,
  label = '采集',
  onFailure?: () => void,
): Promise<T> {
  try {
    return await withTimeout(fn, timeoutMs, label)
  } catch (err) {
    console.warn('[system-info] 采集失败:', (err as Error)?.message ?? err)
    onFailure?.()
    return fallback
  }
}

/**
 * 慢变指标的刷新周期（ms）—— 落实 docs/DESIGN.md §7.1 的「30s」一列。
 *
 * `si.fsSize()`（内部 spawn `mount` + `df`）、`si.processes()`（spawn `ps`，再
 * 对每个 pid `cat /proc/<pid>/stat`）、`si.users()`（spawn `who`）都是**进程级**
 * 开销，而它们给出的容量 / 进程数 / 登录用户本来就是按分钟变化的量。
 *
 * 曾经这三项跟着 1s 主循环跑，单轮要 fork 六七个进程；在内存吃紧的 2 核机器上
 * （实测 Debian + 95% 内存 + 2GB swap），一轮采样被拖到 ~1.9s，直接把下面
 * 「CPU 使用率的测量窗口」压到 0.1s 量级 —— 于是 CPU 卡片在 8% / 60% 之间
 * 来回跳，而内存、磁盘、网络这些**电平量**纹丝不动（它们不依赖窗口长度）。
 */
const SLOW_METRIC_TTL_MS = 30_000

/** 慢变指标的上一次成功采集结果 */
const slowMetrics = new Map<string, { at: number; value: unknown }>()

/**
 * 带 TTL 的采集：命中缓存直接返回，过期才真正采。
 *
 * 降级结果（超时 / 抛异常）**不进缓存** —— 否则一次卡顿会让「进程数 / 磁盘容量」
 * 整整 30s 都是空值，和 `getStaticInfo()` 里那条「失败不入缓存」是同一个理由。
 * 导出仅供单测使用。
 */
export async function cachedCollect<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  const hit = slowMetrics.get(key) as { at: number; value: T } | undefined
  if (hit && Date.now() - hit.at < ttlMs) return hit.value

  let failed = false
  const value = await safe(fn, fallback, COLLECTOR_TIMEOUTS.sample, key, () => {
    failed = true
  })
  if (!failed) slowMetrics.set(key, { at: Date.now(), value })
  return value
}

// ─────────────────────────────────────────────────────────────
// GPU 映射
// ─────────────────────────────────────────────────────────────

function normalizeGpuVendor(vendor: unknown, model: unknown): string {
  const s = `${vendor ?? ''} ${model ?? ''}`.toLowerCase()
  if (s.includes('nvidia')) return 'nvidia'
  if (s.includes('amd') || s.includes('ati') || s.includes('radeon')) return 'amd'
  if (s.includes('apple')) return 'apple'
  if (s.includes('intel')) return 'intel'
  if (s.includes('broadcom') || s.includes('videocore')) return 'broadcom'
  if (s.includes('virtio') || s.includes('vmware') || s.includes('virtualbox')) return 'virtual'
  return 'unknown'
}

/**
 * 推导该 GPU 上「真实可用」的指标名。
 * 前端据此只渲染存在的控件，避免出现一排 N/A
 * （各厂商暴露的指标差异极大，见 docs/DESIGN.md §7.3）。
 *
 * `mac` 是 macOS 专用补充源（IORegistry 的 PerformanceStatistics，见 gpu-macos.ts）——
 * systeminformation 在 macOS 上不提供任何动态字段，不补的话 GPU 卡片只剩型号。
 */
function deriveGpuMetrics(c: Record<string, unknown>, mac: MacGpuStat | null): GpuMetric[] {
  const out: GpuMetric[] = []
  const has = (key: string) => validNumber(c[key]) !== null
  const hasNum = (v: number | null | undefined) => typeof v === 'number' && Number.isFinite(v)

  if (has('utilizationGpu') || hasNum(mac?.utilization)) out.push('utilization')
  if (
    has('memoryUsed') ||
    has('memoryTotal') ||
    has('vram') ||
    hasNum(mac?.memoryUsed) ||
    hasNum(mac?.memoryTotal)
  ) {
    out.push('memory')
  }
  if (has('temperatureGpu')) out.push('temperature')
  if (has('powerDraw')) out.push('power')
  if (has('fanSpeed')) out.push('fan')
  if (has('clockCore') || has('clockMemory')) out.push('clock')
  return out
}

function asRecords(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : []
}

// ─────────────────────────────────────────────────────────────
// 磁盘与网卡的归一化
//
// systeminformation 返回的是「原始」视图，直接展示会有两个明显的误导：
//
//  1. macOS：`/` 是只读系统卷（可能只有十几 GB），用户数据实际在
//     `/System/Volumes/Data`。直接列 `/` 会严重低估磁盘占用。
//     这里把 Data 卷重标为 `/`，并丢弃其余 APFS 辅助卷。
//  2. Linux：tmpfs / overlay / squashfs 等伪文件系统不是真实存储。
//
// 网卡同理：macOS 会返回 awdl0 / utun* / bridge0 / anpi* 等十几个
// 虚拟接口，绝大多数没有 IP 也没有流量。只保留有 IP 地址的接口。
// ─────────────────────────────────────────────────────────────

const LINUX_PSEUDO_FSTYPES = new Set([
  'tmpfs',
  'devtmpfs',
  'overlay',
  'squashfs',
  'autofs',
  'nsfs',
  'ramfs',
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'devpts',
  'fusectl',
  'tracefs',
  'securityfs',
  'debugfs',
  'configfs',
  'binfmt_misc',
  'efivarfs',
])

interface RawDisk {
  fs: string
  mount: string
  type: string
  size: number
  used: number
}

/**
 * stat 结果缓存 —— 同一轮采样里避免对同一路径重复系统调用。
 * 超过上限直接清空，避免长期运行后无限增长。
 */
const mountStatCache = new Map<string, boolean>()

/**
 * 真实磁盘一定挂在**目录**上。
 *
 * 容器里把单个文件 bind mount 进来时（Docker 必挂的 /etc/hosts、/etc/hostname，
 * 以及被挂进容器的二进制自身），si.fsSize() 会把它们当成"分区"列出来，纯属噪音。
 * 实测在 Docker 中运行会多出 `/app/starm-panel`、`/etc/hosts` 两条。
 */
function isMountPointDirectory(path: string): boolean {
  const cached = mountStatCache.get(path)
  if (cached !== undefined) return cached

  let ok: boolean
  try {
    ok = statSync(path).isDirectory()
  } catch {
    // 无权限或路径已消失 —— 宁可不显示，也不显示一个假分区
    ok = false
  }

  if (mountStatCache.size > 512) mountStatCache.clear()
  mountStatCache.set(path, ok)
  return ok
}

/**
 * 把 si.fsSize() 的原始记录归一化成用户真正关心的挂载点列表。
 * 静态信息与动态快照必须使用同一套规则，否则两端对不上。
 */
function normalizeDisks(records: Record<string, unknown>[]): RawDisk[] {
  const out: RawDisk[] = []
  const seenMounts = new Set<string>()
  let hasDarwinDataVolume = false

  // macOS 优先处理 Data 卷，让它占据 `/` 这个展示位
  if (process.platform === 'darwin') {
    hasDarwinDataVolume = records.some((d) => d['mount'] === '/System/Volumes/Data')
  }

  for (const d of records) {
    const fs = (d['fs'] as string) ?? ''
    const rawMount = (d['mount'] as string) ?? ''
    const type = (d['type'] as string) ?? ''
    const size = validNumber(d['size']) ?? 0
    const used = validNumber(d['used']) ?? 0

    if (!rawMount) continue

    let mount = rawMount

    if (process.platform === 'darwin') {
      if (rawMount === '/System/Volumes/Data') {
        // 用户数据真正所在，重标为 / 以符合用户在「磁盘工具」里的认知
        mount = '/'
      } else if (rawMount.startsWith('/System/Volumes/')) {
        continue // Preboot / VM / Update / xarts / iSCPreboot / Hardware
      } else if (rawMount === '/Volumes/Recovery') {
        continue
      } else if (rawMount === '/' && hasDarwinDataVolume) {
        continue // 已被 Data 卷取代
      }
    } else if (process.platform === 'linux') {
      if (LINUX_PSEUDO_FSTYPES.has(type)) continue
      // snap / docker overlay 等挂载点噪音较大，但不是伪文件系统，保留
    }

    // 用原始 mount 路径做 stat：重标过的 mount（macOS 的 `/`）在磁盘上未必存在
    if (!isMountPointDirectory(rawMount)) continue

    if (seenMounts.has(mount)) continue
    seenMounts.add(mount)

    out.push({ fs, mount, type, size, used })
  }

  return out
}

/** 只保留有 IP 地址的网卡 —— 过滤掉 macOS 的一堆虚拟接口 */
function normalizeNetInterfaces(
  records: Record<string, unknown>[],
): Record<string, unknown>[] {
  return records.filter((n) => {
    if (n['internal']) return false
    const ip4 = (n['ip4'] as string) ?? ''
    const ip6 = (n['ip6'] as string) ?? ''
    // 回环与链路本地地址不算
    const realIp4 = ip4 && ip4 !== '127.0.0.1'
    const realIp6 = ip6 && !ip6.startsWith('fe80') && ip6 !== '::1'
    return Boolean(realIp4 || realIp6)
  })
}

function mapGpuStatic(controllers: Record<string, unknown>[]): GpuStaticInfo[] {
  return controllers.map((c, index) => ({
    index,
    vendor: normalizeGpuVendor(c['vendor'], c['model']),
    model: (c['model'] as string) || (c['name'] as string) || '未知 GPU',
    vram: validNumber(c['vram']),
    vramDynamic: Boolean(c['vramDynamic']),
    driverVersion: (c['driverVersion'] as string) || null,
    bus: (c['bus'] as string) || (c['pciBus'] as string) || null,
  }))
}

/** 把 ioreg 采到的 GPU 与 si.graphics() 的控制器对齐：先按型号匹配，再退回下标 */
function pickMacGpuStat(
  macStats: readonly MacGpuStat[],
  model: string,
  index: number,
): MacGpuStat | null {
  const target = model.toLowerCase()
  const matched = macStats.find((s) => {
    const m = s.model?.toLowerCase()
    return m ? m === target || target.includes(m) || m.includes(target) : false
  })
  return matched ?? macStats[index] ?? null
}

function mapGpuDynamic(
  controllers: Record<string, unknown>[],
  macStats: readonly MacGpuStat[] = [],
): GpuSnapshot[] {
  return controllers.map((c, index) => {
    const model = (c['model'] as string) || (c['name'] as string) || '未知 GPU'
    const mac = pickMacGpuStat(macStats, model, index)

    const memoryTotal =
      validNumber(c['memoryTotal']) ?? validNumber(c['vram']) ?? mac?.memoryTotal ?? null
    const memoryUsed = validNumber(c['memoryUsed']) ?? mac?.memoryUsed ?? null
    const memoryUtilization =
      memoryUsed !== null && memoryTotal !== null && memoryTotal > 0
        ? round1((memoryUsed / memoryTotal) * 100)
        : null

    return {
      index,
      vendor: normalizeGpuVendor(c['vendor'], c['model']),
      model,
      utilization: validNumber(c['utilizationGpu']) ?? mac?.utilization ?? null,
      memoryUsed,
      memoryTotal,
      memoryUtilization,
      temperature: validNumber(c['temperatureGpu']),
      powerDraw: validNumber(c['powerDraw']),
      powerLimit: validNumber(c['powerLimit']),
      fanSpeed: validNumber(c['fanSpeed']),
      clockCore: validNumber(c['clockCore']),
      clockMemory: validNumber(c['clockMemory']),
      available: deriveGpuMetrics(c, mac),
    }
  })
}

function mapDisplays(displays: Record<string, unknown>[]): DisplayInfo[] {
  return displays.map((d) => ({
    vendor: (d['vendor'] as string) || null,
    model: (d['model'] as string) || (d['name'] as string) || '未知显示器',
    resolutionX: validNumber(d['currentResX']) ?? validNumber(d['resolutionX']) ?? 0,
    resolutionY: validNumber(d['currentResY']) ?? validNumber(d['resolutionY']) ?? 0,
    refreshRate: validNumber(d['currentRefreshRate']) ?? validNumber(d['refreshRate']),
    connection: (d['connection'] as string) || null,
    main: Boolean(d['main']),
  }))
}

/**
 * 采集 GPU 静态信息 + 动态指标（同一次 si.graphics() 调用，不重复开销）。
 * 供 GpuSampler 使用。
 */
export async function collectGpu(): Promise<{
  static: GpuStaticInfo[]
  dynamic: GpuSnapshot[]
  displays: DisplayInfo[]
  /** 全部 GPU 的可用指标并集 */
  allMetrics: GpuMetric[]
}> {
  const graphics = await safe(
    () => si.graphics(),
    { controllers: [], displays: [] } as Awaited<ReturnType<typeof si.graphics>>,
    COLLECTOR_TIMEOUTS.sample,
    'graphics',
  )

  const controllers = asRecords(graphics.controllers)
  const dynamic = mapGpuDynamic(controllers, readMacGpuStats())
  const allMetrics = [...new Set(dynamic.flatMap((g) => g.available))]

  return {
    static: mapGpuStatic(controllers),
    dynamic,
    displays: mapDisplays(asRecords(graphics.displays)),
    allMetrics,
  }
}

// ─────────────────────────────────────────────────────────────
// 静态信息 —— 启动时采集一次并缓存
// ─────────────────────────────────────────────────────────────

let staticCache: { at: number; value: SystemStaticInfo } | null = null
const STATIC_TTL_MS = 300_000
/** 上一次 GPU 动态采样结果，供 capabilities 判定 */
let lastGpuMetrics: GpuMetric[] = []
/** 启动时探测 /proc/diskstats 是否可用 */
let disksIoAvailable: boolean | null = null

export function setLastGpuMetrics(metrics: GpuMetric[]): void {
  lastGpuMetrics = metrics
}

export async function getStaticInfo(force = false): Promise<SystemStaticInfo> {
  if (!force && staticCache && Date.now() - staticCache.at < STATIC_TTL_MS) {
    return staticCache.value
  }

  // 采集是否出现过异常 / 超时。降级后的结果**不入缓存**：否则一次资源耗尽
  // （实测过 bun --watch 泄漏 fd 把进程打满）会让静态信息里的设备清单
  // （disks / net / gpus）整整 5 分钟都是空的 —— 首页只剩 CPU / RAM / SYS
  // 三张卡，且「添加卡片」没有任何设备候选。不入缓存则下次请求立刻重试。
  let failures = 0

  // 静态信息按需采集，统一给长超时（label 用于日志定位是哪一项卡住）
  const collect = <T>(label: string, fn: () => Promise<T>, fallback: T) =>
    safe(fn, fallback, COLLECTOR_TIMEOUTS.static, label, () => {
      failures += 1
    })

  const [cpu, cpuSpeed, osInfo, graphics, fsSize, netIfaces, temp, diskCounters] =
    await Promise.all([
      collect('cpu', () => si.cpu(), {} as Awaited<ReturnType<typeof si.cpu>>),
      collect('cpuCurrentSpeed', () => si.cpuCurrentSpeed(), {} as Awaited<
        ReturnType<typeof si.cpuCurrentSpeed>
      >),
      collect('osInfo', () => si.osInfo(), {} as Awaited<ReturnType<typeof si.osInfo>>),
      collect(
        'graphics',
        () => si.graphics(),
        { controllers: [], displays: [] } as Awaited<ReturnType<typeof si.graphics>>,
      ),
      collect('fsSize', () => si.fsSize(), [] as Awaited<ReturnType<typeof si.fsSize>>),
      collect('networkInterfaces', () => si.networkInterfaces(), [] as Awaited<
        ReturnType<typeof si.networkInterfaces>
      >),
      collect('cpuTemperature', () => si.cpuTemperature(), { main: -1 } as Awaited<
        ReturnType<typeof si.cpuTemperature>
      >),
      readDiskCounters(),
    ])

  const controllers = asRecords(graphics.controllers)
  const gpuDynamic = mapGpuDynamic(controllers, readMacGpuStats())
  if (gpuDynamic.length > 0) {
    lastGpuMetrics = [...new Set(gpuDynamic.flatMap((g) => g.available))]
  }
  disksIoAvailable = diskCounters.size > 0

  const value: SystemStaticInfo = {
    cpu: {
      manufacturer: cpu.manufacturer ?? '',
      brand: cpu.brand ?? '',
      cores: cpu.cores ?? 0,
      physicalCores: cpu.physicalCores ?? 0,
      // 优先用实时频率，回退到标称频率
      speed: validNumber(cpuSpeed.avg) ?? cpu.speed ?? 0,
    },
    os: {
      platform: osInfo.platform ?? process.platform,
      distro: osInfo.distro ?? '',
      release: osInfo.release ?? '',
      kernel: osInfo.kernel ?? '',
      arch: osInfo.arch ?? process.arch,
      hostname: osInfo.hostname ?? os.hostname(),
    },
    disks: normalizeDisks(asRecords(fsSize)).map((d) => ({
      fs: d.fs,
      mount: d.mount,
      type: d.type,
      size: d.size,
    })),
    net: normalizeNetInterfaces(asRecords(netIfaces)).map((n) => ({
      iface: (n['iface'] as string) ?? '',
      ifaceName: (n['ifaceName'] as string) ?? '',
      ip4: (n['ip4'] as string) ?? '',
      mac: (n['mac'] as string) ?? '',
      speed: validNumber(n['speed']),
    })),
    gpus: mapGpuStatic(controllers),
    displays: mapDisplays(asRecords(graphics.displays)),
    capabilities: {
      cpuTemp: validNumber(temp.main) !== null,
      gpuDynamic: lastGpuMetrics.length > 0,
      disksIo: disksIoAvailable,
      netStats: true,
    },
  }

  if (failures === 0) staticCache = { at: Date.now(), value }
  return value
}

// ─────────────────────────────────────────────────────────────
// CPU 使用率：自己维护测量窗口
//
// 为什么不用 `si.currentLoad()`（见 docs/DESIGN.md §7.3「CPU 使用率的测量窗口」）：
//
//   1. 它返回的是**距离上一次调用**的平均使用率，窗口长度完全由调用节奏决定。
//      采样轮次一旦抖动（实测慢轮 1.9s、紧跟的补发轮 0.12s），同一台空闲机器就会
//      读出一串「8% / 60%」交替的方波 —— 60% 那一格量的其实是这一轮采集自己的开销。
//   2. 它在 Linux 上每次都要 `execSync('cat /proc/stat | grep cpu')`，
//      一轮多出 3 个进程，还**同步阻塞事件循环**。
//
// `os.cpus()` 每次调用都直接读 /proc/stat（Linux）或 host_processor_info（macOS），
// 零 fork；累计 tick 由我们自己差分，于是「度量窗口」与「采样节奏」解耦：
// 窗口不足 `minWindowMs` 就沿用上一次的值，且**不推进基线**，让下一轮把这段
// 窗口补回来。
// ─────────────────────────────────────────────────────────────

/** CPU 累计计数器的一次读数 */
export interface CpuTimes {
  /** 读计数器的时刻（ms）—— 窗口按「读的时刻」算，与单轮采集耗时无关 */
  at: number
  perCore: Array<{ idle: number; total: number }>
}

export interface CpuUsage {
  /** 全部核心合计使用率 0-100 */
  usage: number
  /** 每核心使用率 0-100 */
  perCore: number[]
}

/** 默认最小测量窗口：调用方未显式传入时（单测等）的兜底，防止慢轮把窗口压到 0.1s 量级 */
export const DEFAULT_MIN_CPU_WINDOW_MS = 800

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(100, Math.max(0, v))
}

/** 读取一次 CPU 累计 tick（user/nice/sys/irq/idle 之和） */
export function readCpuTimes(at: number = Date.now()): CpuTimes {
  const cpus = os.cpus()
  return {
    at,
    perCore: cpus.map((c) => {
      const t = c.times as Partial<typeof c.times>
      const idle = t.idle ?? 0
      return {
        idle,
        total: idle + (t.user ?? 0) + (t.nice ?? 0) + (t.sys ?? 0) + (t.irq ?? 0),
      }
    }),
  }
}

/**
 * 由累计计数器的两次读数算出使用率。
 *
 * - 首次采样、核心数变化（CPU 热插拔）：只记基线，本轮沿用上次的值；
 * - 窗口 < `minWindowMs`：**不动基线**、沿用上次的值 —— 短窗口里那点数据不是
 *   丢弃，而是并进下一轮的窗口里；
 * - 计数器没走动（窗口内没有 tick）：沿用上次的值，但推进基线，避免窗口无限增长。
 *
 * 导出仅供单测使用。
 */
export function computeCpuUsage(
  prev: CpuTimes | null,
  curr: CpuTimes,
  last: CpuUsage | null,
  minWindowMs: number = DEFAULT_MIN_CPU_WINDOW_MS,
): { value: CpuUsage; baseline: CpuTimes } {
  const carried: CpuUsage = last ?? { usage: 0, perCore: [] }
  const keep = { value: carried, baseline: prev ?? curr }

  if (!prev || prev.perCore.length !== curr.perCore.length) {
    // 没有基线（冷启动 / 刚重启），或核心数变了：新一轮基线从此刻算起
    return { value: carried, baseline: curr }
  }
  if (curr.at - prev.at < minWindowMs) return keep

  let sumIdle = 0
  let sumTotal = 0
  const perCore: number[] = []
  for (let i = 0; i < curr.perCore.length; i++) {
    const dIdle = curr.perCore[i]!.idle - prev.perCore[i]!.idle
    const dTotal = curr.perCore[i]!.total - prev.perCore[i]!.total
    // 计数器回绕 / 复位时差值为负，按 0 处理，宁可低估也不给出 >100%
    sumIdle += Math.max(0, dIdle)
    sumTotal += Math.max(0, dTotal)
    const load = dTotal > 0 ? (1 - dIdle / dTotal) * 100 : null
    perCore.push(load === null ? (carried.perCore[i] ?? 0) : round1(clampPct(load)))
  }

  if (sumTotal <= 0) return { value: carried, baseline: curr }

  return {
    value: { usage: round1(clampPct((1 - sumIdle / sumTotal) * 100)), perCore },
    baseline: curr,
  }
}

// ─────────────────────────────────────────────────────────────
// 动态快照
// ─────────────────────────────────────────────────────────────

export interface CollectorState {
  at: number
  net: Map<string, { rx: number; tx: number }>
  disk: Map<string, DiskCounters>
  /** 上一轮的 CPU 计数器基线（见 computeCpuUsage） */
  cpu: CpuTimes | null
  /** 上一轮报出去的 CPU 使用率，窗口过短时沿用它 */
  cpuUsage: CpuUsage | null
}

export function createCollectorState(): CollectorState {
  return { at: 0, net: new Map(), disk: new Map(), cpu: null, cpuUsage: null }
}

export interface CollectSnapshotOptions {
  /**
   * CPU 使用率的最小测量窗口（ms）。调用方按采样间隔给（通常 0.8 × 间隔），
   * 这样窗口永远不会短于「一轮本来就该有的间隔」。
   */
  minCpuWindowMs?: number
}

/**
 * 采集一次动态快照。
 *
 * 注意：本函数**不调用 si.graphics()**。GPU 由独立的 GpuSampler 以更低频率
 * 采集（见 docs/DESIGN.md §7.3），避免每轮主循环都 spawn nvidia-smi 子进程。
 * GPU 数据由调用方通过 gpus 参数注入。
 *
 * 三项慢变指标（磁盘容量 / 进程数 / 用户数）按 `SLOW_METRIC_TTL_MS` 缓存，
 * CPU 使用率用自己维护的窗口差分 —— 两者都是为了不让「采集本身的开销」
 * 污染「采到的数」，详见各段注释。
 */
export async function collectSnapshot(
  prev: CollectorState,
  gpus: GpuSnapshot[],
  options: CollectSnapshotOptions = {},
): Promise<{ snapshot: SystemSnapshot; next: CollectorState }> {
  // 高频采样：3s 内没回来就当该项不可用，避免拖住下一轮
  const collect = <T>(label: string, fn: () => Promise<T>, fallback: T) =>
    safe(fn, fallback, COLLECTOR_TIMEOUTS.sample, label)

  // CPU 计数器在**派发采集之前**读：窗口就是「上一次读」到「这一次读」，
  // 与单轮采集耗时无关（慢轮不会把窗口拉长或缩短）
  const cpuAt = Date.now()
  const cpuTimes = readCpuTimes(cpuAt)

  // 慢变指标（容量 / 进程数 / 用户数）按 30s 刷新，见 SLOW_METRIC_TTL_MS
  const [mem, fsSize, netStats, temp, time, processes, users, diskCounters] = await Promise.all([
    collect('mem', () => si.mem(), null as Awaited<ReturnType<typeof si.mem>> | null),
    cachedCollect('fsSize', SLOW_METRIC_TTL_MS, () => si.fsSize(), [] as Awaited<
      ReturnType<typeof si.fsSize>
    >),
    collect('networkStats', () => si.networkStats(), [] as Awaited<
      ReturnType<typeof si.networkStats>
    >),
    collect('cpuTemperature', () => si.cpuTemperature(), { main: -1 } as Awaited<
      ReturnType<typeof si.cpuTemperature>
    >),
    // si.time() 是 systeminformation 中少数几个**同步** API，包一层 async 以复用 safe()
    collect('time', async () => si.time(), {
      current: 0,
      uptime: 0,
      timezone: '',
      timezoneName: '',
    }),
    cachedCollect('processes', SLOW_METRIC_TTL_MS, () => si.processes(), { all: 0 } as Awaited<
      ReturnType<typeof si.processes>
    >),
    cachedCollect('users', SLOW_METRIC_TTL_MS, () => si.users(), [] as unknown[]),
    readDiskCounters(),
  ])

  const now = Date.now()
  // 首次采样时 prev.at 为 0，差分速率一律为 0
  const elapsedSec = prev.at > 0 ? (now - prev.at) / 1000 : 0
  const canDiff = elapsedSec > 0.05

  // ── 磁盘：容量来自 fsSize，速率来自 /proc/diskstats 差分 ──
  const nextDisk = new Map<string, DiskCounters>()
  const disks = normalizeDisks(asRecords(fsSize)).map((d) => {
    const before = lookupDiskCounters(prev.disk, d.fs)
    const after = lookupDiskCounters(diskCounters, d.fs)

    let readBps = 0
    let writeBps = 0
    if (before && after && canDiff) {
      readBps = Math.max(0, (after.readBytes - before.readBytes) / elapsedSec)
      writeBps = Math.max(0, (after.writeBytes - before.writeBytes) / elapsedSec)
    }

    // 记录本轮计数供下轮差分。key 用去掉 /dev/ 前缀的设备名，
    // 与 lookupDiskCounters 的查找方式保持一致。
    if (after && d.fs.startsWith('/dev/')) {
      nextDisk.set(d.fs.slice('/dev/'.length), after)
    }

    return {
      fs: d.fs,
      mount: d.mount,
      type: d.type,
      total: d.size,
      used: d.used,
      readBps,
      writeBps,
    }
  })

  // ── 网络：速率基于 rx_bytes / tx_bytes 累计值差分 ──
  const nextNet = new Map<string, { rx: number; tx: number }>()
  const net = asRecords(netStats).map((n) => {
    const iface = (n['iface'] as string) ?? ''
    const rxTotal = validNumber(n['rx_bytes']) ?? 0
    const txTotal = validNumber(n['tx_bytes']) ?? 0
    nextNet.set(iface, { rx: rxTotal, tx: txTotal })

    const before = prev.net.get(iface)
    return {
      iface,
      rxBps: before && canDiff ? Math.max(0, (rxTotal - before.rx) / elapsedSec) : 0,
      txBps: before && canDiff ? Math.max(0, (txTotal - before.tx) / elapsedSec) : 0,
      rxTotal,
      txTotal,
    }
  })

  // ── CPU 使用率：自己维护窗口（见 computeCpuUsage 的注释） ──
  const cpu = computeCpuUsage(
    prev.cpu,
    cpuTimes,
    prev.cpuUsage,
    options.minCpuWindowMs ?? DEFAULT_MIN_CPU_WINDOW_MS,
  )

  // ── 负载均值：1/5/15 分钟都由 node:os 提供（si 的 loadavg 同样来自这里） ──
  const [l1, l5, l15] = os.loadavg()

  const snapshot: SystemSnapshot = {
    ts: now,
    cpu: {
      usage: cpu.value.usage,
      perCore: cpu.value.perCore,
      load: [
        Math.round(l1 * 100) / 100,
        Math.round(l5 * 100) / 100,
        Math.round(l15 * 100) / 100,
      ],
      temp: validNumber(temp.main),
      // 该字段在静态信息里已给出，快照中保留实时值
      speed: null,
    },
    mem: {
      total: mem?.total ?? 0,
      // 不能用 si.mem().used —— 见 usedMemory() 的说明
      used: mem ? usedMemory(mem) : 0,
      free: mem?.free ?? 0,
      available: mem?.available ?? 0,
      swapTotal: mem?.swaptotal ?? 0,
      swapUsed: mem?.swapused ?? 0,
    },
    disks,
    net,
    gpus,
    system: {
      uptime: time.uptime ?? 0,
      processes: processes.all ?? 0,
      users: users.length,
    },
  }

  return {
    snapshot,
    next: {
      at: now,
      net: nextNet,
      disk: nextDisk,
      cpu: cpu.baseline,
      cpuUsage: cpu.value,
    },
  }
}
