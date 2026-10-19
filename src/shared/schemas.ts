/**
 * Zod 校验 schema —— 前后端共用。
 *
 * 与 ./types.ts 的类型定义保持同步：类型可由 schema 推导，
 * 但为了前端可读性，主要类型仍手写在 types.ts 中。
 */
import { z } from 'zod'

// ─────────────────────────────────────────────────────────────
// URL 归一化
// ─────────────────────────────────────────────────────────────

/** DNS 主机名（含单标签主机名，如 `nas`），不校验 IP —— IP 单独处理 */
const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

function isValidHostname(h: string): boolean {
  if (!h) return false
  // IPv6 字面量，URL.hostname 会保留方括号
  if (h.startsWith('[') && h.endsWith(']')) return true
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    return h.split('.').every((p) => Number(p) <= 255)
  }
  // 纯数字的非法形态（如 999.1.2.3 会落到这里）
  if (/^[\d.]+$/.test(h)) return false
  return HOSTNAME_RE.test(h)
}

/**
 * 把用户输入的地址归一化为标准 URL。
 *
 * 用户经常只写 `192.168.1.5:8080` 或 `nas.local`，不带协议。
 * 内网服务绝大多数是 http，因此缺省补 `http://`。
 * 非法输入返回 null（而不是抛错），便于调用方统一处理。
 */
export function normalizeUrlInput(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const s = raw.trim()
  if (!s) return null

  // 含 "://" 但前缀不是合法 scheme（如 `ht!tp://x`）→ 用户写错了协议，
  // 不能简单地补 `http://` 了事：WHATWG 解析器允许 `!` 出现在 host 中，
  // 会把 `ht!tp://[` 解析成 host=`ht!tp`，从而被误判为合法。
  if (s.includes('://') && !SCHEME_RE.test(s)) return null

  const candidate = SCHEME_RE.test(s) ? s : `http://${s}`

  let u: URL
  try {
    u = new URL(candidate)
  } catch {
    return null
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!isValidHostname(u.hostname)) return null

  return u.toString()
}

/** 输入为字符串（可空），校验并**归一化**为合法 http(s) 地址 */
const urlInput = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => v === '' || normalizeUrlInput(v) !== null, {
    message: '不是合法的 http/https 地址',
  })
  .nullish()
  .transform((v) => normalizeUrlInput(v))

// ─────────────────────────────────────────────────────────────
// 枚举
// ─────────────────────────────────────────────────────────────

export const IconTypeSchema = z.enum(['iconify', 'asset', 'text', 'favicon'])
export const NetworkPrefSchema = z.enum(['auto', 'lan', 'wan'])
export const NetworkModeSchema = z.enum(['lan', 'wan'])
export const AssetKindSchema = z.enum(['icon', 'wallpaper', 'favicon'])

// ─────────────────────────────────────────────────────────────
// 分组
// ─────────────────────────────────────────────────────────────

const GroupBase = z.object({
  name: z.string().trim().min(1, '分组名不能为空').max(48),
  icon: z.string().trim().max(128).nullish().transform((v) => v || null),
  sort: z.number().int().min(0).optional(),
  collapsed: z.boolean().optional(),
})

export const GroupCreateSchema = GroupBase
export const GroupUpdateSchema = GroupBase.partial()

export const GroupReorderSchema = z.object({
  order: z
    .array(z.object({ id: z.number().int().positive(), sort: z.number().int().min(0) }))
    .min(1)
    .max(500),
})

// ─────────────────────────────────────────────────────────────
// 卡片
// ─────────────────────────────────────────────────────────────

/**
 * 卡片标题长度上限。
 * 卡片尺寸虽有三档（紧凑 150 / 标准 200 / 宽松 250 最小列宽），但标题本就有省略号兜底，
 * 统一给 24 就够用，不按尺寸分档。
 */
export const TITLE_MAX = 24

