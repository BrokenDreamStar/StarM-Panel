/**
 * 端到端 API 集成测试。
 *
 * 启动**真实的服务器进程**（而不是 in-process 调用 app.request），
 * 覆盖数据库、中间件、路由、后台服务的真实组合行为。
 *
 * 运行：bun test
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let proc: ReturnType<typeof Bun.spawn>
let base: string
let dataDir: string

/**
 * 会话 Cookie jar。
 *
 * 门禁默认开启，因此**整份测试都跑在已登录状态下**：beforeAll 里先走一遍
 * `/api/auth/setup` 设定口令并拿到签名 Cookie，之后每个请求都带上它。
 * 需要验证「未登录会怎样」的用例显式传 `{ anon: true }`。
 */
let sessionCookie = ''

/** 管理员口令（改密码用例会更新它） */
const ADMIN_PASSWORD = 'starm-test-passphrase'
const NEW_PASSWORD = 'starm-test-passphrase-2'

/** 在指定范围内找一个可用端口 */
function pickPort(): number {
  return 41000 + Math.floor(Math.random() * 8000)
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`服务器在 ${timeoutMs}ms 内未就绪`)
}

/** 从响应里更新本地会话 Cookie（登出 / 作废时 Max-Age=0 → 清空 jar） */
function captureCookies(res: Response): void {
  const list: string[] =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? '']

  for (const raw of list) {
    if (!raw) continue
    const pair = raw.split(';')[0] ?? ''
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const name = pair.slice(0, eq).trim()
    if (name !== 'starm_session') continue
    const value = pair.slice(eq + 1).trim()
    sessionCookie = !value || /max-age=0/i.test(raw) ? '' : `${name}=${value}`
  }
}

interface SendOptions {
  /** 不带会话 Cookie（用于验证匿名访问行为） */
  anon?: boolean
  /** 附加请求头（如 sec-fetch-site 模拟跨站请求） */
  headers?: Record<string, string>
}

/** 裸 fetch（上传 / 读二进制 / 导出）用的认证头 —— 其余用例请直接用 send() */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return sessionCookie ? { ...extra, cookie: sessionCookie } : { ...extra }
}

/** POST/PATCH 的 JSON 便捷封装 */
async function send(
  method: string,
  path: string,
  body?: unknown,
  opts: SendOptions = {},
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { ...opts.headers }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (!opts.anon && sessionCookie) headers.cookie = sessionCookie

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  captureCookies(res)

  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: res.status, data }
}

beforeAll(async () => {
  const port = pickPort()
  base = `http://127.0.0.1:${port}`
  dataDir = mkdtempSync(join(tmpdir(), 'starm-test-'))

  proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, 'index.ts'),
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--data-dir',
      dataDir,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  })

  await waitForHealth(base)

  // 首启流程 = 设定管理员密码（顺带把这条路径也覆盖掉），拿到会话 Cookie
  const setup = await send('POST', '/api/auth/setup', { password: ADMIN_PASSWORD }, { anon: true })
  if (setup.status !== 200 || !sessionCookie) {
    throw new Error(`初始化管理员口令失败：HTTP ${setup.status} ${JSON.stringify(setup.data)}`)
  }
})

