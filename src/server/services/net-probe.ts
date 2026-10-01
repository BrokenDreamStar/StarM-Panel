/**
 * 探测的纯逻辑层：地址白名单判定 + TCP 连通性探测。
 *
 * 刻意**不依赖数据库/设置/任何单例**，因此可以被独立单元测试，
 * 也便于审阅安全边界。调度与缓存见 ./probe.ts。
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// ─────────────────────────────────────────────────────────────
// 私有地址判定
// ─────────────────────────────────────────────────────────────

export function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4) return false
  if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false

  const [a, b] = p as [number, number, number, number]
  if (a === 10) return true // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 127) return true // 回环
  if (a === 169 && b === 254) return true // 链路本地
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a === 0) return true // 0.0.0.0/8
  return false
}

export function isPrivateIPv6(raw: string): boolean {
  const ip = raw.toLowerCase()
  if (ip === '::1' || ip === '::') return true
  // fc00::/7 唯一本地地址
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true
  // fe80::/10 链路本地
  if (/^fe[89ab]/.test(ip)) return true
  // IPv4 映射地址 ::ffff:192.168.1.1
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIPv4(mapped[1]!)
  return false
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return isPrivateIPv4(ip)
  if (v === 6) return isPrivateIPv6(ip)
  return false
}

// ─────────────────────────────────────────────────────────────
// 目标解析
// ─────────────────────────────────────────────────────────────

export type ProbeDenyReason = 'bad-url' | 'bad-scheme' | 'public-host' | 'dns-failed'

export interface ProbeTarget {
  allowed: boolean
  reason?: ProbeDenyReason
  /**
   * 通过校验后的连接目标。
   * 域名已被解析为 IP —— 直接连 IP 而不是域名，消除了
   * 「校验时解析一次、连接时再解析一次」的 DNS rebinding 时间窗。
   */
  host?: string
  port?: number
  /** 原始主机名，仅用于展示 */
  displayHost?: string
}

function portFor(u: URL): number {
  if (u.port) return Number(u.port)
  return u.protocol === 'https:' ? 443 : 80
}

/**
 * 判定某个内网地址是否允许探测。
 *
 * 允许：
 *   - 私有 / 回环 / 链路本地 / CGNAT 的 IPv4 与 IPv6 字面量
 *   - `.local` 结尾的 mDNS 主机名
 *   - 不含点的单标签主机名（`nas`、`router`）—— 内网常见写法
 *   - 其它域名：解析后 IP 必须落在私有网段
 *
 * 其余一律拒绝。这道白名单是防止本服务变成 SSRF 跳板 / 内网扫描器的唯一屏障。
 */
export async function resolveProbeTarget(rawUrl: string): Promise<ProbeTarget> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return { allowed: false, reason: 'bad-url' }
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { allowed: false, reason: 'bad-scheme' }
  }

  const host = u.hostname
  const port = portFor(u)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { allowed: false, reason: 'bad-url' }
  }

  // IPv6 字面量在 URL 中带方括号
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

  if (isIP(bare)) {
    return isPrivateAddress(bare)
      ? { allowed: true, host: bare, port, displayHost: host }
      : { allowed: false, reason: 'public-host' }
  }

  if (host.endsWith('.local')) {
    return { allowed: true, host, port, displayHost: host }
  }

  // 单标签主机名（不含点）视为内网名称
  if (!host.includes('.')) {
    return { allowed: true, host, port, displayHost: host }
  }

  try {
    const { address } = await lookup(host)
    if (!isPrivateAddress(address)) return { allowed: false, reason: 'public-host' }
    return { allowed: true, host: address, port, displayHost: host }
  } catch {
    return { allowed: false, reason: 'dns-failed' }
  }
}

// ─────────────────────────────────────────────────────────────
// TCP 探测
// ─────────────────────────────────────────────────────────────

/**
 * 尝试建立 TCP 连接。
 *
 * 用 TCP 而非 HTTP 的理由：判断「我在不在这个内网」已经足够，
 * 且不要求目标返回合法 HTTP 响应（很多内网设备只开端口不响应 HTTP），
 * 开销也远低于完整 HTTP 请求。
 */
export function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => done(false), timeoutMs)

    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          done(true)
          socket.end()
        },
        error() {
          done(false)
        },
        data() {
          /* 不关心数据 */
        },
        close() {
          /* 已在 open/error 中定论 */
        },
        connectError() {
          done(false)
        },
      },
    }).catch(() => done(false))
  })
}
