/**
 * 运行时配置解析的回归测试。
 *
 * 重点是「二进制裸启动」时的监听地址：面板的存在意义就是给局域网其它设备访问，
 * 默认必须是 0.0.0.0，不能退化成 127.0.0.1（见 docs/DESIGN.md Q6）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolveConfig } from './env'

const KEYS = ['STARM_HOST', 'STARM_PORT'] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const key of KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('监听地址', () => {
  test('裸启动默认监听 0.0.0.0:3002', () => {
    const { config } = resolveConfig([])
    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(3002)
  })

  test('STARM_HOST 覆盖默认监听地址', () => {
    process.env['STARM_HOST'] = '192.168.1.10'
    expect(resolveConfig([]).config.host).toBe('192.168.1.10')
  })

  test('--host 优先于 STARM_HOST', () => {
    process.env['STARM_HOST'] = '192.168.1.10'
    expect(resolveConfig(['--host', '127.0.0.1']).config.host).toBe('127.0.0.1')
  })

  test('空字符串按未设置处理，仍然落到 0.0.0.0', () => {
    process.env['STARM_HOST'] = ''
    expect(resolveConfig([]).config.host).toBe('0.0.0.0')
    expect(resolveConfig(['--host', '']).config.host).toBe('0.0.0.0')
  })
})

describe('监听端口', () => {
  test('非法端口会在解析阶段报错', () => {
    expect(() => resolveConfig(['--port', '0'])).toThrow()
    expect(() => resolveConfig(['--port', '70000'])).toThrow()
  })
})
