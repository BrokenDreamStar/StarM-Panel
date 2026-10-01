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

export const SETTINGS_DEFAULTS = {
  'network.mode': 'lan' as NetworkMode,
  'network.autoProbe': true,
  'network.probeInterval': 30_000,
  'network.probeTimeout': 800,

  'theme.mode': 'system' as 'light' | 'dark' | 'system',
  'theme.accent': '#6366f1',
  'theme.blur': 12,
  'wallpaper.type': 'gradient' as 'none' | 'solid' | 'gradient' | 'asset' | 'bing',
  'wallpaper.value': null as string | null,

  'search.defaultEngine': 'bing',

  'monitor.interval': 1000,
  'monitor.hiddenInterval': 10_000,
  'monitor.gpuEnabled': true,
  'monitor.gpuInterval': 3000,
  'monitor.disks': [] as string[],
  'monitor.netIfaces': [] as string[],
  /** 首页「系统状态」区展示哪些卡片，数组顺序 = 展示顺序 */
  'monitor.cards': [...MONITOR_CARD_KINDS] as string[],

  'auth.enabled': false,

  'ui.showMonitor': true,
  'ui.cardSize': 'md' as 'sm' | 'md' | 'lg',
  /** 卡片玻璃风格：frost = 毛玻璃（默认），liquid = 液态玻璃（SVG 位移折射，仅 Chromium 完整生效） */
  'ui.glassStyle': 'frost' as 'frost' | 'liquid',
  /** 液态玻璃下的卡片底色不透明度（%）；0 = 跟随主题默认 */
  'ui.glassOpacity': 0,
  /** 液态玻璃折射强度（feDisplacementMap scale） */
  'ui.glassScale': 64,
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
 * 读取 `monitor.cards`：剔除未知取值并去重。
 * 渲染层拿到的一定是合法 kind，不需要再防御。
 */
export function readMonitorCards(
  raw: Record<string, unknown> | null | undefined,
): MonitorCardKind[] {
  const out: MonitorCardKind[] = []
  for (const value of readSetting(raw, 'monitor.cards')) {
    if (isMonitorCardKind(value) && !out.includes(value)) out.push(value)
  }
  return out
}
