/**
 * StarM Panel 服务端入口。
 *
 * 该文件是 `bun build --compile` 的入口点，因此：
 *   - 所有资源（前端产物、迁移 SQL）必须通过 ./generated/assets 访问
 *   - 数据库在 ./db 模块加载时即完成初始化与迁移
 */
import { Hono } from 'hono'
import { systemRoutes } from './routes/system'
import { itemRoutes } from './routes/items'
import { groupRoutes } from './routes/groups'
import { settingsRoutes } from './routes/settings'
import { assetRoutes } from './routes/assets'
import { bgRoutes } from './routes/bg'
import { localImageRoutes } from './routes/local-image'
import { faviconRoutes } from './routes/favicon'
import { wallpaperRoutes } from './routes/wallpaper'
import { backupRoutes } from './routes/backup'
import { bootstrapRoutes } from './routes/bootstrap'
import { authRoutes } from './routes/auth'
import { updateRoutes } from './routes/update'
import { registerStatic } from './static'
import { monitor } from './services/monitor'
import { HELP, getConfig, resolveConfig } from './env'
import { SCHEMA_VERSION, closeDb } from './db'
import { HttpError, notFound, onError } from './middleware/error'
import { authGate, sameSiteGuard } from './middleware/auth'
import { clearPassword, isAuthEnabled } from './services/auth'
import { bindBunServer } from './services/client-ip'
import { getSetting } from './services/settings'
import { registerRestartHooks } from './services/restart'
import { bgDir, ensureBgDir } from './services/bg-store'
import { cleanupStaleUpdateFiles } from './services/update'
import { APP_VERSION as VERSION, RELEASE_TAG } from '@shared/version'

// --help / --version 必须在任何副作用（建库、建数据目录）之前处理，
// 因此这里用 resolveConfig 而不是 getConfig。
const { help, version, resetAuth } = resolveConfig()
if (help) {
  console.log(HELP)
  process.exit(0)
}
if (version) {
  console.log(`starm-panel ${VERSION}${RELEASE_TAG ? ` (${RELEASE_TAG})` : ''}`)
  process.exit(0)
}

const config = getConfig()

/**
 * `--reset-auth`：忘记管理员密码时的逃生门。
 *
 * 只清口令 + 作废所有会话，不动任何其它配置；退出后下次启动
 * 门禁会停在「设置管理员密码」状态，由使用者重新设定。
 */
if (resetAuth) {
  clearPassword()
  // 关库之后就不能再查设置了 —— 先把要打印的状态读出来
  const stillEnabled = isAuthEnabled()
  closeDb()
  console.log(`
  已清除管理员密码，并作废所有登录会话。
  ${stillEnabled ? '下次打开面板时会要求重新设置管理员密码。' : '注意：当前未启用登录保护（auth.enabled = false）。'}
  数据目录：${config.dataDir}
`)
  process.exit(0)
}

const app = new Hono()

app.onError(onError)
app.notFound(notFound)

/**
 * 全局安全响应头。
 *
 * `frame-ancestors 'none'` 单独一条：面板本身依赖内联样式（naive-ui / 玻璃材质），
 * 完整的 script-src / style-src 白名单会把界面打坏，而防点击劫持只需要这一条。
 * 已自带 CSP 的响应（如 SVG 资源，见 routes/assets.ts）不覆盖 —— 那条 sandbox
 * 比这里的 frame-ancestors 严格得多。
 */
app.use('*', async (c, next) => {
  await next()
  if (!c.res.headers.has('content-security-policy')) {
    c.header('content-security-policy', "frame-ancestors 'none'")
  }
  c.header('x-frame-options', 'DENY')
  c.header('x-content-type-options', 'nosniff')
  c.header('referrer-policy', 'same-origin')
})

// 顺序有意义：先挡跨站写操作，再判登录态（见 middleware/auth.ts）
app.use('/api/*', sameSiteGuard)
app.use('/api/*', authGate)
// 壁纸直链不在 /api/* 下，必须单独挂门禁；它是只读 GET，不需要同源校验
app.use('/bg/*', authGate)

app.get('/healthz', (c) =>
  c.json({
    status: 'ok',
    version: VERSION,
    /** 构建期注入的 Release tag（开发模式为 null），「关于」页用它判断更新 */
    release: RELEASE_TAG,
    schemaVersion: SCHEMA_VERSION,
    uptime: Math.round(process.uptime()),
    pid: process.pid,
    platform: `${process.platform}-${process.arch}`,
  }),
)

