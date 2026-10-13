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
import { faviconRoutes } from './routes/favicon'
import { wallpaperRoutes } from './routes/wallpaper'
import { backupRoutes } from './routes/backup'
import { bootstrapRoutes } from './routes/bootstrap'
import { registerStatic } from './static'
import { monitor } from './services/monitor'
import { HELP, getConfig, resolveConfig } from './env'
import { DB_PATH, SCHEMA_VERSION, closeDb } from './db'
import { HttpError, notFound, onError } from './middleware/error'
import { getSetting } from './services/settings'
import { registerRestartHooks } from './services/restart'

const VERSION = '0.1.0'

// --help / --version 必须在任何副作用（建库、建数据目录）之前处理，
// 因此这里用 resolveConfig 而不是 getConfig。
const { help, version } = resolveConfig()
if (help) {
  console.log(HELP)
  process.exit(0)
}
if (version) {
  console.log(`starm-panel ${VERSION}`)
  process.exit(0)
}

const config = getConfig()

const app = new Hono()

app.onError(onError)
app.notFound(notFound)

app.get('/healthz', (c) =>
  c.json({
    status: 'ok',
    version: VERSION,
    schemaVersion: SCHEMA_VERSION,
    uptime: Math.round(process.uptime()),
    pid: process.pid,
    platform: `${process.platform}-${process.arch}`,
  }),
)

app.route('/api/bootstrap', bootstrapRoutes)
app.route('/api/system', systemRoutes)
app.route('/api/items', itemRoutes)
app.route('/api/groups', groupRoutes)
app.route('/api/settings', settingsRoutes)
app.route('/api/assets', assetRoutes)
app.route('/api/favicon', faviconRoutes)
app.route('/api/wallpaper', wallpaperRoutes)
app.route('/api/backup', backupRoutes)

// 必须最后注册：捕获所有未匹配路径，输出嵌入的前端资源
registerStatic(app)

// 启动后台服务（进程级单例），参数取自库中设置
monitor.start({
  intervalMs: getSetting('monitor.interval'),
  hiddenIntervalMs: getSetting('monitor.hiddenInterval'),
  gpuIntervalMs: getSetting('monitor.gpuInterval'),
})

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
  development: false,
})

const displayHost = config.host === '0.0.0.0' ? 'localhost' : config.host
console.log(`
  StarM Panel v${VERSION}
  ────────────────────────────────────────
  监听    http://${displayHost}:${server.port}
  数据    ${config.dataDir}
  数据库  ${DB_PATH} (schema v${SCHEMA_VERSION})
  运行时  Bun ${Bun.version} (${process.platform}-${process.arch})
`)

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
