/**
 * 请求来源信息：客户端 IP、是否 HTTPS、是否同源。
 *
 * 为什么不直接用 `hono/bun` 的 getConnInfo：它要求把 `Bun.serve` 的第二个参数
 * 塞进 `c.env`（hono 5 起该适配器也会被拆走）。这里改成启动时把 server 句柄
 * 存进模块单例，中间件就能直接调 `server.requestIP(req)`，不引入额外抽象。
 *
 * 关于反向代理：默认**不信任** `X-Forwarded-*`。这些头是客户端可以随便伪造的，
 * 无条件信任等于把「按 IP 限流」和「Secure Cookie」两件事交给攻击者决定。
 * 只有显式设置 `STARM_TRUST_PROXY=1`（面板确实挂在可信反代后面）才启用。
 */
/**
 * `Bun.serve` 返回值中我们唯一需要的能力。
 * 用结构化类型而不是 `import type { Server } from 'bun'`，
 * 避免绑定 Bun 类型定义的具体版本。
 */
export interface RequestIpServer {
  requestIP(req: Request): { address: string; family?: string; port?: number } | null
}

let bunServer: RequestIpServer | null = null

/** 由 server/index.ts 在 Bun.serve 时登记 */
export function bindBunServer(server: RequestIpServer): void {
  bunServer = server
}

function isTruthy(raw: string | undefined): boolean {
  if (!raw) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** 是否信任反向代理传来的 X-Forwarded-* 头 */
export function isTrustProxy(): boolean {
  return isTruthy(process.env['STARM_TRUST_PROXY'])
}

/** 强制给会话 Cookie 加 Secure（反代终结 TLS 但不想开 trust-proxy 时用） */
export function isForceSecureCookie(): boolean {
  return isTruthy(process.env['STARM_SECURE_COOKIE'])
}

/** 取 X-Forwarded-* 的第一个值（`a, b` 形式的链里，第一个是最初的客户端） */
function firstForwarded(req: Request, name: string): string | null {
  const raw = req.headers.get(name)
  if (!raw) return null
  const first = raw.split(',')[0]?.trim()
  return first ? first : null
}

/**
 * 客户端 IP —— 限流计数与「上次登录 IP」都用它。
 * 拿不到时返回 'unknown'（所有无 IP 的请求共享同一个限流桶，宁严勿松）。
 */
export function clientIp(req: Request): string {
  if (isTrustProxy()) {
    const forwarded = firstForwarded(req, 'x-forwarded-for')
    if (forwarded) return forwarded
  }
  try {
    const info = bunServer?.requestIP(req)
    if (info?.address) return info.address
  } catch {
    /* server 未登记或已关闭 */
  }
  return 'unknown'
}

/** 请求是否走 HTTPS（决定会话 Cookie 是否带 Secure） */
export function isSecureRequest(req: Request): boolean {
  if (isForceSecureCookie()) return true
  if (isTrustProxy()) {
    const proto = firstForwarded(req, 'x-forwarded-proto')
    if (proto) return proto === 'https'
  }
  try {
    return new URL(req.url).protocol === 'https:'
  } catch {
    return false
  }
}

/** 本次请求的对外 Origin（trust-proxy 下按反代头还原） */
export function requestOrigin(req: Request): string {
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    return ''
  }
  if (!isTrustProxy()) return url.origin

  const proto = firstForwarded(req, 'x-forwarded-proto') ?? url.protocol.replace(':', '')
  const host = firstForwarded(req, 'x-forwarded-host') ?? req.headers.get('host') ?? url.host
  return `${proto}://${host}`
}

/**
 * 写操作的同源校验（CSRF 第二道防线，第一道是 SameSite=Lax）。
 *
 * 判定顺序：
 *   1. `Sec-Fetch-Site`（现代浏览器必发，且由浏览器按**发起方与目标方**计算，
 *      经反向代理也依然准确）——same-origin / none 放行，cross-site 拒绝。
 *   2. 退回 Origin 头比对。
 *   3. 再退回 Referer 比对。
 *   4. 三个头都没有 → 判定为非浏览器客户端（curl / 脚本 / 旧客户端），放行。
 *      这些客户端不携带 Cookie 之外的凭证，且伪造这些头的前提是能直连面板 —— 
 *      那种情况下 CSRF 本就不是威胁模型。
 */
export function isSameSiteRequest(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site')
  if (site) return site === 'same-origin' || site === 'none'

  const origin = req.headers.get('origin')
  if (origin) return origin === requestOrigin(req)

  const referer = req.headers.get('referer')
  if (referer) {
    try {
      return new URL(referer).origin === requestOrigin(req)
    } catch {
      return false
    }
  }
  return true
}

/** 幂等方法不改变状态，无需 CSRF 校验 */
export function isSafeMethod(method: string): boolean {
  const m = method.toUpperCase()
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS'
}
