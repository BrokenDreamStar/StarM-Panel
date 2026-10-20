/**
 * 前端设置项的键与默认值。
 *
 * 这些默认值与后端 `server/services/settings.ts` 的 DEFAULT_SETTINGS 保持一致，
 * 作用只是**首屏兜底**：bootstrap 返回之前 / 请求失败时也能用合理的值渲染。
 * 服务端一旦返回真实设置，一律以服务端为准（见 stores/settings.ts）。
 */
import type { NetworkMode, OpenMode } from '@shared/types'

/**
 * 首页「系统状态」区可展示的硬件卡片类型。
 * 与后端 DEFAULT_SETTINGS['monitor.cards'] 的取值域一致，顺序即默认展示顺序。
 */
export const MONITOR_CARD_KINDS = ['cpu', 'memory', 'disk', 'network', 'gpu', 'system'] as const

export type MonitorCardKind = (typeof MONITOR_CARD_KINDS)[number]

/** 取值守卫：设置来自数据库，任何键都可能是脏数据 */
export function isMonitorCardKind(value: unknown): value is MonitorCardKind {
  return typeof value === 'string' && (MONITOR_CARD_KINDS as readonly string[]).includes(value)
}

/**
 * 需要绑定到**具体设备**的卡片类型：磁盘按挂载点、网络按网卡、GPU 按设备序号。
 * 其余类型（cpu / memory / system）整机唯一，没有设备维度。
 */
export const DEVICE_CARD_KINDS = ['disk', 'network', 'gpu'] as const

export type DeviceCardKind = (typeof DEVICE_CARD_KINDS)[number]

export function isDeviceCardKind(value: unknown): value is DeviceCardKind {
  return typeof value === 'string' && (DEVICE_CARD_KINDS as readonly string[]).includes(value)
}

/**
 * 一条卡片记录。`monitor.cards` 是它的数组，数组顺序 = 展示顺序。
 *
 * `device` 仅在 DEVICE_CARD_KINDS 上有意义：
 *   - disk = 挂载点，network = 网卡名，gpu = 设备序号（字符串）
 *   - cpu / memory / system 恒为 undefined
 *
 * 为了兼容旧版把 `monitor.cards` 存成 `['cpu', ...]` 的纯字符串数组，
 * **device 缺省 = 「自动」条目**：按当前检测到的设备展开成多张卡片。
 * 用户在「添加卡片」里选中的具体设备则写成显式条目。
 */
export interface MonitorCardEntry {
  kind: MonitorCardKind
  device?: string
}

/** 卡片记录的唯一标识（kind + 设备），用于去重 / 拖拽 / v-for key */
export function cardEntryId(entry: MonitorCardEntry): string {
  return `${entry.kind}:${entry.device ?? ''}`
}

export const SETTINGS_DEFAULTS = {
  'network.mode': 'lan' as NetworkMode,
  'network.autoMode': false,

  'theme.mode': 'system' as 'light' | 'dark' | 'system',
  'theme.accent': '#6366f1',
  'wallpaper.type': 'gradient' as 'solid' | 'gradient' | 'asset' | 'bing',
  'wallpaper.value': null as string | null,

  'search.defaultEngine': 'bing',

  'monitor.interval': 3000,
  'monitor.hiddenInterval': 10_000,
  /**
   * 首页「系统状态」区展示哪些卡片，数组顺序 = 展示顺序（由首页增删 / 拖拽写入）。
   * 字符串写法 = 兼容旧值；新值一律是 `{ kind, device }`（见 MonitorCardEntry）。
   */
  'monitor.cards': [...MONITOR_CARD_KINDS] as Array<MonitorCardKind | MonitorCardEntry>,

  /**
   * 登录保护总开关（默认开启，与后端 DEFAULT_SETTINGS 一致）。
   * 登录页读不到服务端设置时，这个默认值保证不会把「已开启」错显示成「未启用」。
   */
  'auth.enabled': true,

  'ui.showMonitor': true,
  'ui.cardSize': 'md' as 'sm' | 'md' | 'lg',
  /** 卡片风格：solid = 扁平化（默认），frost = 毛玻璃，liquid = 液态玻璃 */
  'ui.glassStyle': 'solid' as 'frost' | 'solid' | 'liquid',
  'ui.wallpaperText': 'auto' as 'auto' | 'light' | 'dark',
  /**
   * 卡片底色透明度（%），每种 UI 风格独立配置：0 = 完全不透明，100 = 完全透明。
   * 字面值，没有「0 = 跟随风格默认」的哨兵（哨兵会让滑杆 0→1 跨完整个区间）。
   */
  'ui.solidTransparency': 10,
  /** 毛玻璃出厂 32%（α0.68）：再高会接近实色，再低文字对比度开始吃紧 */
  'ui.frostTransparency': 32,
  /** 液态玻璃出厂 55%（α0.45）：保持高透，同时给文字留出可读的底色 */
  'ui.liquidTransparency': 55,
  /** 模糊半径（px）按风格独立，0 = 不模糊 */
  'ui.frostBlur': 12,
  'ui.liquidBlur': 12,
  /** 液态玻璃折射强度（feDisplacementMap scale，demo 调校基准 72） */
  'ui.glassScale': 72,
  /** 液态玻璃边缘色散（RGB 三通道分离）；逐像素三份开销，默认关 */
  'ui.glassChroma': false,
  /** 首页标题旁是否显示时钟与日期 */
  'ui.showClock': true,
  /** 首页标题，留空则显示 "StarM Panel" */
  'ui.title': '',
  /** 卡片打开方式（全局）：新窗口 / 当前窗口 */
  'ui.openMode': 'newTab' as OpenMode,
}

