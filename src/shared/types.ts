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
export type NetworkMode = 'lan' | 'wan'
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
  /**
   * 壁纸的文件直链（`/bg/<文件名>`）—— 只有壁纸有。
   * 图标 / favicon 存在数据库里，引用方式是 `/api/assets/<id>`。
   */
  bgUrl?: string
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
// 管理员认证（单账号，无多用户）
// ─────────────────────────────────────────────────────────────

/**
 * `GET /api/auth/state` 的响应。
 * 登录页 / 首启设置页据此决定展示哪种形态，无需先拿 bootstrap。
 */
export interface AuthState {
  /** 是否启用登录保护（设置项 auth.enabled） */
  enabled: boolean
  /** 是否已设置管理员密码 */
  passwordSet: boolean
  /** 本次请求是否已通过认证 */
  authenticated: boolean
  /** 上次登录时间（Unix 毫秒）—— 仅已认证时返回 */
  lastLoginAt?: number | null
  /** 上次登录来源 IP —— 仅已认证时返回 */
  lastLoginIp?: string | null
  /** 会话有效期（天）—— 仅已认证时返回 */
  sessionDays?: number
}

// ─────────────────────────────────────────────────────────────
// 软件更新（从 GitHub Releases 拉取）
// ─────────────────────────────────────────────────────────────

/** 最新一次 Release 的基本信息（不含下载地址，外链只留在服务端） */
export interface UpdateReleaseInfo {
  tag: string
  version: string
  name: string
  /** ISO 8601 字符串，未发布时为 null */
  publishedAt: string | null
  /** Release 页面地址，前端只用来开「发布说明」 */
  htmlUrl: string
  /** 当前平台安装包的文件名与大小；该 Release 没有对应包时为 null */
  assetName: string | null
  assetSize: number | null
}

/** `GET /api/update/check` 的响应 */
export interface UpdateCheckResult {
  current: {
    version: string
    /** 构建期注入的 Release tag（如 v0.1.1 / v0.1.1-2）；开发模式 / 手写构建为 null */
    release: string | null
    /** 形如 `linux-x64`，与 Release 资产后缀一致 */
    platform: string
    /** 只有单文件产物才能自更新 —— 开发模式恒为 false */
    supported: boolean
  }
  latest: UpdateReleaseInfo | null
  hasUpdate: boolean
  /**
   * 本次检查走的是哪条路径：
   *   manifest = Release 里的 latest.json（带 sha256 校验）
   *   web = 清单缺失 / 不可用时改用的网页检查（无 digest，仅校验大小与文件格式）
   *   null = 尚未检查（开发模式 / 检查失败）
   */
  source: 'manifest' | 'web' | null
  /** 检查失败原因（断网 / 限流 / 仓库无发布 / 无对应平台包）；正常为 null */
  error: string | null
  /** Unix 毫秒 */
  checkedAt: number
}

export type UpdatePhase =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'restarting'
  | 'error'

/** `GET /api/update/status` 的响应 */
export interface UpdateState {
  phase: UpdatePhase
  /** 正在更新到的 Release tag */
  tag: string | null
  /** 已下载字节数 */
  received: number
  /** 总字节数（服务端未给 content-length 时为 null） */
  total: number | null
  error: string | null
  /** Unix 毫秒 */
  startedAt: number | null
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
  /** 已落地的具体模式：自动模式由调用方按访问方式（isLanHost）先解析再传入 */
  mode: NetworkMode
}