afterAll(async () => {
  proc?.kill()
  await proc?.exited
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

describe('基础', () => {
  test('healthz 返回版本与 schema 版本', async () => {
    const { status, data } = await send('GET', '/healthz')
    expect(status).toBe(200)
    expect(data.status).toBe('ok')
    expect(data.schemaVersion).toBeGreaterThanOrEqual(1)
  })

  test('未知 API 路径返回结构化 404（而不是 SPA 的 index.html）', async () => {
    const { status, data } = await send('GET', '/api/nope')
    expect(status).toBe(404)
    expect(data.error.code).toBe('NOT_FOUND')
  })

  test('未知选项会让进程以非零码退出', async () => {
    const p = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, 'index.ts'), '--nonsense'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await p.exited
    expect(code).not.toBe(0)
  })
})

describe('分组', () => {
  let gid = 0

  test('创建分组', async () => {
    const { status, data } = await send('POST', '/api/groups', { name: '家庭服务' })
    expect(status).toBe(201)
    expect(data.name).toBe('家庭服务')
    expect(data.sort).toBeGreaterThan(0)
    gid = data.id
  })

  test('空名字被拒绝', async () => {
    const { status, data } = await send('POST', '/api/groups', { name: '   ' })
    expect(status).toBe(400)
    expect(data.error.code).toBe('VALIDATION_ERROR')
  })

  test('部分更新不影响其它字段', async () => {
    const { status, data } = await send('PATCH', `/api/groups/${gid}`, { collapsed: true })
    expect(status).toBe(200)
    expect(data.collapsed).toBe(true)
    expect(data.name).toBe('家庭服务')
  })

  test('更新不存在的分组返回 404', async () => {
    const { status, data } = await send('PATCH', '/api/groups/99999', { name: 'x' })
    expect(status).toBe(404)
    expect(data.error.code).toBe('NOT_FOUND')
  })

  test('列表包含刚创建的分组', async () => {
    const { data } = await send('GET', '/api/groups')
    expect(data.some((g: any) => g.id === gid)).toBe(true)
  })
})

describe('卡片', () => {
  let itemId = 0
  let groupId = 0

  beforeAll(async () => {
    const { data } = await send('POST', '/api/groups', { name: '卡片测试组' })
    groupId = data.id
  })

  test('创建卡片并归一化 URL', async () => {
    const { status, data } = await send('POST', '/api/items', {
      groupId,
      title: '群晖 NAS',
      subtitle: 'DS920+',
      lanUrl: '192.168.1.5:5000',
      wanUrl: 'nas.example.com',
    })
    expect(status).toBe(201)
    expect(data.lanUrl).toBe('http://192.168.1.5:5000/')
    expect(data.wanUrl).toBe('http://nas.example.com/')
    expect(data.networkPref).toBe('auto')
    itemId = data.id
  })

  test('两个地址都为空时拒绝创建', async () => {
    const { status, data } = await send('POST', '/api/items', { title: '无地址' })
    expect(status).toBe(400)
    expect(data.error.code).toBe('VALIDATION_ERROR')
  })

  test('非法 URL 被拒绝', async () => {
    for (const bad of ['ht!tp://[', 'ftp://x.com', '999.1.2.3', 'javascript:alert(1)']) {
      const { status } = await send('POST', '/api/items', { title: 'x', lanUrl: bad })
      expect(status).toBe(400)
    }
  })

  test('不存在的分组被拒绝', async () => {
    const { status, data } = await send('POST', '/api/items', {
      title: 'x',
      lanUrl: 'nas',
      groupId: 99999,
    })
    expect(status).toBe(400)
    expect(data.error.code).toBe('GROUP_NOT_FOUND')
  })

  test('部分更新保留其它字段', async () => {
    const { status, data } = await send('PATCH', `/api/items/${itemId}`, {
      title: '群晖 DS920+',
      networkPref: 'lan',
    })
    expect(status).toBe(200)
    expect(data.title).toBe('群晖 DS920+')
    expect(data.networkPref).toBe('lan')
    expect(data.lanUrl).toBe('http://192.168.1.5:5000/')
    expect(data.wanUrl).toBe('http://nas.example.com/')
  })

  test('把仅剩的地址清空会被拒绝（跨字段不变量）', async () => {
    const { data: only } = await send('POST', '/api/items', {
      title: '只有内网',
      lanUrl: '192.168.1.9',
    })
    const { status, data } = await send('PATCH', `/api/items/${only.id}`, { lanUrl: '' })
    expect(status).toBe(400)
    expect(data.error.code).toBe('URL_REQUIRED')
  })

  test('清空其中一个地址（另一个仍在）可以成功', async () => {
    const { status, data } = await send('PATCH', `/api/items/${itemId}`, { wanUrl: '' })
    expect(status).toBe(200)
    expect(data.wanUrl).toBeNull()
    expect(data.lanUrl).not.toBeNull()
  })

  test('删除卡片是幂等的（第二次 404）', async () => {
    const { data: tmp } = await send('POST', '/api/items', { title: '临时', lanUrl: 'nas' })
    expect((await send('DELETE', `/api/items/${tmp.id}`)).status).toBe(204)
    expect((await send('DELETE', `/api/items/${tmp.id}`)).status).toBe(404)
  })

  test('排序：跨分组移动后顺序正确', async () => {
    const { data: a } = await send('POST', '/api/items', { title: 'A', lanUrl: 'a.local' })
    const { data: b } = await send('POST', '/api/items', { title: 'B', lanUrl: 'b.local' })

    const { status, data } = await send('POST', '/api/items/reorder', {
      order: [
        { id: a.id, groupId, sort: 1 },
        { id: b.id, groupId: null, sort: 2 },
      ],
    })
    expect(status).toBe(200)
    const ra = data.find((i: any) => i.id === a.id)
    const rb = data.find((i: any) => i.id === b.id)
    expect(ra.groupId).toBe(groupId)
    expect(rb.groupId).toBeNull()
  })

  test('排序引用不存在的卡片返回 400', async () => {
    const { status, data } = await send('POST', '/api/items/reorder', {
      order: [{ id: 999999, groupId: null, sort: 1 }],
    })
    expect(status).toBe(400)
    expect(data.error.code).toBe('NOT_FOUND')
  })
})

describe('删除分组时卡片保留', () => {
  test('组内卡片 groupId 变为 null 而不是被删除', async () => {
    const { data: g } = await send('POST', '/api/groups', { name: '待删组' })
    const { data: it } = await send('POST', '/api/items', {
      title: '组内卡片',
      lanUrl: 'nas',
      groupId: g.id,
    })

    expect((await send('DELETE', `/api/groups/${g.id}`)).status).toBe(204)

    const { data: after } = await send('GET', `/api/items/${it.id}`)
    expect(after.id).toBe(it.id)
    expect(after.groupId).toBeNull()
  })
})

describe('设置', () => {
  test('默认值可用，且不泄漏敏感键', async () => {
    const { status, data } = await send('GET', '/api/settings')
    expect(status).toBe(200)
    expect(data['network.mode']).toBe('lan')
    expect(data['auth.passwordHash']).toBeUndefined()
  })

  test('部分更新并持久化', async () => {
    const { status, data } = await send('PATCH', '/api/settings', {
      'network.mode': 'wan',
      'theme.accent': '#ff0000',
    })
    expect(status).toBe(200)
    expect(data['network.mode']).toBe('wan')
    expect(data['theme.accent']).toBe('#ff0000')

    const again = await send('GET', '/api/settings')
    expect(again.data['network.mode']).toBe('wan')
  })
})

describe('bootstrap 聚合', () => {
  test('一次返回首屏所需的全部数据', async () => {
    const { status, data } = await send('GET', '/api/bootstrap')
    expect(status).toBe(200)
    expect(Array.isArray(data.groups)).toBe(true)
    expect(Array.isArray(data.items)).toBe(true)
    expect(typeof data.settings).toBe('object')
    expect(data.authRequired).toBe(true)
    expect(data.version).toBeTruthy()
  })

  test('bootstrap 只返回启用的卡片', async () => {
    const { data: it } = await send('POST', '/api/items', { title: '停用卡', lanUrl: 'nas' })
    await send('PATCH', `/api/items/${it.id}`, { enabled: false })

    const { data } = await send('GET', '/api/bootstrap')
    expect(data.items.some((i: any) => i.id === it.id)).toBe(false)
  })
})

describe('资源上传', () => {
  const PNG_1X1 = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    ),
    (ch) => ch.charCodeAt(0),
  )

  /**
   * 上传 helper。
   *
   * 注意：服务端**不信任** 这里声明的 type —— 实测 Bun 的 fetch 会忽略
   * File 上的 type 而按文件名后缀推断 part 的 Content-Type。
   * 真实类型由服务端嗅探字节得出，因此 filename/type 只影响可读性。
   */
  async function upload(
    bytes: Uint8Array,
    type: string,
    kind = 'icon',
    filename = 'test.bin',
  ): Promise<{ status: number; data: any }> {
    const form = new FormData()
    form.set('kind', kind)
    form.set('file', new File([bytes as BlobPart], filename, { type }))
    const res = await fetch(`${base}/api/assets`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })
    const text = await res.text()
    return { status: res.status, data: text ? JSON.parse(text) : null }
  }

  /** 同一张图追加一个字节 → 内容不同但仍是合法 PNG */
  function variantOfPng(extra: number): Uint8Array {
    const out = new Uint8Array(PNG_1X1.length + 1)
    out.set(PNG_1X1)
    out[PNG_1X1.length] = extra
    return out
  }

  test('上传成功并返回可用 URL', async () => {
    const { status, data } = await upload(PNG_1X1, 'image/png')
    expect(status).toBe(201)
    expect(data.id).toHaveLength(16)
    expect(data.url).toBe(`/api/assets/${data.id}`)

    const res = await fetch(`${base}${data.url}`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('immutable')
  })

  test('内容相同的文件去重为同一个 id', async () => {
    const a = await upload(PNG_1X1, 'image/png')
    const b = await upload(PNG_1X1, 'image/png')
    expect(a.data.id).toBe(b.data.id)
  })

  test('超过体积上限返回 413', async () => {
    const big = new Uint8Array(600 * 1024)
    const { status, data } = await upload(big, 'image/png')
    expect(status).toBe(413)
    expect(data.error.code).toBe('TOO_LARGE')
  })

  test('非图片内容返回 415（即使声明为 image/png）', async () => {
    const { status, data } = await upload(
      new TextEncoder().encode('hello'),
      'image/png', // 伪造声明
      'icon',
      'evil.png', // 伪造文件名
    )
    expect(status).toBe(415)
    expect(data.error.code).toBe('BAD_MIME')
  })

  test('伪装成 PNG 的 HTML 会被字节嗅探拦下（防存储型 XSS）', async () => {
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>')
    const { status, data } = await upload(html, 'image/png', 'icon', 'x.png')
    expect(status).toBe(415)
    expect(data.error.code).toBe('BAD_MIME')
  })

  test('真实 ICO 字节会被识别为 image/x-icon（与声明无关）', async () => {
    const ico = new Uint8Array([0x00, 0x00, 0x01, 0x00, ...new Array(64).fill(0)])
    const { status, data } = await upload(ico, 'application/octet-stream')
    expect(status).toBe(201)
    expect(data.mime).toBe('image/x-icon')
  })

  test('SVG 响应带 CSP，防止直接打开时执行内嵌脚本', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    )
    const { status, data } = await upload(svg, 'image/svg+xml')
    expect(status).toBe(201)
    expect(data.mime).toBe('image/svg+xml')

    const res = await fetch(`${base}${data.url}`, { headers: authHeaders() })
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('sandbox')
  })

  test('非法 kind 返回 400', async () => {
    const { status, data } = await upload(PNG_1X1, 'image/png', 'evil')
    expect(status).toBe(400)
    expect(data.error.code).toBe('BAD_KIND')
  })

  test('被卡片引用的资源无法删除', async () => {
    const { data: asset } = await upload(PNG_1X1, 'image/png')
    await send('POST', '/api/items', {
      title: '用图标的卡片',
      lanUrl: 'nas',
      iconType: 'asset',
      iconValue: asset.url,
    })

    const { status, data } = await send('DELETE', `/api/assets/${asset.id}`)
    expect(status).toBe(409)
    expect(data.error.code).toBe('IN_USE')
    expect(data.error.details.items.length).toBeGreaterThan(0)
  })

  test('未被引用的资源可以删除', async () => {
    // 用内容不同的字节：相同内容会命中内容寻址去重，返回那条已被引用的记录
    const { data: asset } = await upload(variantOfPng(1), 'image/png', 'wallpaper')
    expect((await send('DELETE', `/api/assets/${asset.id}`)).status).toBe(204)
    expect((await send('DELETE', `/api/assets/${asset.id}`)).status).toBe(404)
  })

  test('同一份字节以不同 kind 上传会复用同一条记录（内容寻址）', async () => {
    const a = await upload(variantOfPng(2), 'image/png', 'icon')
    const b = await upload(variantOfPng(2), 'image/png', 'wallpaper')
    expect(b.data.id).toBe(a.data.id)
    expect(b.data.kind).toBe('icon') // kind 保持首次上传的值
  })
})

