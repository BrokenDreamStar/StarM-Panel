/**
 * 会话令牌的单元测试。
 *
 * 这是整个登录系统里最需要锁死的一层：令牌校验一旦有洞，
 * 就等于没有登录。所以这里覆盖伪造、篡改、过期、世代作废四条路径。
 */
import { describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import {
  SESSION_TTL_MS,
  clearSessionCookie,
  expiresAt,
  issueToken,
  needsRenewal,
  readSessionCookie,
  sessionCookie,
  verifyToken,
} from './auth-token'

const SECRET = Buffer.alloc(32, 7)
const OTHER_SECRET = Buffer.alloc(32, 9)
const NOW = 1_700_000_000_000

describe('签发与校验', () => {
  test('自己签发的令牌可以通过校验', () => {
    const { token, session } = issueToken(SECRET, 3, NOW)
    const verified = verifyToken(SECRET, token, { epoch: 3, now: NOW })
    expect(verified).toEqual(session)
  })

  test('令牌形如 v1.iat.epoch.nonce.sig 五段', () => {
    const { token } = issueToken(SECRET, 0, NOW)
    const parts = token.split('.')
    expect(parts).toHaveLength(5)
    expect(parts[0]).toBe('v1')
    expect(Number(parts[1])).toBe(NOW)
  })

  test('同一毫秒签发两次令牌不同（nonce 随机）', () => {
    expect(issueToken(SECRET, 0, NOW).token).not.toBe(issueToken(SECRET, 0, NOW).token)
  })

  test('换一把密钥即失效', () => {
    const { token } = issueToken(SECRET, 0, NOW)
    expect(verifyToken(OTHER_SECRET, token, { epoch: 0, now: NOW })).toBeNull()
  })
})

describe('伪造与篡改一律拒绝', () => {
  test('空值 / 结构不对', () => {
    expect(verifyToken(SECRET, null, { epoch: 0, now: NOW })).toBeNull()
    expect(verifyToken(SECRET, '', { epoch: 0, now: NOW })).toBeNull()
    expect(verifyToken(SECRET, 'v1.1.0.abc', { epoch: 0, now: NOW })).toBeNull()
    expect(verifyToken(SECRET, 'v1.1.0.abc.def.ghi', { epoch: 0, now: NOW })).toBeNull()
    expect(verifyToken(SECRET, 'v2.1.0.abc.sig', { epoch: 0, now: NOW })).toBeNull()
  })

  test('iat / epoch 不是整数', () => {
    const { token } = issueToken(SECRET, 0, NOW)
    const [, , , nonce, sig] = token.split('.') as [string, string, string, string, string]
    expect(verifyToken(SECRET, `v1.abc.0.${nonce}.${sig}`, { epoch: 0, now: NOW })).toBeNull()
    expect(verifyToken(SECRET, `v1.${NOW}.x.${nonce}.${sig}`, { epoch: 0, now: NOW })).toBeNull()
    expect(verifyToken(SECRET, `v1.0.0.${nonce}.${sig}`, { epoch: 0, now: NOW })).toBeNull()
  })

  test('改有效期等于改签名 —— 被拒', () => {
    const { token } = issueToken(SECRET, 0, NOW)
    const parts = token.split('.')
    parts[1] = String(NOW + 10 * SESSION_TTL_MS)
    expect(verifyToken(SECRET, parts.join('.'), { epoch: 0, now: NOW })).toBeNull()
  })

  test('签名被改 —— 被拒', () => {
    const { token } = issueToken(SECRET, 0, NOW)
    const parts = token.split('.')
    parts[4] = Buffer.from('deadbeef'.repeat(4)).toString('base64url')
    expect(verifyToken(SECRET, parts.join('.'), { epoch: 0, now: NOW })).toBeNull()
  })

  test('签名长度合法但内容错误 —— 被拒（长度比较不能短路成放行）', () => {
    const { token } = issueToken(SECRET, 0, NOW)
    const parts = token.split('.')
    const sig = Buffer.from(parts[4] as string, 'base64url')
    sig[0] = (sig[0] as number) ^ 0xff
    parts[4] = sig.toString('base64url')
    expect(verifyToken(SECRET, parts.join('.'), { epoch: 0, now: NOW })).toBeNull()
  })

  test('nonce 为空 —— 被拒', () => {
    const { token } = issueToken(SECRET, 0, NOW)
    const parts = token.split('.')
    parts[3] = ''
    expect(verifyToken(SECRET, parts.join('.'), { epoch: 0, now: NOW })).toBeNull()
  })
})

describe('有效期与世代', () => {
  test('刚好到期仍有效，超过 1 毫秒即失效', () => {
    const { token } = issueToken(SECRET, 0, NOW)
    expect(verifyToken(SECRET, token, { epoch: 0, now: NOW + SESSION_TTL_MS })).not.toBeNull()
    expect(verifyToken(SECRET, token, { epoch: 0, now: NOW + SESSION_TTL_MS + 1 })).toBeNull()
  })

  test('世代自增后旧令牌作废（改密码 / 退出所有设备）', () => {
    const { token } = issueToken(SECRET, 1, NOW)
    expect(verifyToken(SECRET, token, { epoch: 1, now: NOW })).not.toBeNull()
    expect(verifyToken(SECRET, token, { epoch: 2, now: NOW })).toBeNull()
  })

  test('未来时间戳（时钟回拨伪造）被拒，1 分钟内的偏差容忍', () => {
    const future = issueToken(SECRET, 0, NOW + 30_000)
    expect(verifyToken(SECRET, future.token, { epoch: 0, now: NOW })).not.toBeNull()
    const farFuture = issueToken(SECRET, 0, NOW + 10 * 60_000)
    expect(verifyToken(SECRET, farFuture.token, { epoch: 0, now: NOW })).toBeNull()
  })

  test('needsRenewal 只在超过 1 天后为真', () => {
    const { session } = issueToken(SECRET, 0, NOW)
    expect(needsRenewal(session, NOW + 60_000)).toBe(false)
    expect(needsRenewal(session, NOW + 24 * 60 * 60 * 1000)).toBe(false)
    expect(needsRenewal(session, NOW + 24 * 60 * 60 * 1000 + 1)).toBe(true)
  })

  test('expiresAt = iat + TTL', () => {
    const { session } = issueToken(SECRET, 0, NOW)
    expect(expiresAt(session)).toBe(NOW + SESSION_TTL_MS)
  })
})

describe('Cookie 读写', () => {
  test('会话 Cookie 带全 HttpOnly / SameSite=Lax / Path=/', () => {
    const cookie = sessionCookie('tok', { secure: false })
    expect(cookie).toContain('starm_session=tok')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
    expect(cookie).not.toContain('Secure')
  })

  test('HTTPS 部署附加 Secure', () => {
    expect(sessionCookie('tok', { secure: true })).toContain('Secure')
    expect(clearSessionCookie({ secure: true })).toContain('Secure')
  })

  test('清除 Cookie 用 Max-Age=0 且不带值', () => {
    const cookie = clearSessionCookie({ secure: false })
    expect(cookie).toContain('starm_session=;')
    expect(cookie).toContain('Max-Age=0')
  })

  test('从多 Cookie 头里取出会话令牌', () => {
    expect(readSessionCookie('a=1; starm_session=abc; b=2')).toBe('abc')
    expect(readSessionCookie('starm_session=abc')).toBe('abc')
    expect(readSessionCookie('starm_session=')).toBeNull()
    expect(readSessionCookie('other=1')).toBeNull()
    expect(readSessionCookie(null)).toBeNull()
    expect(readSessionCookie(undefined)).toBeNull()
  })

  test('前缀相同的 Cookie 名不会被误认', () => {
    expect(readSessionCookie('starm_session_old=abc')).toBeNull()
  })
})
