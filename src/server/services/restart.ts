/**
 * 进程自重启 —— 「设置 → 关于」里的重启按钮。
 *
 * 单文件产物没有进程守护（不要求 systemd / pm2 / Docker），所以「重启」不能
 * 只 process.exit()：进程一退就再没人把它拉起来，面板会彻底失联。这里改成由
 * 当前进程 spawn 一个 detached 的自身副本，然后自己退出。
 *
 * 下面的顺序是这段代码的全部要点：
 *   1. 先把 HTTP 响应回完（等 FLUSH_DELAY_MS，否则前端拿到的是连接被重置）；
 *   2. 停采样 → await server.stop()（显式释放监听端口）→ checkpoint 并关库；
 *   3. 端口此时已空闲，再 spawn 新进程，它才能立刻 bind，不会 EADDRINUSE；
 *   4. 本进程退出。
 * 若把 2、3 调换，父子两个进程会抢同一个端口，随机有一个启动失败。
 */
import { spawn } from 'node:child_process'

export interface RestartHooks {
  /** 关停顺序由 index.ts 决定：停采样 → 关服务器（释放端口）→ 关数据库 */
  shutdown: () => Promise<void>
}

let hooks: RestartHooks | null = null

/** 由 index.ts 在 Bun.serve 之后注册，避免服务模块反向依赖启动流程 */
export function registerRestartHooks(h: RestartHooks): void {
  hooks = h
}

/** 留给 HTTP 响应刷出的时间，太短前端会看到连接被重置 */
const FLUSH_DELAY_MS = 200

/**
 * argv[1] 是否为「编译产物的虚拟入口」。
 *
 * 产物里 argv 形如 ["bun", "/$bunfs/root/panel", ...]（Windows 为 B:\~BUN\root\panel），
 * 这个路径只存在于 Bun 的虚拟文件系统里，绝不能当参数传给新进程 ——
 * 传了会被 env.ts 的 parseArgs 当成「未知选项」直接报错退出。
 */
export function isVirtualEntry(entry: string | undefined): boolean {
  if (!entry) return true
  return entry.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/i.test(entry)
}

/**
 * 还原「重新拉起自己」的命令行（纯函数，便于单测）。
 *
 *   bun 开发：  [bun, /abs/src/server/index.ts, --port, 3999] → bun + 入口脚本 + 参数
 *   单文件产物：[bun, /$bunfs/root/panel, --port, 3999]       → 二进制 + 参数
 *
 * 两种形态的 argv[0] 都不是可执行文件路径（产物里干脆是字面量 "bun"），
 * 因此 cmd 一律取 process.execPath —— 开发时是 bun 本体，产物里就是面板二进制。
 * DATABASE/data-dir 等来自环境变量，靠 env 继承，不在这里拼。
 */
export function buildRelaunchCommand(
  execPath: string,
  argv: string[],
): { cmd: string; args: string[] } {
  return { cmd: execPath, args: isVirtualEntry(argv[1]) ? argv.slice(2) : argv.slice(1) }
}

/** 立即回响应、稍后重启；返回值交给前端做「重启中」提示 */
export function scheduleRestart(): { pid: number } {
  const pid = process.pid
  setTimeout(() => {
    void relaunch()
  }, FLUSH_DELAY_MS)
  return { pid }
}

async function relaunch(): Promise<void> {
  try {
    await hooks?.shutdown()
  } catch (err) {
    // 关停失败也要继续拉起新进程：此时已经没回头路，面板不能就这么没了
    console.error('[restart] 关停当前进程失败：', err)
  }

  const { cmd, args } = buildRelaunchCommand(process.execPath, process.argv)
  const child = spawn(cmd, args, {
    // data-dir 相对 cwd 解析，新进程必须站在同一个目录下
    cwd: process.cwd(),
    // detached：自成一个进程组，父进程退出不会把它一起带走
    detached: true,
    // 不继承父进程的管道 / 终端：父进程一退出，继承来的 fd 可能已经 EPIPE
    stdio: 'ignore',
    env: process.env,
  })

  try {
    // spawn 的失败（如 ENOENT）是异步事件而非同步抛错，必须等一次 'spawn'
    // 才能确认新进程真的起来了；否则会「以为重启成功、其实面板已死」。
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
    child.unref()
    console.log(
      `[restart] 已拉起新进程 pid=${child.pid}（${cmd} ${args.join(' ')}），本进程退出`,
    )
  } catch (err) {
    console.error(`[restart] 拉起新进程失败，请手动启动面板（${cmd}）：`, err)
    process.exit(1)
  }

  process.exit(0)
}
