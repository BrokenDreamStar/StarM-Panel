/**
 * 探测白名单与 TCP 探测的单元测试。
 *
 * 白名单是本服务唯一的安全屏障（防止变成 SSRF 跳板 / 内网扫描器），
 * 因此这里覆盖得比较密。运行：bun test
 */
import { describe, expect, test } from 'bun:test'
import {
  isPrivateAddress,
  isPrivateIPv4,
  isPrivateIPv6,
  probeTcp,
  resolveProbeTarget,
} from './net-probe'

describe('isPrivateIPv4', () => {
  const allowed = [
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '192.168.1.5',
    '127.0.0.1',
    '169.254.1.1',
    '100.64.0.1',
    '100.127.255.254',
  ]
  for (const ip of allowed) {
    test(`允许 ${ip}`, () => expect(isPrivateIPv4(ip)).toBe(true))
  }

  const denied = [
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1', // 172.16.0.0/12 的下边界外
    '172.32.0.1', // 上边界外
    '192.169.0.1',
    '11.0.0.1',
    '100.63.0.1', // CGNAT 下边界外
    '100.128.0.1', // CGNAT 上边界外
    '256.1.1.1',
    '1.2.3',
    'not-an-ip',
  ]
  for (const ip of denied) {
    test(`拒绝 ${ip}`, () => expect(isPrivateIPv4(ip)).toBe(false))
  }
})

describe('isPrivateIPv6', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:192.168.1.1']) {
    test(`允许 ${ip}`, () => expect(isPrivateIPv6(ip)).toBe(true))
  }
  for (const ip of ['2001:4860:4860::8888', '2606:4700::1111', '::ffff:8.8.8.8']) {
    test(`拒绝 ${ip}`, () => expect(isPrivateIPv6(ip)).toBe(false))
  }
})

describe('isPrivateAddress', () => {
  test('非法输入返回 false', () => {
    expect(isPrivateAddress('example.com')).toBe(false)
    expect(isPrivateAddress('')).toBe(false)
  })
})

describe('resolveProbeTarget 白名单', () => {
  const allowedCases: Array<[string, string, number]> = [
    ['http://192.168.1.5:5000/', '192.168.1.5', 5000],
    ['http://10.0.0.1/', '10.0.0.1', 80],
    ['https://192.168.1.5/', '192.168.1.5', 443],
    ['http://127.0.0.1:3002/', '127.0.0.1', 3002],
    ['http://169.254.1.1/', '169.254.1.1', 80],
    ['http://100.64.0.1/', '100.64.0.1', 80],
    ['http://[::1]:8080/', '::1', 8080],
    ['http://[fd00::1]/', 'fd00::1', 80],
  ]

  for (const [url, host, port] of allowedCases) {
    test(`允许 ${url}`, async () => {
      const t = await resolveProbeTarget(url)
      expect(t.allowed).toBe(true)
      expect(t.host).toBe(host)
      expect(t.port).toBe(port)
    })
  }

  const deniedCases: Array<[string, string]> = [
    ['http://8.8.8.8/', 'public-host'],
    ['http://1.1.1.1:8080/', 'public-host'],
    ['http://172.32.0.1/', 'public-host'],
    ['http://[2001:4860:4860::8888]/', 'public-host'],
    ['ftp://192.168.1.5/', 'bad-scheme'],
    ['file:///etc/passwd', 'bad-scheme'],
    ['not a url', 'bad-url'],
    ['', 'bad-url'],
  ]

  for (const [url, reason] of deniedCases) {
    test(`拒绝 ${JSON.stringify(url)} (${reason})`, async () => {
      const t = await resolveProbeTarget(url)
      expect(t.allowed).toBe(false)
      expect(String(t.reason ?? "")).toBe(reason)
    })
  }

  test('公网域名解析后被拒绝', async () => {
    const t = await resolveProbeTarget('http://example.com/')
    expect(t.allowed).toBe(false)
    // 解析成功但 IP 是公网；若环境 DNS 不可用则可能是 dns-failed，两者都算拒绝
    const reason: string = t.reason ?? ''
    expect(['public-host', 'dns-failed'].includes(reason)).toBe(true)
  })

  test('.local mDNS 主机名直接放行', async () => {
    const t = await resolveProbeTarget('http://nas.local:5000/')
    expect(t.allowed).toBe(true)
    expect(t.host).toBe('nas.local')
  })

  test('单标签内网主机名直接放行', async () => {
    const t = await resolveProbeTarget('http://nas:5000/')
    expect(t.allowed).toBe(true)
    expect(t.host).toBe('nas')
  })
})

describe('probeTcp', () => {
  test('对监听中的端口返回 true，对关闭的端口返回 false', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    const openPort = server.port!

    try {
      expect(await probeTcp('127.0.0.1', openPort, 1000)).toBe(true)

      // 先占一个端口再释放，得到一个几乎肯定无人监听的端口号
      const tmp = Bun.serve({ port: 0, fetch: () => new Response('') })
      const closedPort = tmp.port!
      await tmp.stop(true)

      expect(await probeTcp('127.0.0.1', closedPort, 500)).toBe(false)
    } finally {
      await server.stop(true)
    }
  })

  test('超时返回 false 而不是挂起', async () => {
    // 198.51.100.1 是 TEST-NET-2，保证不可路由 → 应超时后返回 false
    const started = Date.now()
    const result = await probeTcp('198.51.100.1', 9, 300)
    expect(result).toBe(false)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
