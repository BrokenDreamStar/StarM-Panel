/**
 * 认证门禁中间件。
 *
 * 两道防线，都在 `/api/*` 上：
 *
 * 1. `sameSiteGuard` —— 写操作（非 GET/HEAD/OPTIONS）必须同源。
 *    与 Cookie 的 `SameSite=Lax` 叠加：Lax 挡住跨站表单提交，
 *    同源校验再挡住「反代 / 老浏览器不认 SameSite」的边角情形。
 *
 * 2. `authGate` —— 默认拒绝。只有白名单里的 4 个认证接口可以匿名访问，
 *    其余 `/api/*` 一律要求有效会话。**采用白名单而不是黑名单**：
 *    以后新增路由时忘记加保护，结果是「被拦下」而不是「裸奔」。
 *
 * 门禁关闭（`auth.enabled = false`）时全部放行 —— 那是用户明确选择的
 * 「面板对网络完全开放」模式（见 docs/DESIGN.md §8.10）。
 */
import type { MiddlewareHandler } from 'hono'
import { HttpError } from './error'
import { gateMode, readSession, renewSessionIfNeeded } from '../services/auth'
import { isSafeMethod, isSameSiteRequest } from '../services/client-ip'

/**
 * 允许匿名访问的接口 —— 登录页自身需要的全部接口。
 * `logout` 也在内：会话失效时也要能清掉浏览器里的旧 Cookie。
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/api/auth/state',
  '/api/auth/login',
  '/api/auth/setup',
  '/api/auth/logout',
])

/** 去掉末尾斜杠，`/api/auth/state/` 与 `/api/auth/state` 等价 */
function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

export const sameSiteGuard: MiddlewareHandler = async (c, next) => {
  if (!isSafeMethod(c.req.method) && !isSameSiteRequest(c.req.raw)) {
    throw new HttpError(403, 'CROSS_SITE_BLOCKED', '已拒绝跨站写操作')
  }
  await next()
}

export const authGate: MiddlewareHandler = async (c, next) => {
  const mode = gateMode()
  if (mode === 'off') return next()
  if (PUBLIC_PATHS.has(normalizePath(c.req.path))) return next()

  const session = readSession(c)
  if (!session) {
    throw mode === 'setup'
      ? new HttpError(401, 'SETUP_REQUIRED', '请先设置管理员密码')
      : new HttpError(401, 'UNAUTHENTICATED', '请先登录')
  }

  await next()

  // 滑动续期：距上次签发超过 1 天才重发 Cookie
  renewSessionIfNeeded(c, session)
}
