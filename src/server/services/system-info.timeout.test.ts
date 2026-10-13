/**
 * 「采集卡死」端到端降级的回归测试。
 *
 * 背景：进程资源耗尽（实测 fd 打满）时 `si.*` 既不 resolve 也不 reject，
 * 修复前 `/api/system/info` 会永久挂起，前端「关于」页的 CPU / 内核整块变「—」。
 * 这里用 mock 把 systeminformation 换成一个「cpu 永不返回」的桩，走**真实路由**
 * （routes/system.ts）验证：卡死项降级、正常项不受牵连、接口在超时预算内返回。
 *
 * 必须放在独立文件里：mock.module 只对「导入被测模块之前」生效。
 */
import { describe, expect, mock, test } from 'bun:test'

/** 永不 settle —— 精确模拟卡死的系统调用 */
const never = () => new Promise(() => {})

mock.module('systeminformation', () => ({
  default: {
    cpu: never,
    cpuCurrentSpeed: async () => ({ avg: 2.4 }),
    osInfo: async () => ({
      platform: 'darwin',
      distro: 'macOS',
      release: '27.0',
      kernel: '27.0.0',
      arch: 'arm64',
      hostname: 'starm-test',
    }),
    graphics: async () => ({ controllers: [], displays: [] }),
    fsSize: async () => [],
    networkInterfaces: async () => [],
    cpuTemperature: async () => ({ main: -1 }),
    currentLoad: async () => ({ currentLoad: 1, cpus: [] }),
    mem: async () => ({
      total: 1,
      used: 1,
      free: 0,
      available: 1,
      swaptotal: 0,
      swapused: 0,
    }),
    networkStats: async () => [],
    time: () => ({ current: 0, uptime: 1, timezone: '', timezoneName: '' }),
    processes: async () => ({ all: 1 }),
    users: async () => [],
  },
}))

const { COLLECTOR_TIMEOUTS, getStaticInfo } = await import('./system-info')
const { systemRoutes } = await import('../routes/system')
const { Hono } = await import('hono')

// 单测里把预算调小，避免真等 10 秒
COLLECTOR_TIMEOUTS.static = 100

const app = new Hono().route('/api/system', systemRoutes)

describe('采集卡死时的接口降级', () => {
  test('cpu 永不返回时，/api/system/info 仍在超时预算内返回完整结构', async () => {
    const t0 = Date.now()
    const res = await app.fetch(new Request('http://localhost/api/system/info'))
    const cost = Date.now() - t0
    const body = (await res.json()) as Record<string, any>

    expect(res.status).toBe(200)
    // 关键：不能在超时后还继续等那个永不 settle 的 Promise
    expect(cost).toBeLessThan(2000)

    // 卡死项降级为 fallback
    expect(body.cpu.brand).toBe('')
    // 正常项不受牵连
    expect(body.os.kernel).toBe('27.0.0')
    expect(body.os.hostname).toBe('starm-test')
    // 采集能力如实反映不可用
    expect(body.capabilities.cpuTemp).toBe(false)
  })

  test('卡死降级的结果不入缓存，恢复后不用 force 也能拿到真实数据', async () => {
    const si = (await import('systeminformation')).default as unknown as Record<string, unknown>
    si['cpu'] = async () => ({ manufacturer: 'Apple', brand: 'M2', cores: 8, physicalCores: 8 })

    // 不带 force：上一轮的降级结果不该被缓存 5 分钟，所以会重新采集
    const info = await getStaticInfo()
    expect(info.cpu.brand).toBe('M2')
  })
})
