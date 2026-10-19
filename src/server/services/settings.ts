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
  'network.autoMode': false,

  'theme.mode': 'system',
  'theme.accent': '#6366f1',
  'wallpaper.type': 'gradient' as 'solid' | 'gradient' | 'asset' | 'bing',
  'wallpaper.value': null as string | null,

  'search.defaultEngine': 'bing',

  'monitor.interval': 1000,
  'monitor.hiddenInterval': 10_000,
  /**
   * 首页「系统状态」区展示哪些硬件卡片，数组顺序即展示顺序。
   * 条目为 `{ kind, device? }`（见 docs/DESIGN.md §10.3）：
   *   - kind：cpu | memory | disk | network | gpu | system
   *   - device：disk=挂载点 / network=网卡名 / gpu=设备序号；
   *     缺省 = 「自动」条目，按当前设备展开成多张卡片
   * 下面写纯字符串是默认值写法（等价于全部自动展开），新值一律写对象。
   * 由首页「添加卡片」位按设备增删、拖拽排序（不再走设置页）。
   */
  'monitor.cards': ['cpu', 'memory', 'disk', 'network', 'gpu', 'system'] as string[],
  /** 首页主标题旁边是否显示时钟 */
  'ui.showClock': true,
  /** 首页主标题文案，留空则显示 "StarM Panel" */
  'ui.title': '',

  /**
   * 壁纸直排文字颜色（首页标题/时钟/分区与分组标题等）：
   * auto = 跟随主题明暗；light = 固定白色；dark = 固定黑色。
   */
  'ui.wallpaperText': 'auto',

  /**
   * 登录保护开关。**默认开启**：面板默认就需要管理员登录才能访问，
   * 关掉等于把面板完全开放给网络（见 docs/DESIGN.md §8.10）。
   */
  'auth.enabled': true,
  /** 管理员口令的 argon2id 哈希（敏感键，不经 API 读出） */
  'auth.passwordHash': null as string | null,
  /**
   * 会话世代：改密码 / 「退出所有设备」时自增，
   * 一次性作废所有已签发令牌（见 services/auth-token.ts）。
   */
  'auth.sessionEpoch': 0,
  /** 上次成功登录的时间与来源 IP（仅供「设置 → 安全」展示） */
  'auth.lastLoginAt': null as number | null,
  'auth.lastLoginIp': null as string | null,

  'ui.showMonitor': true,
  'ui.cardSize': 'md',
  /**
   * 卡片风格：solid = 扁平化（默认，无模糊的半透明纯色底），
   * frost = 毛玻璃，liquid = 液态玻璃（半透明底 + 高斯模糊 + 边缘高光，
   * 卡片与浮层同一套材质）。
   */
  'ui.glassStyle': 'solid',
  /**
   * 卡片底色透明度（%），每种 UI 风格独立配置：
   * 0 = 完全不透明，100 = 完全透明（卡片看不见）。
   *
   * 这里存的就是字面值，**没有**「0 = 跟随风格默认」那种哨兵值 ——
   * 哨兵会让滑杆在 0→1 之间跨完整个不透明度区间（旧语义下 0 是浅色
   * 毛玻璃的 α0.8 / 实色底的 α0.94，1 却是 α0.01），手感是断的。
   * 默认值即出厂观感，深浅主题只切换色相（见 main.css 的 --card-rgb）。
   */
  'ui.solidTransparency': 10,
  /** 毛玻璃出厂 32%（α0.68）：再高会接近实色，再低文字对比度开始吃紧 */
  'ui.frostTransparency': 32,
  /** 液态玻璃出厂 55%（α0.45）：保持高透，同时给文字留出可读的底色 */
  'ui.liquidTransparency': 55,
  /** 模糊半径（px）按风格独立，0 = 不模糊 */
  'ui.frostBlur': 12,
  'ui.liquidBlur': 12,
  /** 液态玻璃折射强度（与 liquid-glass-demo.html 的调校基准一致） */
  'ui.glassScale': 72,
  /** 液态玻璃边缘色散 */
  'ui.glassChroma': false,
  /**
   * 卡片打开方式（全局，取代旧的卡片级 openMode 字段）。
   * newTab = 新窗口；self = 当前窗口。
   */
  'ui.openMode': 'newTab',
} as const

export type SettingsKey = keyof typeof DEFAULT_SETTINGS

/** 不应通过 API 读出的敏感 / 内部键 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'auth.passwordHash',
  'auth.sessionEpoch',
  'auth.lastLoginAt',
  'auth.lastLoginIp',
])

/**
 * 只能由认证流程（services/auth.ts）写入的键。
 *
 * 经 `PATCH /api/settings` 或备份导入覆盖它们等于认证绕过 ——
 * 攻击者只要能把 `auth.passwordHash` 改成自己算好的哈希，就能直接登录。
 * 因此写入路径上必须显式拒绝，而不是「反正前端不会这么发」。
 */
const AUTH_RESERVED_KEYS: ReadonlySet<string> = new Set([
  'auth.passwordHash',
  'auth.sessionEpoch',
  'auth.lastLoginAt',
  'auth.lastLoginIp',
])

export function isReservedSettingKey(key: string): boolean {
  return AUTH_RESERVED_KEYS.has(key)
}

/** 挑出补丁里被保留的键（供写入接口报错用） */
export function reservedSettingKeys(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter(isReservedSettingKey)
}

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
  // 默认值里也带这些键（类型需要），但一律不对外返回
  for (const k of SECRET_KEYS) delete out[k]
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
