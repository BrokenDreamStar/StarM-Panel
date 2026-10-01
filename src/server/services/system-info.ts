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

/** 逐项独立捕获失败，任何一项挂掉都不影响其它项 */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.warn('[system-info] 采集失败:', (err as Error)?.message ?? err)
    return fallback
  }
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
 */
function deriveGpuMetrics(c: Record<string, unknown>): GpuMetric[] {
  const out: GpuMetric[] = []
  const has = (key: string) => validNumber(c[key]) !== null

  if (has('utilizationGpu')) out.push('utilization')
  if (has('memoryUsed') || has('memoryTotal') || has('vram')) out.push('memory')
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

function mapGpuDynamic(controllers: Record<string, unknown>[]): GpuSnapshot[] {
  return controllers.map((c, index) => {
    const memoryTotal = validNumber(c['memoryTotal']) ?? validNumber(c['vram'])
    const memoryUsed = validNumber(c['memoryUsed'])
    const memoryUtilization =
      memoryUsed !== null && memoryTotal !== null && memoryTotal > 0
        ? round1((memoryUsed / memoryTotal) * 100)
        : null

    return {
      index,
      vendor: normalizeGpuVendor(c['vendor'], c['model']),
      model: (c['model'] as string) || (c['name'] as string) || '未知 GPU',
      utilization: validNumber(c['utilizationGpu']),
      memoryUsed,
      memoryTotal,
      memoryUtilization,
      temperature: validNumber(c['temperatureGpu']),
      powerDraw: validNumber(c['powerDraw']),
      powerLimit: validNumber(c['powerLimit']),
      fanSpeed: validNumber(c['fanSpeed']),
      clockCore: validNumber(c['clockCore']),
      clockMemory: validNumber(c['clockMemory']),
      available: deriveGpuMetrics(c),
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
  )

  const controllers = asRecords(graphics.controllers)
  const dynamic = mapGpuDynamic(controllers)
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

  const [cpu, cpuSpeed, osInfo, graphics, fsSize, netIfaces, temp, diskCounters] =
    await Promise.all([
      safe(() => si.cpu(), {} as Awaited<ReturnType<typeof si.cpu>>),
      safe(() => si.cpuCurrentSpeed(), {} as Awaited<ReturnType<typeof si.cpuCurrentSpeed>>),
      safe(() => si.osInfo(), {} as Awaited<ReturnType<typeof si.osInfo>>),
      safe(() => si.graphics(), { controllers: [], displays: [] } as Awaited<
        ReturnType<typeof si.graphics>
      >),
      safe(() => si.fsSize(), [] as Awaited<ReturnType<typeof si.fsSize>>),
      safe(() => si.networkInterfaces(), [] as Awaited<
        ReturnType<typeof si.networkInterfaces>
      >),
      safe(() => si.cpuTemperature(), { main: -1 } as Awaited<
        ReturnType<typeof si.cpuTemperature>
      >),
      readDiskCounters(),
    ])

  const controllers = asRecords(graphics.controllers)
  const gpuDynamic = mapGpuDynamic(controllers)
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

  staticCache = { at: Date.now(), value }
  return value
}

// ─────────────────────────────────────────────────────────────
// 动态快照
// ─────────────────────────────────────────────────────────────

export interface CollectorState {
  at: number
  net: Map<string, { rx: number; tx: number }>
  disk: Map<string, DiskCounters>
}

export function createCollectorState(): CollectorState {
  return { at: 0, net: new Map(), disk: new Map() }
}

/**
 * 采集一次动态快照。
 *
 * 注意：本函数**不调用 si.graphics()**。GPU 由独立的 GpuSampler 以更低频率
 * 采集（见 docs/DESIGN.md §7.3），避免每秒 spawn nvidia-smi 子进程。
 * GPU 数据由调用方通过 gpus 参数注入。
 */
export async function collectSnapshot(
  prev: CollectorState,
  gpus: GpuSnapshot[],
): Promise<{ snapshot: SystemSnapshot; next: CollectorState }> {
  const [load, mem, fsSize, netStats, temp, time, processes, users, diskCounters] =
    await Promise.all([
      safe(() => si.currentLoad(), null as Awaited<ReturnType<typeof si.currentLoad>> | null),
      safe(() => si.mem(), null as Awaited<ReturnType<typeof si.mem>> | null),
      safe(() => si.fsSize(), [] as Awaited<ReturnType<typeof si.fsSize>>),
      safe(() => si.networkStats(), [] as Awaited<ReturnType<typeof si.networkStats>>),
      safe(() => si.cpuTemperature(), { main: -1 } as Awaited<
        ReturnType<typeof si.cpuTemperature>
      >),
      // si.time() 是 systeminformation 中少数几个**同步** API，包一层 async 以复用 safe()
      safe(async () => si.time(), { current: 0, uptime: 0, timezone: '', timezoneName: '' }),
      safe(() => si.processes(), { all: 0 } as Awaited<ReturnType<typeof si.processes>>),
      safe(() => si.users(), [] as unknown[]),
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

  // ── 负载均值：si.currentLoad() 只给 1 分钟，5/15 分钟用 node:os ──
  const [l1, l5, l15] = os.loadavg()

  const snapshot: SystemSnapshot = {
    ts: now,
    cpu: {
      usage: round1(load?.currentLoad ?? 0),
      perCore: (load?.cpus ?? []).map((c) => round1(c.load)),
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
      used: mem?.used ?? 0,
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

  return { snapshot, next: { at: now, net: nextNet, disk: nextDisk } }
}