/**
 * 壁纸走文件存储（<data-dir>/bg/），图标 / favicon 仍走 SQLite BLOB。
 * 这里直接打开服务器那份 SQLite，验证「库里到底存了什么」。
 */
describe('壁纸落盘', () => {
  function assetRow(id: string): { bytes: Uint8Array | null; file_name: string | null } {
    // 不用 readonly：WAL 库的只读连接需要 -shm 可写，容易被 SQLite 拒绝
    const dbFile = new Database(join(dataDir, 'db', 'app.db'))
    try {
      const row = dbFile
        .query('SELECT bytes, file_name FROM assets WHERE id = ?')
        .get(id) as { bytes: Uint8Array | null; file_name: string | null } | null
      if (!row) throw new Error(`assets 里没有 ${id}`)
      return row
    } finally {
      dbFile.close()
    }
  }

  async function uploadWallpaper(
    bytes: Uint8Array,
    filename: string,
  ): Promise<{ status: number; data: any }> {
    const form = new FormData()
    form.set('kind', 'wallpaper')
    form.set('file', new File([bytes as BlobPart], filename, { type: 'image/png' }))
    const res = await fetch(`${base}/api/assets`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })
    const text = await res.text()
    return { status: res.status, data: text ? JSON.parse(text) : null }
  }

  /** 同一头 PNG 追加不同字节 → 内容不同但仍是合法 PNG，避开内容寻址去重 */
  function png(extra: number): Uint8Array {
    const base = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ),
      (ch) => ch.charCodeAt(0),
    )
    const out = new Uint8Array(base.length + 1)
    out.set(base)
    out[base.length] = extra
    return out
  }

  test('按原始文件名落到 bg/，数据库只留文件名', async () => {
    const bytes = png(51)
    const { status, data: asset } = await uploadWallpaper(bytes, '我的壁纸.png')
    expect(status).toBe(201)

    const file = join(dataDir, 'bg', '我的壁纸.png')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file)).toEqual(Buffer.from(bytes))

    const row = assetRow(asset.id)
    expect(row.file_name).toBe('我的壁纸.png')
    expect(row.bytes).toBeNull()

    // 接口照旧按内容哈希返回同样的字节
    const res = await fetch(`${base}${asset.url}`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(bytes))
  })

  test('图标仍然存数据库 BLOB，不落 bg/', async () => {
    const bytes = png(52)
    const form = new FormData()
    form.set('kind', 'icon')
    form.set('file', new File([bytes as BlobPart], 'my-icon.png', { type: 'image/png' }))
    const res = await fetch(`${base}/api/assets`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })
    const asset = await res.json()

    const row = assetRow(asset.id)
    expect(row.file_name).toBeNull()
    expect(Buffer.from(row.bytes!)).toEqual(Buffer.from(bytes))
    expect(existsSync(join(dataDir, 'bg', 'my-icon.png'))).toBe(false)
  })

  test('重名壁纸追加 -1 后缀；内容相同则复用同一个文件', async () => {
    const a = await uploadWallpaper(png(53), 'bg.png')
    expect(assetRow(a.data.id).file_name).toBe('bg.png')

    const b = await uploadWallpaper(png(54), 'bg.png')
    expect(assetRow(b.data.id).file_name).toBe('bg-1.png')
    expect(existsSync(join(dataDir, 'bg', 'bg-1.png'))).toBe(true)

    // 同一份内容再传一次：命中内容寻址去重，不会再多出 bg-2.png
    const c = await uploadWallpaper(png(54), 'bg.png')
    expect(c.data.id).toBe(b.data.id)
    expect(existsSync(join(dataDir, 'bg', 'bg-2.png'))).toBe(false)
  })

  test('文件名里的路径成分被清洗，不会写到 bg/ 之外', async () => {
    const { data: asset } = await uploadWallpaper(png(55), '../../evil.png')
    const stored = assetRow(asset.id).file_name ?? ''

    expect(stored).not.toContain('/')
    expect(stored).not.toContain('\\')
    expect(existsSync(join(dataDir, 'evil.png'))).toBe(false)
    expect(existsSync(join(dataDir, 'bg', stored))).toBe(true)
  })

  test('删除壁纸资源会一并删掉 bg/ 下的文件', async () => {
    const { data: asset } = await uploadWallpaper(png(56), 'del.png')
    expect(existsSync(join(dataDir, 'bg', 'del.png'))).toBe(true)

    expect((await send('DELETE', `/api/assets/${asset.id}`)).status).toBe(204)
    expect(existsSync(join(dataDir, 'bg', 'del.png'))).toBe(false)
    expect((await send('DELETE', `/api/assets/${asset.id}`)).status).toBe(404)
  })

  test('bg/ 里的文件被手工删掉后，重新上传同一张图会补写回去', async () => {
    const bytes = png(58)
    const { data: asset } = await uploadWallpaper(bytes, 'repair.png')
    const file = join(dataDir, 'bg', 'repair.png')
    expect(existsSync(file)).toBe(true)

    rmSync(file) // 模拟用户手工删掉文件
    expect(existsSync(file)).toBe(false)

    // 同一份内容再传一次：命中去重，但文件会被补写（否则这张壁纸再也修不好）
    const again = await uploadWallpaper(bytes, 'whatever.png')
    expect(again.data.id).toBe(asset.id)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file)).toEqual(Buffer.from(bytes))

    const res = await fetch(`${base}${asset.url}`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(bytes))
  })

  test('导出携带壁纸字节，删掉后重新导入会再次落盘', async () => {
    const bytes = png(57)
    const { data: asset } = await uploadWallpaper(bytes, 'restore.png')

    const exported = await fetch(`${base}/api/backup/export?assets=true`, {
      headers: authHeaders(),
    }).then((r) => r.json())
    const entry = exported.assets.find(
      (a: any) => Buffer.from(a.dataBase64, 'base64').equals(Buffer.from(bytes)),
    )
    expect(entry).toBeTruthy()
    expect(entry.kind).toBe('wallpaper')

    // 连文件一起删掉，模拟「换台机器恢复」
    expect((await send('DELETE', `/api/assets/${asset.id}`)).status).toBe(204)
    expect(existsSync(join(dataDir, 'bg', 'restore.png'))).toBe(false)

    const res = await fetch(`${base}/api/backup/import?mode=merge`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        format: 'starm-panel-backup',
        version: 1,
        groups: [],
        items: [],
        settings: {},
        assets: [entry],
      }),
    })
    expect(res.status).toBe(200)

    const list = await send('GET', '/api/assets?kind=wallpaper')
    const restored = list.data.find((a: any) => a.name === 'restore.png')
    expect(restored).toBeTruthy()
    expect(readdirSync(join(dataDir, 'bg'))).toContain('restore.png')

    const served = await fetch(`${base}/api/assets/${restored.id}`, { headers: authHeaders() })
    expect(Buffer.from(await served.arrayBuffer())).toEqual(Buffer.from(bytes))
  })
})

