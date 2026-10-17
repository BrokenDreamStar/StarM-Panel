/**
 * 管理员认证服务 —— 单账号（只有管理员，不做多用户 / 角色 / 数据隔离）。
 *
 * 认证模型（见 docs/DESIGN.md §8.10）：
 *   - 口令以 **argon2id** 哈希存 `settings['auth.passwordHash']`（参数取 OWASP 推荐档：
 *     m=19MiB, t=2, p=1；实测哈希 ~25ms、校验 ~44ms）
 *   - 登录成功签发**无状态签名 Cookie**（见 services/auth-token.ts），密钥在
 *     `data/secret.key`，服务端不存会话表
 *   - 改密码 / 「退出所有设备」= `auth.sessionEpoch` 自增 → 所有旧令牌当场作废
 *   - 登录失败按 IP 限流（见 services/login-rate-limit.ts）
 *
 * 三种门禁状态（gateMode）：
 *   - `off`   未启用登录保护（`auth.enabled = false`）—— 面板对网络完全开放
 *   - `setup` 启用了保护但还没设密码 —— 只允许走 /api/auth/setup 设定密码
 *   - `login` 启用了保护且已设密码 —— 必须持有有效会话
 */
import type { Context } from 'hono'
import type { AuthState } from '@shared/types'
import {
  SESSION_TTL_MS,
  clearSessionCookie,
  expiresAt,
  issueToken,
  needsRenewal,
  readSessionCookie,
  sessionCookie,
  verifyToken,
  type SessionToken,
} from './auth-token'
import { clientIp, isSecureRequest } from './client-ip'
import { LoginRateLimiter } from './login-rate-limit'
import { getSecret } from './secret'
import { getSecret as readSecretSetting, getSetting, setSetting } from './settings'

/** argon2id 参数：OWASP 推荐档（19 MiB / t=2 / p=1） */
const ARGON2_OPTIONS = {
  algorithm: 'argon2id',
  memoryCost: 19456,
  timeCost: 2,
} as const

export type AuthGateMode = 'off' | 'setup' | 'login'

/** 登录失败限流：单 IP 15 分钟 5 次，超限锁 15 分钟 */
export const loginLimiter = new LoginRateLimiter({
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
})

/**
 * 改密码时的当前密码校验单独一个桶：它与登录是两个动作，
 * 共用计数会让「改密码时手抖几次」把人挡在登录之外。
 */
export const passwordChangeLimiter = new LoginRateLimiter({
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
})

/**
 * 已登出令牌的黑名单（nonce → 过期时间）。
 *
 * 无状态令牌的固有短板：清掉 Cookie 并不能让令牌本身失效，
 * 抓到过 Cookie 的人仍然能用到过期为止。这里在进程内记一笔，
 * 让「退出登录」立刻生效。重启会丢掉黑名单，但浏览器侧的 Cookie 早已删除，
 * 剩下能利用的只有「Cookie 已被窃取且服务端刚重启」这一极端组合。
 */
const revokedNonces = new Map<string, number>()

function pruneRevoked(): void {
  if (revokedNonces.size < 256) return
  const now = Date.now()
  for (const [nonce, exp] of revokedNonces) {
    if (exp <= now) revokedNonces.delete(nonce)
  }
}

// ─────────────────────────────────────────────────────────────
// 门禁状态
// ─────────────────────────────────────────────────────────────

export function isAuthEnabled(): boolean {
  return getSetting('auth.enabled') === true
}

export function getPasswordHash(): string | null {
  const hash = readSecretSetting('auth.passwordHash')
  return typeof hash === 'string' && hash.length > 0 ? hash : null
}

export function isPasswordSet(): boolean {
  return getPasswordHash() !== null
}

export function gateMode(): AuthGateMode {
  if (!isAuthEnabled()) return 'off'
  return isPasswordSet() ? 'login' : 'setup'
}

export function currentEpoch(): number {
  const epoch = getSetting('auth.sessionEpoch')
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : 0
}

function bumpEpoch(): number {
  const next = currentEpoch() + 1
  setSetting('auth.sessionEpoch', next)
  return next
}

// ─────────────────────────────────────────────────────────────
// 口令
// ─────────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, ARGON2_OPTIONS)
}

