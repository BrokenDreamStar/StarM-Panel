/**
 * 端到端 API 集成测试。
 *
 * 启动**真实的服务器进程**（而不是 in-process 调用 app.request），
 * 覆盖数据库、中间件、路由、后台服务的真实组合行为。
 *
 * 运行：bun test
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let proc: ReturnType<typeof Bun.spawn>
let base: string
let dataDir: string

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

/** POST/PATCH 的 JSON 便捷封装 */
async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
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
    expect(data.authRequired).toBe(false)
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
    const res = await fetch(`${base}/api/assets`, { method: 'POST', body: form })
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

    const res = await fetch(`${base}${data.url}`)
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

    const res = await fetch(`${base}${data.url}`)
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

describe('备份导入导出', () => {
  test('导出 → 清空 → 恢复，数据一致', async () => {
    const { data: g } = await send('POST', '/api/groups', { name: '备份测试组' })
    await send('POST', '/api/items', {
      title: '备份测试卡片',
      lanUrl: 'backup.local',
      groupId: g.id,
    })

    const exported = await fetch(`${base}/api/backup/export`).then((r) => r.json())
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
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
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