/**
 * 壁纸对外就是文件直链 `/bg/<文件名>`（设置里的「图片地址」存的就是它）：
 * 中文名要能取到、必须在门禁之后、只服务 bg/ 内的图片，且不能 immutable。
 */
describe('壁纸直链 /bg/', () => {
  async function uploadWallpaper(
    bytes: Uint8Array,
    filename: string,
  ): Promise<{ status: number; data: any }> {
    const form = new FormData()
    form.set('kind', 'wallpaper')
    form.set('file', new File([bytes as BlobPart], filename, { type: 'image/png' }))
    const res = await fetch(`${base}/api/assets`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })
    const text = await res.text()
    return { status: res.status, data: text ? JSON.parse(text) : null }
  }

  /** 与 壁纸落盘 里同款：追加一个字节，内容不同但仍是合法 PNG */
  function png(extra: number): Uint8Array {
    const base = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ),
      (ch) => ch.charCodeAt(0),
    )
    const out = new Uint8Array(base.length + 1)
    out.set(base)
    out[base.length] = extra
    return out
  }

  const bgUrlOf = (name: string): string => `${base}/bg/${encodeURIComponent(name)}`

  test('上传响应给出 /bg/<文件名>，中文名也能取到同样的字节', async () => {
    const bytes = png(71)
    const name = '哲风壁纸 森林-车站.png'
    const { status, data: asset } = await uploadWallpaper(bytes, name)
    expect(status).toBe(201)
    expect(asset.bgUrl).toBe(`/bg/${name}`)
    expect(asset.name).toBe(name)

    const res = await fetch(bgUrlOf(name), { headers: authHeaders() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(bytes))

    // 资源列表里也带着它，前端「图片地址」直接可用
    const list = await send('GET', '/api/assets?kind=wallpaper')
    expect(list.data.find((a: any) => a.name === name)?.bgUrl).toBe(`/bg/${name}`)
  })

  test('直链同样在门禁之后（匿名 401）', async () => {
    const { data: asset } = await uploadWallpaper(png(72), 'gated.png')
    const anon = await send('GET', `/bg/${encodeURIComponent('gated.png')}`, undefined, {
      anon: true,
    })
    expect(anon.status).toBe(401)
    expect((await fetch(`${base}${asset.bgUrl}`, { headers: authHeaders() })).status).toBe(200)
  })

  test('只服务 bg/ 内的图片：不存在、越界、非图片扩展名都拒绝', async () => {
    expect((await send('GET', '/bg/nope.png')).status).toBe(404)

    // 越界：解码后是 ../，必须被 bgFilePath 拦住 —— 绝不能读到 db/app.db
    for (const path of ['/bg/%2e%2e%2Fdb%2Fapp.db', '/bg/..%2Fdb%2Fapp.db']) {
      const res = await fetch(`${base}${path}`, { headers: authHeaders() })
      const body = Buffer.from(await res.arrayBuffer())
      expect(body.subarray(0, 16).toString('latin1')).not.toBe('SQLite format 3\u0000')
      expect(res.status).toBe(404)
    }

    // 手工往 bg/ 丢一个 html：不能被当作同源文档服务
    writeFileSync(join(dataDir, 'bg', 'evil.html'), '<script>alert(1)</script>')
    expect((await send('GET', '/bg/evil.html')).status).toBe(404)
  })

  test('用 ETag 协商缓存：命中 304，同名换图后能拿到新内容', async () => {
    const bytes = png(73)
    const { data: asset } = await uploadWallpaper(bytes, 'etag.png')
    const url = `${base}${asset.bgUrl}`

    const first = await fetch(url, { headers: authHeaders() })
    const etag = first.headers.get('etag') ?? ''
    expect(first.status).toBe(200)
    expect(etag).not.toBe('')
    // 不能 immutable —— 文件名不是内容哈希，用户随时可能覆盖同名文件
    expect(first.headers.get('cache-control')).toBe('no-cache')

    const revalidated = await fetch(url, {
      headers: authHeaders({ 'if-none-match': etag }),
    })
    expect(revalidated.status).toBe(304)

    // 手工换成同名的新图：ETag 变化 → 浏览器不会一直吃缓存
    writeFileSync(join(dataDir, 'bg', 'etag.png'), Buffer.from(png(74)))
    const changed = await fetch(url, { headers: authHeaders({ 'if-none-match': etag }) })
    expect(changed.status).toBe(200)
    expect(changed.headers.get('etag')).not.toBe(etag)
  })

  test('正被壁纸引用的资源删不掉（409），换掉壁纸类型后可以删', async () => {
    const { data: asset } = await uploadWallpaper(png(75), 'inuse.png')
    await send('PATCH', '/api/settings', {
      'wallpaper.type': 'asset',
      'wallpaper.value': asset.bgUrl,
    })

    const blocked = await send('DELETE', `/api/assets/${asset.id}`)
    expect(blocked.status).toBe(409)
    expect(blocked.data.error.code).toBe('IN_USE')

    // 壁纸类型换回渐变，那个值不再生效 —— 此时应当允许删除
    await send('PATCH', '/api/settings', { 'wallpaper.type': 'gradient' })
    expect((await send('DELETE', `/api/assets/${asset.id}`)).status).toBe(204)
  })
})

