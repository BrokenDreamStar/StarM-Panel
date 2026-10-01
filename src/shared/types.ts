/**
 * StarM-Panel 领域类型
 *
 * 本目录的代码被前端与后端共同引用，因此：
 *   - 只允许纯 TypeScript，禁止 import vue / hono / bun 等任一侧的运行时
 *   - 类型与 Zod schema 必须保持同步（schema 见 ./schemas.ts）
 */

// ─────────────────────────────────────────────────────────────
// 通用
// ─────────────────────────────────────────────────────────────

export type NetworkPref = 'auto' | 'lan' | 'wan'
export type NetworkMode = 'lan' | 'wan' | 'auto'
/**
 * 卡片打开方式。这是**全局设置**（`ui.openMode`）而不是卡片字段：
 * 同一个面板里的卡片几乎不会各自要求不同的打开方式。
 */
export type OpenMode = 'newTab' | 'self'
export type IconType = 'iconify' | 'asset' | 'text' | 'favicon'
export type AssetKind = 'icon' | 'wallpaper' | 'favicon'

export interface ApiError {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

// ─────────────────────────────────────────────────────────────
// 导航面板实体
// ─────────────────────────────────────────────────────────────

export interface Group {
  id: number
  name: string
  icon: string | null
  sort: number
  collapsed: boolean
  createdAt: number
  updatedAt: number
}

export interface Item {
  id: number
  groupId: number | null
  title: string
  subtitle: string | null
  iconType: IconType
  iconValue: string | null
  iconColor: string | null
  bgColor: string | null
  /** 内网地址 */
  lanUrl: string | null
  /** 外网地址 */
  wanUrl: string | null
  /** 卡片级网络偏好，优先级高于全局模式 */
  networkPref: NetworkPref
  sort: number
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface Asset {
  id: string
  kind: AssetKind
  name: string
  mime: string
  size: number
  createdAt: number
}

/** GET /api/bootstrap —— 一次请求拿到首屏渲染所需的全部数据 */
export interface BootstrapPayload {
  version: string
  groups: Group[]
  items: Item[]
  settings: Record<string, unknown>
  authRequired: boolean
  platform: {
    os: string
    arch: string
    hostname: string
  }
}

// ─────────────────────────────────────────────────────────────
// 系统监控 —— 动态快照
// ─────────────────────────────────────────────────────────────

/** GPU 上真实可用的指标名。前端据此决定渲染哪些控件，避免显示一排 N/A */
export type GpuMetric =
  | 'utilization'
  | 'memory'
  | 'temperature'
  | 'power'
  | 'fan'
  | 'clock'

export interface GpuSnapshot {
  index: number
  /** nvidia | amd | intel | apple | broadcom | unknown */
  vendor: string
  model: string
  /** 0-100 (%) */
  utilization: number | null
  /** bytes */
  memoryUsed: number | null
  /** bytes */
  memoryTotal: number | null
  /** 0-100 (%) */
  memoryUtilization: number | null
  /** °C */
  temperature: number | null
  /** W */
  powerDraw: number | null
  /** W */
  powerLimit: number | null
  /** 0-100 (%) */
  fanSpeed: number | null
  /** MHz */
  clockCore: number | null
  /** MHz */
  clockMemory: number | null
  available: GpuMetric[]
}

export interface DiskSnapshot {
  fs: string
  mount: string
  type: string
  /** bytes */
  total: number
  used: number
  /** bytes/s，由累计计数差分得出 */
  readBps: number
  writeBps: number
}

export interface NetSnapshot {
  iface: string
  /** bytes/s，由累计计数差分得出 */
  rxBps: number
  txBps: number
  /** bytes */
  rxTotal: number
  txTotal: number
}

export interface SystemSnapshot {
  /** Unix 毫秒 */
  ts: number

  cpu: {
    /** 0-100 (%) */
    usage: number
    /** 每核心 0-100 (%) */
    perCore: number[]
    /** 1/5/15 分钟负载均值 */
    load: [number, number, number]
    /** °C，不可用时为 null */
    temp: number | null
    /** GHz */
    speed: number | null
  }

  mem: {
    total: number
    used: number
    free: number
    available: number
    swapTotal: number
    swapUsed: number
  }

  disks: DiskSnapshot[]
  net: NetSnapshot[]
  /** 无可用 GPU 时为 [] */
  gpus: GpuSnapshot[]

  system: {
    /** 秒 */
    uptime: number
    processes: number
    users: number
  }
}

// ─────────────────────────────────────────────────────────────
// 系统监控 —— 静态信息
// ─────────────────────────────────────────────────────────────

export interface GpuStaticInfo {
  index: number
  vendor: string
  model: string
  /** bytes */
  vram: number | null
  /** 集显 / Apple Silicon 为 true —— 显存与内存共享，vram 不可信 */
  vramDynamic: boolean
  driverVersion: string | null
  /** PCI 地址 */
  bus: string | null
}

export interface DisplayInfo {
  vendor: string | null
  model: string
  resolutionX: number
  resolutionY: number
  /** Hz */
  refreshRate: number | null
  /** HDMI / DisplayPort / eDP / … */
  connection: string | null
  main: boolean
}

export interface SystemStaticInfo {
  cpu: {
    manufacturer: string
    brand: string
    cores: number
    physicalCores: number
    /** GHz */
    speed: number
  }
  os: {
    platform: string
    distro: string
    release: string
    kernel: string
    arch: string
    hostname: string
  }
  disks: Array<{ fs: string; mount: string; type: string; size: number }>
  net: Array<{
    iface: string
    ifaceName: string
    ip4: string
    mac: string
    /** Mbit/s，未知为 null */
    speed: number | null
  }>
  gpus: GpuStaticInfo[]
  displays: DisplayInfo[]
  /** 哪些采集能力在当前平台可用，用于 UI 提示与自检 */
  capabilities: {
    cpuTemp: boolean
    gpuDynamic: boolean
    disksIo: boolean
    netStats: boolean
  }
}

// ─────────────────────────────────────────────────────────────
// 内外网切换
// ─────────────────────────────────────────────────────────────

export type ResolveSource = 'lan' | 'wan' | 'fallback' | 'none'

export interface ResolvedUrl {
  url: string | null
  source: ResolveSource
}

export interface ResolveContext {
  mode: NetworkMode
  /** 自动模式下：该卡片内网地址是否可达（来自服务端探测缓存） */
  lanReachable?: boolean
}

export interface ProbeEntry {
  /** null = 被 SSRF 白名单拒绝，未实际探测 */
  reachable: boolean | null
  /** Unix 毫秒 */
  checkedAt: number
  reason?: 'blocked' | 'no-url' | 'error'
}

export type ProbeStatus = Record<number, ProbeEntry>
