/**
 * 重启命令行还原的单元测试。
 *
 * 这里的两种 argv 形态都是从真实进程里抓出来的（不是猜的）：
 *   bun 开发：  ["/Users/x/.bun/bin/bun", "/abs/src/server/index.ts", "--port", "3999"]
 *   单文件产物：["bun", "/$bunfs/root/panel", "--port", "3999"]
 * 产物里 argv[1] 是虚拟路径，一旦漏进参数就会被 parseArgs 判成「未知选项」，
 * 新进程起不来 —— 那正是「点了重启面板就再也没回来」，所以必须锁死。
 */
import { describe, expect, test } from 'bun:test'
import { buildRelaunchCommand, isVirtualEntry } from './restart'

describe('isVirtualEntry', () => {
  test('识别 $bunfs 虚拟入口', () => {
    expect(isVirtualEntry('/$bunfs/root/panel')).toBe(true)
  })

  test('识别 Windows 下的 ~BUN 虚拟入口', () => {
    expect(isVirtualEntry('B:\\~BUN\\root\\panel.exe')).toBe(true)
    expect(isVirtualEntry('C:/~BUN/root/panel.exe')).toBe(true)
  })

  test('真实脚本路径不是虚拟入口', () => {
    expect(isVirtualEntry('/Users/x/project/src/server/index.ts')).toBe(false)
  })

  test('缺失时按虚拟入口处理（宁可不传参）', () => {
    expect(isVirtualEntry(undefined)).toBe(true)
    expect(isVirtualEntry('')).toBe(true)
  })
})

describe('buildRelaunchCommand', () => {
  test('开发模式：cmd 取 execPath，参数带上入口脚本', () => {
    const argv = ['/Users/x/.bun/bin/bun', '/abs/src/server/index.ts', '--port', '3999']
    expect(buildRelaunchCommand('/Users/x/.bun/bin/bun', argv)).toEqual({
      cmd: '/Users/x/.bun/bin/bun',
      args: ['/abs/src/server/index.ts', '--port', '3999'],
    })
  })

  test('单文件产物：丢掉 "bun" 与 $bunfs 虚拟路径，cmd 指向二进制自身', () => {
    const argv = ['bun', '/$bunfs/root/panel', '--port', '3999', '--data-dir', '/srv/data']
    expect(buildRelaunchCommand('/opt/starm-panel', argv)).toEqual({
      cmd: '/opt/starm-panel',
      args: ['--port', '3999', '--data-dir', '/srv/data'],
    })
  })

  test('产物无启动参数：只剩 cmd，参数为空', () => {
    expect(buildRelaunchCommand('/opt/starm-panel', ['bun', '/$bunfs/root/panel'])).toEqual({
      cmd: '/opt/starm-panel',
      args: [],
    })
  })

  test('虚拟路径绝不出现在参数里（回归保护）', () => {
    const argv = ['bun', '/$bunfs/root/panel']
    const { args } = buildRelaunchCommand('/opt/starm-panel', argv)
    expect(args.some((a) => a.includes('$bunfs'))).toBe(false)
  })
})