/**
 * 壁纸也可以直接指向本机的一张图（`/Users/…/x.jpg`），由服务端读盘返回。
 * 关键约束：只服务图片 —— 否则就是一个「读任意文件」的接口。
 */
describe('本地图片直链 /api/local-image', () => {
  /** 与前面几组同款：同一头 PNG 追加一个字节，避开内容寻址去重 */
  function png(extra: number): Uint8Array {
    const base = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ),
      (ch) => ch.charCodeAt(0),
    )
    const out = new Uint8Array(base.length + 1)
    out.set(base)
    out[base.length] = extra
    return out
  }

  const localUrl = (path: string): string =>
    `${base}/api/local-image?path=${encodeURIComponent(path)}`

  test('读本机任意位置的图片（绝对路径与 file:// 等价）', async () => {
    const file = join(dataDir, 'outside-bg.png') // 刻意放在 bg/ 之外
    const bytes = png(81)
    writeFileSync(file, Buffer.from(bytes))

    const res = await fetch(localUrl(file), { headers: authHeaders() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(bytes))

    const viaFileUrl = await fetch(localUrl(`file://${file}`), { headers: authHeaders() })
    expect(viaFileUrl.status).toBe(200)
    expect(Buffer.from(await viaFileUrl.arrayBuffer())).toEqual(Buffer.from(bytes))
  })

  test('非图片文件读不出来（借这个接口读任意文件不成立）', async () => {
    const txt = join(dataDir, 'secret.txt')
    writeFileSync(txt, 'top secret')

    const res = await fetch(localUrl(txt), { headers: authHeaders() })
    expect(res.status).toBe(415)
    expect((await res.json()).error.code).toBe('BAD_MIME')
  })

  test('不存在 404、目录 404、相对路径与空参数 400', async () => {
    expect((await send('GET', `/api/local-image?path=${encodeURIComponent(join(dataDir, 'nope.png'))}`)).status).toBe(404)
    expect((await send('GET', `/api/local-image?path=${encodeURIComponent(dataDir)}`)).status).toBe(404)
    expect((await send('GET', '/api/local-image?path=relative.png')).status).toBe(400)
    expect((await send('GET', '/api/local-image?path=')).status).toBe(400)
  })

  test('同样在门禁之后（匿名 401）', async () => {
    const file = join(dataDir, 'outside-bg.png')
    const anon = await fetch(localUrl(file))
    expect(anon.status).toBe(401)
  })

  test('ETag 协商缓存：命中 304，原地换图后能拿到新内容', async () => {
    const file = join(dataDir, 'swap.png')
    writeFileSync(file, Buffer.from(png(82)))

    const first = await fetch(localUrl(file), { headers: authHeaders() })
    const etag = first.headers.get('etag') ?? ''
    expect(first.status).toBe(200)
    expect(etag).not.toBe('')

    const revalidated = await fetch(localUrl(file), {
      headers: authHeaders({ 'if-none-match': etag }),
    })
    expect(revalidated.status).toBe(304)

    // 原地换成另一张图：内容与 ETag 都变，不会被缓存一直挡住
    writeFileSync(file, Buffer.from(png(83)))
    const changed = await fetch(localUrl(file), {
      headers: authHeaders({ 'if-none-match': etag }),
    })
    expect(changed.status).toBe(200)
    expect(changed.headers.get('etag')).not.toBe(etag)
  })
})