export type SettingsShape = typeof SETTINGS_DEFAULTS
export type SettingsKey = keyof SettingsShape

/** localStorage 中缓存设置快照的键（用于离线可用 / 首屏无闪烁） */
export const SETTINGS_CACHE_KEY = 'starm.settings.cache'

/** 内外网模式的 localStorage 键 —— 切换时同步双写，离线也能立即生效 */
export const NETWORK_MODE_KEY = 'starm.network.mode'

/**
 * 读取单个设置：先取服务端返回值，类型不符或缺失时回落默认值。
 * 刻意做得很保守 —— 设置来自数据库，任何键都可能是脏数据。
 */
export function readSetting<K extends SettingsKey>(
  raw: Record<string, unknown> | null | undefined,
  key: K,
): SettingsShape[K] {
  const fallback = SETTINGS_DEFAULTS[key]
  const value = raw?.[key]
  if (value === undefined || value === null) return fallback

  if (Array.isArray(fallback)) {
    return (Array.isArray(value) ? value : fallback) as SettingsShape[K]
  }
  if (typeof fallback === 'boolean') {
    return (typeof value === 'boolean' ? value : fallback) as SettingsShape[K]
  }
  if (typeof fallback === 'number') {
    const n = typeof value === 'number' ? value : Number(value)
    return (Number.isFinite(n) ? n : fallback) as SettingsShape[K]
  }
  if (typeof fallback === 'string') {
    return (typeof value === 'string' ? value : fallback) as SettingsShape[K]
  }
  return value as SettingsShape[K]
}

/** 枚举值白名单校验（防止库里存了脏值把 UI 卡死） */
export function readEnum<K extends SettingsKey>(
  raw: Record<string, unknown> | null | undefined,
  key: K,
  allowed: ReadonlyArray<SettingsShape[K]>,
): SettingsShape[K] {
  const v = readSetting(raw, key)
  return allowed.includes(v) ? v : SETTINGS_DEFAULTS[key]
}

/**
 * 读取 `monitor.cards`：统一成 `MonitorCardEntry[]`，剔除未知取值并按 id 去重。
 * 兼容三种脏数据：旧版纯字符串、缺 device 的对象、非法 kind。
 */
export function readMonitorCards(
  raw: Record<string, unknown> | null | undefined,
): MonitorCardEntry[] {
  const rawList = readSetting(raw, 'monitor.cards') as unknown[]
  const out: MonitorCardEntry[] = []
  const seen = new Set<string>()
  for (const value of rawList) {
    const entry = parseCardEntry(value)
    if (!entry) continue
    const id = cardEntryId(entry)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(entry)
  }
  return out
}

/** 单个条目解析：字符串 = 自动条目，对象 = 显式设备条目（device 非法时回落成自动） */
function parseCardEntry(value: unknown): MonitorCardEntry | null {
  if (isMonitorCardKind(value)) return { kind: value }
  if (!value || typeof value !== 'object') return null
  const rec = value as Record<string, unknown>
  if (!isMonitorCardKind(rec.kind)) return null
  const device = typeof rec.device === 'string' && rec.device.length > 0 ? rec.device : undefined
  return device ? { kind: rec.kind, device } : { kind: rec.kind }
}
