/**
 * 认证接口 —— 单管理员账号，无注册、无多用户、无角色。
 *
 * | 方法 | 路径                  | 是否需要已登录 | 说明 |
 * |------|-----------------------|----------------|------|
 * | GET  | /api/auth/state       | 否             | 门禁状态（登录页据此选形态） |
 * | POST | /api/auth/setup       | 否（仅首启）   | 首次设定管理员密码 |
 * | POST | /api/auth/login       | 否             | 登录，限流 |
 * | POST | /api/auth/logout      | 否             | 登出当前设备（令牌进黑名单） |
 * | POST | /api/auth/password    | **是**         | 修改密码（需当前密码），作废其它会话 |
 * | POST | /api/auth/revoke-all  | **是**         | 退出所有设备（世代自增） |
 *
 * 除 state / setup / login / logout 外，其余接口由 middleware/auth.ts 的门禁拦下。
 */
import { Hono } from 'hono'
import { AuthLoginSchema, AuthPasswordChangeSchema, AuthSetupSchema } from '@shared/schemas'
import { HttpError } from '../middleware/error'
import { jsonBody } from '../middleware/validate'
import { clientIp } from '../services/client-ip'
import {
  authState,
  changePassword,
  isPasswordSet,
  issueSessionToken,
  loginLimiter,
  markLogin,
  passwordChangeLimiter,
  readSession,
  revokeAllSessions,
  revokeSession,
  setupPassword,
  verifyPassword,
  writeClearCookie,
  writeSessionCookie,
} from '../services/auth'

/** 失败响应的统一延迟：抬高在线爆破成本，同时不阻塞事件循环 */
const FAILURE_DELAY_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tooManyAttempts(retryAfterSec: number): HttpError {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60))
  return new HttpError(
    429,
    'TOO_MANY_ATTEMPTS',
    `尝试过于频繁，请约 ${minutes} 分钟后再试`,
    { retryAfterSec },
    { 'retry-after': String(retryAfterSec) },
  )
}

export const authRoutes = new Hono()
  /** 门禁状态。永远公开 —— 登录页本身就靠它渲染 */
  .get('/state', (c) => c.json(authState(readSession(c) !== null)))

  /** 首次设定管理员密码（密码已存在时返回 409，不能用来改密码） */
  .post('/setup', jsonBody(AuthSetupSchema), async (c) => {
    if (isPasswordSet()) {
      throw new HttpError(409, 'PASSWORD_ALREADY_SET', '管理员密码已设置，请直接登录')
    }
    const { password } = c.req.valid('json')
    await setupPassword(password)
    writeSessionCookie(c, issueSessionToken())
    markLogin(c.req.raw)
    return c.json(authState(true))
  })

  /** 登录 */
  .post('/login', jsonBody(AuthLoginSchema), async (c) => {
    const ip = clientIp(c.req.raw)

    const decision = loginLimiter.check(ip)
    if (!decision.allowed) throw tooManyAttempts(decision.retryAfterSec)

    if (!isPasswordSet()) {
      throw new HttpError(409, 'SETUP_REQUIRED', '还没有设置管理员密码')
    }

    const { password } = c.req.valid('json')
    if (!(await verifyPassword(password))) {
      const after = loginLimiter.fail(ip)
      if (!after.allowed) throw tooManyAttempts(after.retryAfterSec)
      await sleep(FAILURE_DELAY_MS)
      throw new HttpError(401, 'INVALID_CREDENTIALS', '密码错误')
    }

    loginLimiter.succeed(ip)
    writeSessionCookie(c, issueSessionToken())
    markLogin(c.req.raw)
    return c.json(authState(true))
  })

  /** 登出当前设备 */
  .post('/logout', (c) => {
    const session = readSession(c)
    if (session) revokeSession(session)
    writeClearCookie(c)
    return c.json(authState(false))
  })

  /** 修改密码：需要当前密码，成功后本机换发新会话、其它设备强制重新登录 */
  .post('/password', jsonBody(AuthPasswordChangeSchema), async (c) => {
    const ip = clientIp(c.req.raw)

    const decision = passwordChangeLimiter.check(ip)
    if (!decision.allowed) throw tooManyAttempts(decision.retryAfterSec)

    const { currentPassword, newPassword } = c.req.valid('json')
    if (!(await changePassword(currentPassword, newPassword))) {
      const after = passwordChangeLimiter.fail(ip)
      if (!after.allowed) throw tooManyAttempts(after.retryAfterSec)
      await sleep(FAILURE_DELAY_MS)
      throw new HttpError(401, 'INVALID_CREDENTIALS', '当前密码不正确')
    }

    passwordChangeLimiter.succeed(ip)
    // 世代已自增，旧 Cookie 全部失效 —— 给当前设备补一张新世代的
    writeSessionCookie(c, issueSessionToken())
    return c.json(authState(true))
  })

  /** 退出所有设备（世代自增，所有已签发令牌立即作废） */
  .post('/revoke-all', (c) => {
    revokeAllSessions()
    writeClearCookie(c)
    return c.json(authState(false))
  })
