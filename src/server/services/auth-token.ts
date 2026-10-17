/**
 * 会话令牌的签发与校验 —— 无状态签名 Cookie（不使用服务端会话表）。
 *
 * 令牌格式：`v1.<iat>.<epoch>.<nonce>.<sig>`
 *   - `iat`   签发时间（Unix 毫秒）—— 有效期从它算起，滑动续期时重发新令牌
 *   - `epoch` 会话世代（settings: `auth.sessionEpoch`）—— 改密码 / 「退出所有设备」
 *             时自增，一次性废掉所有旧令牌，无需遍历会话
 *   - `nonce` 随机串，保证同一时刻签发的令牌互不相同（也用于登出黑名单）
 *   - `sig`   HMAC-SHA256(secret, `v1.<iat>.<epoch>.<nonce>`) 的 base64url
 *
 * 本模块是**纯函数**（除随机数外无 IO、不碰数据库），密钥与世代由调用方传入，
 * 因此可以脱库单测（见 auth-token.test.ts）。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Cookie 名 */
export const SESSION_COOKIE = 'starm_session'

/** 会话有效期：7 天。滑动续期，正常使用不会掉线 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 距上次签发超过 1 天才重发 Cookie，避免每个请求都写 Set-Cookie */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000

/** 容忍的时钟偏差 / 未来时间戳上限（1 分钟） */
const CLOCK_SKEW_MS = 60 * 1000

const VERSION = 'v1'

export interface SessionToken {
  /** 签发时间（Unix 毫秒） */
  iat: number
  /** 会话世代 */
  epoch: number
  nonce: string
}

function sign(secret: Buffer, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

/** 常量时间比较（长度不同直接判否 —— 长度本身不是秘密） */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function payloadOf(iat: number, epoch: number, nonce: string): string {
  return `${VERSION}.${iat}.${epoch}.${nonce}`
}

/** 签发新令牌。`now` 可注入，便于测试 */
export function issueToken(
  secret: Buffer,
  epoch: number,
  now: number = Date.now(),
): { token: string; session: SessionToken } {
  const session: SessionToken = {
    iat: now,
    epoch,
    nonce: randomBytes(9).toString('base64url'),
  }
  const payload = payloadOf(session.iat, session.epoch, session.nonce)
  return { token: `${payload}.${sign(secret, payload).toString('base64url')}`, session }
}

export interface VerifyOptions {
  /** 当前会话世代（来自设置） */
  epoch: number
  now?: number
}

/**
 * 校验令牌：格式、签名、世代、有效期全部通过才返回会话信息，否则 null。
 * 任何一步失败都返回 null（调用方只需处理「无效」一种结果，不必区分原因）。
 */
export function verifyToken(
  secret: Buffer,
  token: string | null | undefined,
  opts: VerifyOptions,
): SessionToken | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 5) return null
  const [version, iatRaw, epochRaw, nonce, sigRaw] = parts as [string, string, string, string, string]
  if (version !== VERSION || !nonce || !sigRaw) return null

  const iat = Number(iatRaw)
  const epoch = Number(epochRaw)
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(epoch) || iat <= 0) return null

  const expected = sign(secret, `${VERSION}.${iatRaw}.${epochRaw}.${nonce}`)
  const got = Buffer.from(sigRaw, 'base64url')
  if (!safeEqual(got, expected)) return null

  // 世代不符 = 该令牌已被「改密码 / 退出所有设备」作废
  if (epoch !== opts.epoch) return null

  const now = opts.now ?? Date.now()
  if (now > iat + SESSION_TTL_MS) return null
  // 未来时间戳（时钟回拨 / 伪造）同样拒绝
  if (iat > now + CLOCK_SKEW_MS) return null

  return { iat, epoch, nonce }
}

/** 是否需要滑动续期（距签发已超过 1 天） */
export function needsRenewal(session: SessionToken, now: number = Date.now()): boolean {
  return now - session.iat > SESSION_RENEW_AFTER_MS
}

/** 会话绝对过期时间（Unix 毫秒），供前端展示 */
export function expiresAt(session: SessionToken): number {
  return session.iat + SESSION_TTL_MS
}

export interface CookieOptions {
  /** 是否附加 Secure（HTTPS 部署） */
  secure: boolean
}

/**
 * 构造会话 Cookie。
 * HttpOnly 挡住 XSS 窃取，SameSite=Lax 挡住跨站写操作（配合中间件的同源校验）。
 */
export function sessionCookie(token: string, opts: CookieOptions): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (opts.secure) attrs.push('Secure')
  return attrs.join('; ')
}

/** 登出用的过期 Cookie（值清空 + Max-Age=0） */
export function clearSessionCookie(opts: CookieOptions): string {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (opts.secure) attrs.push('Secure')
  return attrs.join('; ')
}

/** 从 Cookie 头中取出会话令牌 */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue
    const value = part.slice(eq + 1).trim()
    return value || null
  }
  return null
}