const ItemBase = z.object({
  groupId: z.number().int().positive().nullish().transform((v) => v ?? null),
  title: z.string().trim().min(1, '标题不能为空').max(TITLE_MAX, `标题最多 ${TITLE_MAX} 个字符`),
  subtitle: z.string().trim().max(128).nullish().transform((v) => v || null),
  iconType: IconTypeSchema.default('iconify'),
  iconValue: z.string().max(4096).nullish().transform((v) => v || null),
  iconColor: z.string().trim().max(64).nullish().transform((v) => v || null),
  bgColor: z.string().trim().max(64).nullish().transform((v) => v || null),
  lanUrl: urlInput,
  wanUrl: urlInput,
  networkPref: NetworkPrefSchema.default('auto'),
  sort: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
})

/**
 * 创建时强制「内外网地址至少填一个」。
 * 更新走 partial 版本，由路由在合并既有数据后再校验该不变量。
 */
export const ItemCreateSchema = ItemBase.refine(
  (d) => d.lanUrl !== null || d.wanUrl !== null,
  { message: '内网地址与外网地址至少填写一个', path: ['lanUrl'] },
)

export const ItemUpdateSchema = ItemBase.partial()

export const ItemReorderSchema = z.object({
  order: z
    .array(
      z.object({
        id: z.number().int().positive(),
        groupId: z.number().int().positive().nullable(),
        sort: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(2000),
})

// ─────────────────────────────────────────────────────────────
// 设置
// ─────────────────────────────────────────────────────────────

export const SettingsPatchSchema = z.record(z.string().min(1).max(64), z.unknown())

// ─────────────────────────────────────────────────────────────
// 管理员认证（单账号）
// ─────────────────────────────────────────────────────────────

export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128

/**
 * 明显弱口令黑名单 —— 只挡最离谱的一批。
 * 刻意**不**强制大小写/数字/符号组合：长度才是决定性因素，
 * 复杂度规则只会把人逼去写 `Passw0rd!` 这种更难记、也未必更强的口令。
 */
const WEAK_PASSWORDS: ReadonlySet<string> = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  '87654321',
  'qwertyui',
  'qwerty123',
  'abc12345',
  '11111111',
  '00000000',
  'admin123',
  'administrator',
  'letmein1',
  'iloveyou',
  'starmpanel',
  'starm-panel',
  'starm.panel',
])

/** 密码规则：前后端共用（前端表单即时提示，后端最终裁决） */
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN, `密码至少 ${PASSWORD_MIN} 位`)
  .max(PASSWORD_MAX, `密码最多 ${PASSWORD_MAX} 位`)
  .refine((v) => v.trim().length > 0, { message: '密码不能全是空格' })
  .refine((v) => !WEAK_PASSWORDS.has(v.trim().toLowerCase()), {
    message: '这个密码太常见了，换一个吧',
  })

/** 首次设定管理员密码 */
export const AuthSetupSchema = z.object({ password: PasswordSchema })

/** 登录：只校验存在性与长度上限（错误原因一律由服务端统一回「密码错误」） */
export const AuthLoginSchema = z.object({
  password: z.string().min(1, '请输入密码').max(PASSWORD_MAX, `密码最多 ${PASSWORD_MAX} 位`),
})

/** 修改密码 */
export const AuthPasswordChangeSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码').max(PASSWORD_MAX),
  newPassword: PasswordSchema,
})

// ─────────────────────────────────────────────────────────────
// 其他
// ─────────────────────────────────────────────────────────────

export const FaviconRequestSchema = z.object({
  url: z.string().trim().min(1).max(2048),
})

/**
 * 应用更新。
 *
 * tag 必须是 `GET /api/update/check` 返回的那个 Release ——
 * 服务端会再核一遍，不接受客户端指定任意下载目标。
 */
export const UpdateApplySchema = z.object({
  tag: z.string().trim().min(1).max(64),
})