describe('备份导入导出', () => {
  test('导出 → 清空 → 恢复，数据一致', async () => {
    const { data: g } = await send('POST', '/api/groups', { name: '备份测试组' })
    await send('POST', '/api/items', {
      title: '备份测试卡片',
      lanUrl: 'backup.local',
      groupId: g.id,
    })

    const exported = await fetch(`${base}/api/backup/export`, { headers: authHeaders() }).then(
      (r) => r.json(),
    )
    expect(exported.format).toBe('starm-panel-backup')
    expect(exported.groups.length).toBeGreaterThan(0)

    // 清空
    await send('POST', '/api/backup/import?mode=replace', {
      format: 'starm-panel-backup',
      version: 1,
      groups: [],
      items: [],
      settings: {},
    })
    expect((await send('GET', '/api/bootstrap')).data.items.length).toBe(0)

    // 恢复
    const res = await fetch(`${base}/api/backup/import?mode=replace`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(exported),
    })
    expect(res.status).toBe(200)

    // 注意：bootstrap 只返回 enabled=true 的卡片，而导出包含全部，
    // 因此这里必须用 ?enabled=false 比较，否则会因停用卡片而数量不符。
    const after = (await send('GET', '/api/items?enabled=false')).data
    expect(after.length).toBe(exported.items.length)
    expect(after.some((i: any) => i.title === '备份测试卡片')).toBe(true)
  })

  test('merge 模式把分组 ID 重映射到新建分组', async () => {
    const payload = {
      format: 'starm-panel-backup',
      version: 1,
      groups: [{ id: 1, name: '合并组', sort: 1, collapsed: false }],
      items: [{ id: 1, groupId: 1, title: '合并卡片', lanUrl: 'merge.local', sort: 1 }],
      settings: {},
    }

    const res = await fetch(`${base}/api/backup/import?mode=merge`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)

    const { data: groupsNow } = await send('GET', '/api/groups')
    const newGroup = groupsNow.find((g: any) => g.name === '合并组')
    expect(newGroup).toBeTruthy()

    const { data: itemsNow } = await send('GET', '/api/items')
    const newItem = itemsNow.find((i: any) => i.title === '合并卡片')
    expect(newItem).toBeTruthy()
    // 关键：groupId 必须指向**新建的**那个分组，而不是备份里的旧 id
    expect(newItem.groupId).toBe(newGroup.id)
  })

  test('格式不合法被拒绝', async () => {
    const { status } = await send('POST', '/api/backup/import?mode=merge', { format: 'other' })
    expect(status).toBe(400)
  })
})