/** 校验口令。哈希缺失或格式非法一律返回 false（不抛错，避免把细节漏给调用方） */
export async function verifyPassword(password: string): Promise<boolean> {
  const hash = getPasswordHash()
  if (!hash) return false
  try {
    return await Bun.password.verify(password, hash)
  } catch {
    return false
  }
}

/**
 * 首次设定管理员密码（仅当尚未设置时可用）。
 * 顺带把 `auth.enabled` 置 true —— 设了密码就是要用登录保护。
 */
export async function setupPassword(password: string): Promise<void> {
  setSetting('auth.passwordHash', await hashPassword(password))
  setSetting('auth.enabled', true)
  bumpEpoch()
}

/**
 * 修改密码：先校验当前密码，成功后**作废所有旧会话**（世代自增）。
 * 返回 false 表示当前密码不对；成功后调用方应为当前设备重新签发会话。
 */
export async function changePassword(current: string, next: string): Promise<boolean> {
  if (!(await verifyPassword(current))) return false
  setSetting('auth.passwordHash', await hashPassword(next))
  bumpEpoch()
  return true
}

/** 清除管理员密码（CLI `--reset-auth` 的逃生门） */
export function clearPassword(): void {
  setSetting('auth.passwordHash', null)
  bumpEpoch()
}

// ─────────────────────────────────────────────────────────────
// 会话
// ─────────────────────────────────────────────────────────────

export function issueSessionToken(): string {
  return issueToken(getSecret(), currentEpoch()).token
}

/** 从请求 Cookie 里解析出有效会话；无效返回 null */
export function readSession(c: Context): SessionToken | null {
  const token = readSessionCookie(c.req.header('cookie'))
  const session = verifyToken(getSecret(), token, { epoch: currentEpoch() })
  if (!session) return null
  // 注意：黑名单比对必须在签名校验之后，否则等于给攻击者一个「nonce 是否存在」的探针
  if (revokedNonces.has(session.nonce)) return null
  return session
}

/** 写入会话 Cookie */
export function writeSessionCookie(c: Context, token: string): void {
  c.header('set-cookie', sessionCookie(token, { secure: isSecureRequest(c.req.raw) }))
}

/** 清除会话 Cookie（登出 / 会话失效） */
export function writeClearCookie(c: Context): void {
  c.header('set-cookie', clearSessionCookie({ secure: isSecureRequest(c.req.raw) }))
}

/** 滑动续期：距上次签发超过 1 天才重发 Cookie，避免每个请求都写 Set-Cookie */
export function renewSessionIfNeeded(c: Context, session: SessionToken): void {
  if (needsRenewal(session)) writeSessionCookie(c, issueSessionToken())
}

/** 把单个令牌加入黑名单（登出当前设备） */
export function revokeSession(session: SessionToken): void {
  revokedNonces.set(session.nonce, expiresAt(session))
  pruneRevoked()
}

/** 作废所有会话（改密码 / 退出所有设备） */
export function revokeAllSessions(): void {
  bumpEpoch()
  revokedNonces.clear()
}

/** 记录一次成功登录，供「安全」设置页展示 */
export function markLogin(req: Request): void {
  setSetting('auth.lastLoginAt', Date.now())
  setSetting('auth.lastLoginIp', clientIp(req))
}

// ─────────────────────────────────────────────────────────────
// 状态聚合
// ─────────────────────────────────────────────────────────────

/**
 * `GET /api/auth/state` 的响应。
 *
 * 未登录时**不返回**上次登录时间与 IP —— 那会把管理员的出口 IP 泄露给
 * 任何能打开登录页的人。
 */
export function authState(authenticated: boolean): AuthState {
  const state: AuthState = {
    enabled: isAuthEnabled(),
    passwordSet: isPasswordSet(),
    authenticated,
  }
  if (authenticated) {
    const at = getSetting('auth.lastLoginAt')
    const ip = getSetting('auth.lastLoginIp')
    state.lastLoginAt = typeof at === 'number' && at > 0 ? at : null
    state.lastLoginIp = typeof ip === 'string' && ip ? ip : null
    state.sessionDays = Math.round(SESSION_TTL_MS / (24 * 60 * 60 * 1000))
  }
  return state
}