app.route('/api/auth', authRoutes)
app.route('/api/bootstrap', bootstrapRoutes)
app.route('/api/system', systemRoutes)
app.route('/api/items', itemRoutes)
app.route('/api/groups', groupRoutes)
app.route('/api/settings', settingsRoutes)
app.route('/api/assets', assetRoutes)
// 壁纸文件直链 /bg/<文件名>（与 /api/assets/<id> 二选一，壁纸用前者）
app.route('/bg', bgRoutes)
// 壁纸也可以直接指向本机图片文件：/api/local-image?path=<绝对路径>
app.route('/api/local-image', localImageRoutes)
app.route('/api/favicon', faviconRoutes)
app.route('/api/wallpaper', wallpaperRoutes)
app.route('/api/backup', backupRoutes)
app.route('/api/update', updateRoutes)

// 必须最后注册：捕获所有未匹配路径，输出嵌入的前端资源
registerStatic(app)

// 启动后台服务（进程级单例），参数取自库中设置
monitor.start({
  intervalMs: getSetting('monitor.interval'),
  hiddenIntervalMs: getSetting('monitor.hiddenInterval'),
})

// 壁纸目录（<data-dir>/bg）与数据库目录一起，在监听前就建好：布局可见，
// 数据目录不可写也会在这里就报错退出
try {
  ensureBgDir()
} catch (err) {
  console.error(
    `\n[bg] 无法创建壁纸目录：${bgDir()}\n` +
      `  ${(err as Error).message}\n` +
      `  请用 --data-dir 指定一个可写目录。\n`,
  )
  process.exit(1)
}

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  // 登记 server 句柄：限流与「上次登录 IP」需要 requestIP(req)（见 services/client-ip）
  fetch: (req, srv) => {
    bindBunServer(srv as Parameters<typeof bindBunServer>[0])
    return app.fetch(req)
  },
  development: false,
  // 检查更新会依次访问 GitHub 清单 / 网页（单步 10 秒超时，最坏约 40 秒）。
  // Bun 默认 10 秒的空闲超时会在正常等待外部网络时直接切断连接，
  // 前端只会看到「Empty reply from server」；这里放宽到 60 秒。
  idleTimeout: 60,
})

/**
 * 启动横幅里的监听信息。
 *
 * 绑定 0.0.0.0 表示监听所有网卡（局域网可访问），但浏览器不能直接打开这个地址，
 * 所以「监听」显示实际绑定地址、「访问」给本机可用的 URL。旧版这里只打印
 * `http://localhost:3002`，看起来像面板只监听了 127.0.0.1。
 */
function describeListen(host: string, port: number): { bind: string; url: string } {
  const wildcard = host === '0.0.0.0' || host === '::'
  const hostPart = host.includes(':') ? `[${host}]` : host
  return {
    bind: `${hostPart}:${port}${wildcard ? '（所有网卡，局域网可访问）' : ''}`,
    url: `http://${wildcard ? 'localhost' : hostPart}:${port}`,
  }
}

const listen = describeListen(config.host, server.port ?? config.port)
console.log(`
  StarM Panel v${VERSION}${RELEASE_TAG ? ` (${RELEASE_TAG})` : ''}
  ────────────────────────────────────────
  监听    ${listen.bind}
  访问    ${listen.url}
  运行时  Bun ${Bun.version} (${process.platform}-${process.arch})
`)

// 端口已经监听成功，说明刚被替换上的新版本至少能正常启动 ——
// 此时再清理上一版留下的 .old 回滚点与更新临时文件（见 services/update）。
cleanupStaleUpdateFiles()

let shuttingDown = false

/**
 * 统一关停：停采样 → 关服务器（显式释放监听端口）→ WAL checkpoint 并关库。
 *
 * Ctrl-C / SIGTERM 退出与「关于」页的重启按钮都走这里。顺序不能变：
 * 端口必须先释放，重启拉起的新进程才能立刻 bind（见 services/restart）。
 */
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  monitor.stop()
  await server.stop(true)
  closeDb()
}

registerRestartHooks({ shutdown })

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在退出…`)
    void shutdown().then(() => process.exit(0))
  })
}

process.on('uncaughtException', (err) => {
  if (err instanceof HttpError) return
  console.error('[uncaughtException]', err)
})