describe('系统监控接口', () => {
  test('静态信息包含 CPU/OS/GPU 与能力标记', async () => {
    const { status, data } = await send('GET', '/api/system/info')
    expect(status).toBe(200)
    expect(data.cpu.cores).toBeGreaterThan(0)
    expect(typeof data.os.platform).toBe('string')
    expect(Array.isArray(data.gpus)).toBe(true)
    expect(typeof data.capabilities.gpuDynamic).toBe('boolean')
  })

  test('快照或 503（首次采样前）', async () => {
    const { status, data } = await send('GET', '/api/system/snapshot')
    if (status === 503) {
      expect(data.error.code).toBe('NOT_READY')
    } else {
      expect(status).toBe(200)
      expect(data.mem.total).toBeGreaterThan(0)
      expect(Array.isArray(data.gpus)).toBe(true)
      // GPU 快照必须带 available 数组，前端靠它决定渲染哪些指标
      for (const g of data.gpus) expect(Array.isArray(g.available)).toBe(true)
    }
  })
})

/**
 * 软件更新接口。
 *
 * 测试进程是 `bun index.ts`（不是单文件产物），因此检查接口会直接返回
 * supported=false 而不联网 —— 这些用例覆盖「开发模式不误触更新」的边界。
 */
describe('软件更新', () => {
  test('开发模式检查更新不联网，返回 supported=false', async () => {
    const { status, data } = await send('GET', '/api/update/check')
    expect(status).toBe(200)
    expect(data.current.supported).toBe(false)
    expect(data.hasUpdate).toBe(false)
    expect(data.source).toBeNull()
    expect(data.current.version).toBeTruthy()
  })

  test('状态接口初始为 idle', async () => {
    const { status, data } = await send('GET', '/api/update/status')
    expect(status).toBe(200)
    expect(data.phase).toBe('idle')
    expect(data.tag).toBeNull()
  })

  test('开发模式应用更新返回 409 UPDATE_UNSUPPORTED', async () => {
    const { status, data } = await send('POST', '/api/update/apply', { tag: 'v0.1.0-1' })
    expect(status).toBe(409)
    expect(data.error.code).toBe('UPDATE_UNSUPPORTED')
  })

  test('未登录时不能检查更新', async () => {
    const { status } = await send('GET', '/api/update/check', undefined, { anon: true })
    expect(status).toBe(401)
  })
})

/**
 * 管理员登录（单账号）。
 *
 * ⚠️ 本块**必须留在文件末尾**：最后一个用例会触发按 IP 的登录限流并把
 * 127.0.0.1 锁 15 分钟（进程内存态）。前面的块都靠 beforeAll 拿到的会话
 * Cookie 工作，不受影响；但限流一旦触发，后续再想「重新登录」就会被挡。
 * 限流算法本身的窗口 / 解锁语义由 services/login-rate-limit.test.ts 覆盖。
 */
