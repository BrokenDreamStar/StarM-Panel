/**
 * 运行时配置解析。
 *
 * 数据目录解析优先级（见 docs/DESIGN.md §11.1）：
 *   --data-dir  >  STARM_DATA_DIR  >  ~/.starm-panel
 *
 * 默认落在用户主目录而不是「当前工作目录」，是因为单文件二进制的启动目录
 * 完全不可控（systemd / 双击 / 计划任务各不相同），用 cwd 会让同一次部署在
 * 不同启动方式下看到不同的数据；`bun run dev` 这类开发场景显式传 --data-dir。
 */
import { homedir } from 'node:os'
import { resolve, join, isAbsolute } from 'node:path'
import { PROJECT_REPO_SLUG } from '@shared/links'

/** 软件更新（从 GitHub Releases 拉取）的部署侧配置 */
export interface UpdateConfig {
  /** GitHub 仓库，形如 owner/name */
  repo: string
  /** GitHub 网页根地址（GitHub.com 或 GitHub Enterprise 域名） */
  base: string
  /** 下载加速前缀（ghproxy 一类），空串 = 直连 GitHub */
  mirror: string
}

export interface ServerConfig {
  port: number
  host: string
  dataDir: string
  /** 子路径部署前缀，规范化后形如 '' 或 '/panel' */
  basePath: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  update: UpdateConfig
}

/** 默认的更新源：本项目自己的发布仓库（与页脚的仓库链接共用同一份标识） */
export const DEFAULT_UPDATE_REPO = PROJECT_REPO_SLUG

const HELP = `
StarM Panel —— 轻量自托管导航面板

用法：starm-panel [选项]

选项：
  --port <number>        监听端口（默认 3002）
  --host <string>        监听地址（默认 0.0.0.0）
  --data-dir <path>      数据目录（默认 ~/.starm-panel）
  --base-url <path>      子路径部署前缀，例如 /panel（默认 /）
  --log-level <level>    debug | info | warn | error（默认 info）
  --reset-auth           忘记管理员密码时用：清除口令并要求重新设置，然后退出
  --version              显示版本
  --help                 显示帮助

环境变量：
  STARM_PORT / STARM_HOST / STARM_DATA_DIR / STARM_BASE_URL   同上
  STARM_TRUST_PROXY=1    信任反向代理传来的 X-Forwarded-*（限流 IP 与 Secure Cookie）
  STARM_SECURE_COOKIE=1  强制会话 Cookie 带 Secure（反代终结 TLS 时用）
  STARM_UPDATE_REPO     检查更新的 GitHub 仓库（默认 ${DEFAULT_UPDATE_REPO}）
  STARM_UPDATE_BASE     GitHub 地址（默认 https://github.com；Enterprise 填自己的域名）
  STARM_UPDATE_MIRROR   安装包下载加速前缀，例如 https://ghproxy.example.com/
`.trim()

interface ParsedArgs {
  port?: number
  host?: string
  dataDir?: string
  basePath?: string
  logLevel?: ServerConfig['logLevel']
  resetAuth?: boolean
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
      case '--reset-auth':
        out.resetAuth = true
        break
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

/**
 * 读取更新源配置。
 *
 * 非法值不在启动期抛错：面板的主职是导航首页，不能因为一个可选功能的
 * 环境变量写错就起不来。检查更新时再返回可读的错误提示（见 services/update.ts）。
 */
export function resolveUpdateConfig(): UpdateConfig {
  const mirror = (process.env['STARM_UPDATE_MIRROR'] ?? '').trim()
  return {
    repo: (process.env['STARM_UPDATE_REPO'] ?? DEFAULT_UPDATE_REPO).trim(),
    base: (process.env['STARM_UPDATE_BASE'] ?? 'https://github.com').trim().replace(/\/+$/, ''),
    // 统一补尾斜杠：下载地址 = 镜像前缀 + GitHub 原始完整 URL
    mirror: mirror === '' ? '' : mirror.endsWith('/') ? mirror : `${mirror}/`,
  }
}

export function resolveConfig(argv: string[] = process.argv.slice(2)): {
  config: ServerConfig
  help: boolean
  version: boolean
  resetAuth: boolean
} {
  const args = parseArgs(argv)

  const dataDirRaw = args.dataDir ?? process.env['STARM_DATA_DIR'] ?? defaultDataDir()

  const config: ServerConfig = {
    port: args.port ?? Number(process.env['STARM_PORT'] ?? 3002),
    // 空串按「未设置」处理：容器 / 服务模板里常写 STARM_HOST=，
    // 空 hostname 会让 Bun 绑定 IPv6 通配地址而不是默认的 0.0.0.0
    host: (args.host ?? process.env['STARM_HOST'] ?? '').trim() || '0.0.0.0',
    dataDir: isAbsolute(dataDirRaw) ? dataDirRaw : resolve(process.cwd(), dataDirRaw),
    basePath: normalizeBasePath(args.basePath ?? process.env['STARM_BASE_URL']),
    logLevel: args.logLevel ?? 'info',
    update: resolveUpdateConfig(),
  }

  return {
    config,
    help: Boolean(args.help),
    version: Boolean(args.version),
    resetAuth: Boolean(args.resetAuth),
  }
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


/** 默认数据目录：`~/.starm-panel`（内含 db/ 与 bg/，见 docs/DESIGN.md §11.1） */
export function defaultDataDir(): string {
  return join(homedir(), '.starm-panel')
}

export { HELP }
