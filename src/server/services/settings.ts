/**
 * 设置服务 —— 键值配置的读写与默认值。
 *
 * 值以 JSON 序列化存入 settings 表。未知键允许写入（便于前端先上线开关），
 * 但读取时一律回落到 DEFAULT_SETTINGS。
 */
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { settings } from '../db/schema'

export const DEFAULT_SETTINGS = {
  'network.mode': 'lan',
  'network.autoProbe': true,
  'network.probeInterval': 30_000,
  'network.probeTimeout': 800,

  'theme.mode': 'system',
  'theme.accent': '#6366f1',
  'theme.blur': 12,
  'wallpaper.type': 'gradient',
  'wallpaper.value': null as string | null,

  'search.defaultEngine': 'bing',

  'monitor.interval': 1000,
  'monitor.hiddenInterval': 10_000,
  'monitor.gpuEnabled': true,
  'monitor.gpuInterval': 3000,
  'monitor.disks': [] as string[],
  'monitor.netIfaces': [] as string[],
  /**
   * 首页「系统状态」区展示哪些硬件卡片，数组顺序即展示顺序。
   * 取值：cpu | memory | disk | network | gpu | system
   * disk 会按挂载点展开成多张卡片（受 monitor.disks 白名单约束）。
   */
  'monitor.cards': ['cpu', 'memory', 'disk', 'network', 'gpu', 'system'] as string[],
  /** 首页主标题旁边是否显示时钟 */
  'ui.showClock': true,
  /** 首页主标题文案，留空则显示 "StarM Panel" */
  'ui.title': '',

  'auth.enabled': false,
  'auth.passwordHash': null as string | null,

  'ui.showMonitor': true,
  'ui.cardSize': 'md',
  /**
   * 卡片玻璃风格：frost = 毛玻璃（默认），liquid = 液态玻璃（前端 SVG 位移折射，
   * 仅 Chromium 内核完整生效，其余内核自动回落毛玻璃）。
   */
  'ui.glassStyle': 'frost',
  /** 液态玻璃下的卡片底色不透明度（%），0 = 跟随主题默认 */
  'ui.glassOpacity': 0,
  /** 液态玻璃折射强度 */
  'ui.glassScale': 64,
  /** 液态玻璃边缘色散 */
  'ui.glassChroma': false,
  /**
   * 卡片打开方式（全局，取代旧的卡片级 openMode 字段）。
   * newTab = 新窗口；self = 当前窗口。
   */
  'ui.openMode': 'newTab',
} as const

export type SettingsKey = keyof typeof DEFAULT_SETTINGS

/** 不应通过 API 读出的敏感键 */
const SECRET_KEYS: ReadonlySet<string> = new Set(['auth.passwordHash'])

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // 手工改过数据库导致非法 JSON 时，退化为原始字符串而不是崩溃
    return raw
  }
}

/** 读取全部设置（合并默认值，剔除敏感键） */
export function getAllSettings(): Record<string, unknown> {
  const rows = db.select().from(settings).all()
  const stored: Record<string, unknown> = {}
  for (const r of rows) {
    if (SECRET_KEYS.has(r.key)) continue
    stored[r.key] = parseValue(r.value)
  }

  // 默认值打底，库中值覆盖
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const [k, v] of Object.entries(stored)) {
    out[k] = v
  }
  delete out['auth.passwordHash']
  return out
}

/** 读取单个设置，带类型断言（调用方负责保证键与类型匹配） */
export function getSetting<K extends SettingsKey>(key: K): (typeof DEFAULT_SETTINGS)[K] {
  const row = db.select().from(settings).where(eq(settings.key, key)).get()
  if (!row) return DEFAULT_SETTINGS[key]
  return parseValue(row.value) as (typeof DEFAULT_SETTINGS)[K]
}

/** 读取敏感设置（内部使用，不走 API 序列化） */
export function getSecret(key: string): unknown {
  const row = db.select().from(settings).where(eq(settings.key, key)).get()
  if (!row) return undefined
  return parseValue(row.value)
}

export function setSetting(key: string, value: unknown): void {
  db.insert(settings)
    .values({ key, value: JSON.stringify(value ?? null) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(value ?? null) },
    })
    .run()
}

/** 批量写入，整体在一个事务内 */
export function patchSettings(patch: Record<string, unknown>): void {
  const entries = Object.entries(patch)
  if (entries.length === 0) return

  db.transaction((tx) => {
    for (const [key, value] of entries) {
      const serialized = JSON.stringify(value ?? null)
      tx.insert(settings)
        .values({ key, value: serialized })
        .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
        .run()
    }
  })
}

/** 是否存在自定义值（用于重置） */
export function deleteSettings(keys: string[]): void {
  if (keys.length === 0) return
  db.delete(settings).where(inArray(settings.key, keys)).run()
}