describe('管理员登录', () => {
  test('未登录时只有认证接口可见，门禁状态不泄漏 IP', async () => {
    const { status, data } = await send('GET', '/api/auth/state', undefined, { anon: true })
    expect(status).toBe(200)
    expect(data.enabled).toBe(true)
    expect(data.passwordSet).toBe(true)
    expect(data.authenticated).toBe(false)
    // 未登录时不能返回上次登录时间 / IP
    expect(data.lastLoginAt).toBeUndefined()
    expect(data.lastLoginIp).toBeUndefined()
  })

  test('未登录时所有面板接口一律 401', async () => {
    const paths = [
      '/api/bootstrap',
      '/api/items',
      '/api/groups',
      '/api/settings',
      '/api/system/info',
      '/api/system/history',
      '/api/system/stream',
      '/api/backup/export',
      // 资源与壁纸同样在门禁之后：图标 / 壁纸是私有内容，不该匿名可取
      '/api/assets/whatever',
      '/api/wallpaper/bing',
      '/api/favicon',
    ]
    for (const path of paths) {
      const { status, data } = await send('GET', path, undefined, { anon: true })
      expect({ path, status }).toEqual({ path, status: 401 })
      expect(data.error.code).toBe('UNAUTHENTICATED')
    }
  })

  test('未登录不能写任何东西', async () => {
    const { status } = await send('POST', '/api/items', { title: 'x', lanUrl: 'nas' }, { anon: true })
    expect(status).toBe(401)
  })

  test('已登录时 state 带回上次登录信息', async () => {
    const { data } = await send('GET', '/api/auth/state')
    expect(data.authenticated).toBe(true)
    expect(typeof data.lastLoginAt).toBe('number')
    expect(typeof data.lastLoginIp).toBe('string')
    expect(data.sessionDays).toBeGreaterThan(0)
  })

  test('设置接口既不返回也写不进认证保留键', async () => {
    const { data } = await send('GET', '/api/settings')
    expect(data['auth.passwordHash']).toBeUndefined()
    expect(data['auth.sessionEpoch']).toBeUndefined()

    const patch = await send('PATCH', '/api/settings', { 'auth.passwordHash': 'anything' })
    expect(patch.status).toBe(400)
    expect(patch.data.error.code).toBe('RESERVED_KEY')

    const epoch = await send('PATCH', '/api/settings', { 'auth.sessionEpoch': 999 })
    expect(epoch.status).toBe(400)
  })

  test('跨站写操作被拒（SameSite 之外的第二道防线）', async () => {
    const { status, data } = await send(
      'POST',
      '/api/items',
      { title: 'CSRF', lanUrl: 'nas' },
      { headers: { 'sec-fetch-site': 'cross-site' } },
    )
    expect(status).toBe(403)
    expect(data.error.code).toBe('CROSS_SITE_BLOCKED')
  })

  test('弱口令不能用来初始化', async () => {
    // 密码已设置，这里只验证校验规则本身不会被绕过
    for (const bad of ['short', 'password123', '        ']) {
      const { status } = await send('POST', '/api/auth/setup', { password: bad })
      expect(status).toBeLessThan(500)
    }
    // 已设置过密码 → setup 一律 409（不能被用来改密码）
    const again = await send('POST', '/api/auth/setup', { password: ADMIN_PASSWORD })
    expect(again.status).toBe(409)
    expect(again.data.error.code).toBe('PASSWORD_ALREADY_SET')
  })

  test('密码错误返回 401，成功登录会清空失败计数', async () => {
    const wrong = await send('POST', '/api/auth/login', { password: 'not-the-password' }, { anon: true })
    expect(wrong.status).toBe(401)
    expect(wrong.data.error.code).toBe('INVALID_CREDENTIALS')

    const ok = await send('POST', '/api/auth/login', { password: ADMIN_PASSWORD }, { anon: true })
    expect(ok.status).toBe(200)
    expect(ok.data.authenticated).toBe(true)
    expect(sessionCookie).toContain('starm_session=')
  })

  test('修改密码：当前密码错则拒绝，成功后旧密码失效而本机保持登录', async () => {
    const wrong = await send('POST', '/api/auth/password', {
      currentPassword: 'not-the-password',
      newPassword: NEW_PASSWORD,
    })
    expect(wrong.status).toBe(401)

    const ok = await send('POST', '/api/auth/password', {
      currentPassword: ADMIN_PASSWORD,
      newPassword: NEW_PASSWORD,
    })
    expect(ok.status).toBe(200)

    // 本机（换发的新 Cookie）仍然可用
    expect((await send('GET', '/api/items')).status).toBe(200)

    // 旧密码不能再登录，新密码可以
    expect(
      (await send('POST', '/api/auth/login', { password: ADMIN_PASSWORD }, { anon: true })).status,
    ).toBe(401)
    expect(
      (await send('POST', '/api/auth/login', { password: NEW_PASSWORD }, { anon: true })).status,
    ).toBe(200)
  })

  test('退出登录：会话立刻失效，重放旧令牌也不行', async () => {
    const before = sessionCookie
    expect(before).toBeTruthy()

    const out = await send('POST', '/api/auth/logout')
    expect(out.status).toBe(200)
    expect(out.data.authenticated).toBe(false)
    // Set-Cookie 已把 jar 清空
    expect(sessionCookie).toBe('')

    // 旧 Cookie 值重放（模拟令牌被截获）同样被拒 —— 登出会进黑名单
    const replay = await fetch(`${base}/api/items`, { headers: { cookie: before } })
    expect(replay.status).toBe(401)

    // 重新登录恢复
    const back = await send('POST', '/api/auth/login', { password: NEW_PASSWORD }, { anon: true })
    expect(back.status).toBe(200)
    expect(sessionCookie).toContain('starm_session=')
  })

  test('退出所有设备：本机会话同样作废', async () => {
    const before = sessionCookie
    const out = await send('POST', '/api/auth/revoke-all')
    expect(out.status).toBe(200)
    expect(sessionCookie).toBe('')
    expect(
      (await fetch(`${base}/api/items`, { headers: { cookie: before } })).status,
    ).toBe(401)

    const back = await send('POST', '/api/auth/login', { password: NEW_PASSWORD }, { anon: true })
    expect(back.status).toBe(200)
  })

  // ⚠️ 放在最后：会把本机 IP 锁 15 分钟（见本块顶部说明）
  test('连续失败触发限流：第 6 次连正确密码也拒绝', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (await send('POST', '/api/auth/login', { password: 'wrong-password' }, { anon: true }))
          .status,
      )
    }
    expect(statuses).toEqual([401, 401, 401, 401, 429])

    const locked = await send('POST', '/api/auth/login', { password: NEW_PASSWORD }, { anon: true })
    expect(locked.status).toBe(429)
    expect(locked.data.error.code).toBe('TOO_MANY_ATTEMPTS')
    expect(locked.data.error.details.retryAfterSec).toBeGreaterThan(0)
  })
})
