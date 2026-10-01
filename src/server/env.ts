/**
 * 运行时配置解析。
 *
 * 数据目录解析优先级（见 docs/DESIGN.md §11.1）：
 *   --data-dir  >  STARM_DATA_DIR  >  ./data  >  ~/.starm-panel
 */
import { homedir } from 'node:os'
import { resolve, join, isAbsolute } from 'node:path'

export interface ServerConfig {
  port: number
  host: string
  dataDir: string
  /** 子路径部署前缀，规范化后形如 '' 或 '/panel' */
  basePath: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

const HELP = `
StarM Panel —— 轻量自托管导航面板

用法：starm-panel [选项]

选项：
  --port <number>        监听端口（默认 3002）
  --host <string>        监听地址（默认 0.0.0.0）
  --data-dir <path>      数据目录（默认 ./data）
  --base-url <path>      子路径部署前缀，例如 /panel（默认 /）
  --log-level <level>    debug | info | warn | error（默认 info）
  --version              显示版本
  --help                 显示帮助
`.trim()

interface ParsedArgs {
  port?: number
  host?: string
  dataDir?: string
  basePath?: string
  logLevel?: ServerConfig['logLevel']
  help?: boolean
  version?: boolean
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`选项 ${arg} 缺少参数值`)
      return v
    }
    switch (arg) {
      case '--port':
      case '-p': {
        const n = Number(next())
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          throw new Error(`--port 取值非法：${n}（应为 1-65535 的整数）`)
        }
        out.port = n
        break
      }
      case '--host':
        out.host = next()
        break
      case '--data-dir':
        out.dataDir = next()
        break
      case '--base-url':
        out.basePath = next()
        break
      case '--log-level': {
        const v = next()
        if (!['debug', 'info', 'warn', 'error'].includes(v)) {
          throw new Error(`--log-level 取值非法：${v}`)
        }
        out.logLevel = v as ServerConfig['logLevel']
        break
      }
      case '--help':
      case '-h':
        out.help = true
        break
      case '--version':
      case '-v':
        out.version = true
        break
      default:
        // 允许无参数启动；遇到未知选项直接报错，避免静默忽略拼写错误
        throw new Error(`未知选项：${arg}\n\n${HELP}`)
    }
  }
  return out
}

/** 规范化子路径前缀：'' 或 '/xxx'（无尾斜杠） */
export function normalizeBasePath(raw: string | undefined): string {
  if (!raw || raw === '/') return ''
  let p = raw.trim()
  if (!p.startsWith('/')) p = '/' + p
  return p.replace(/\/+$/, '')
}

export function resolveConfig(argv: string[] = process.argv.slice(2)): {
  config: ServerConfig
  help: boolean
  version: boolean
} {
  const args = parseArgs(argv)

  const dataDirRaw =
    args.dataDir ?? process.env['STARM_DATA_DIR'] ?? join(process.cwd(), 'data')

  const config: ServerConfig = {
    port: args.port ?? Number(process.env['STARM_PORT'] ?? 3002),
    host: args.host ?? process.env['STARM_HOST'] ?? '0.0.0.0',
    dataDir: isAbsolute(dataDirRaw) ? dataDirRaw : resolve(process.cwd(), dataDirRaw),
    basePath: normalizeBasePath(args.basePath ?? process.env['STARM_BASE_URL']),
    logLevel: args.logLevel ?? 'info',
  }

  return { config, help: Boolean(args.help), version: Boolean(args.version) }
}

// ─────────────────────────────────────────────────────────────
// 惰性单例
//
// 其他模块（如 db/index.ts）需要在模块加载期拿到配置，但 ESM 的 import
// 求值顺序先于 server/index.ts 的代码执行。用惰性单例避开这个顺序问题：
// env 模块本身无副作用，getConfig() 在首次调用时才解析 argv。
// ─────────────────────────────────────────────────────────────

let cached: ServerConfig | null = null

export function getConfig(): ServerConfig {
  if (!cached) cached = resolveConfig().config
  return cached
}


export function defaultDataDir(): string {
  return join(homedir(), '.starm-panel')
}

export { HELP }
