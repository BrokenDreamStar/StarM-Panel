/**
 * 监控数据流的生命周期单测。
 *
 * 这里固化两条曾经把它打死的规则：
 *   1. **登录前不建连、不发请求** —— SSE 与快照接口都在门禁后面，未登录时的
 *      401 会广播 `starm:auth-required`，把外壳推回锁屏；
 *   2. **stop() 之后还能 start()** —— 登录 → 登出 / 会话过期 → 再登录 是常态，
 *      旧实现里 `start()` 开头就 `if (stopped) return`，第二次登录只能看到 `—`，
 *      必须手动刷新页面才有数据。
 *
 * 浏览器 API（EventSource / document / fetch）在这里都是最小的替身，
 * 断言的是「有没有建连、有没有发请求」，不是 SSE 的协议细节。
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { useMonitorStore } from '@/stores/monitor'
import { useMonitorStream } from './useMonitorStream'

// ── 浏览器替身 ───────────────────────────────────────────────

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  readonly url: string
  readyState = FakeEventSource.CONNECTING
  readonly listeners = new Map<string, Array<() => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }
}

interface FakeDocument {
  hidden: boolean
  listeners: Set<() => void>
  addEventListener: (type: string, fn: () => void) => void
  removeEventListener: (type: string, fn: () => void) => void
}

function makeDocument(): FakeDocument {
  const doc: FakeDocument = {
    hidden: false,
    listeners: new Set(),
    addEventListener(type, fn) {
      if (type === 'visibilitychange') doc.listeners.add(fn)
    },
    removeEventListener(type, fn) {
      if (type === 'visibilitychange') doc.listeners.delete(fn)
    },
  }
  return doc
}

/** 最小可用快照：pushSnapshot 只读这几个字段 */
const SNAPSHOT = {
  ts: 1,
  cpu: { usage: 12 },
  mem: { total: 100, used: 50, swapTotal: 0, swapUsed: 0 },
  net: [],
}

let fetched: string[] = []
let doc: FakeDocument

beforeEach(() => {
  FakeEventSource.instances = []
  fetched = []
  doc = makeDocument()
  globalThis.document = doc as unknown as Document
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input))
    return new Response(JSON.stringify(SNAPSHOT), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  setActivePinia(createPinia())
})

/** 挂到独立 scope 上，方便断言 onScopeDispose 的行为 */
function mount() {
  const scope = effectScope()
  const stream = scope.run(() => useMonitorStream())!
  return { scope, stream }
}

// ── 用例 ─────────────────────────────────────────────────────

describe('useMonitorStream 生命周期', () => {
  test('认证门禁放行之前不建连、不发请求', () => {
    const { stream } = mount()

    expect(FakeEventSource.instances).toHaveLength(0)

    // 登录页也会收到 visibilitychange —— 它不能换来一次 401 请求
    doc.hidden = false
    for (const listener of doc.listeners) listener()
    expect(fetched).toHaveLength(0)
    expect(useMonitorStore().status).toBe('idle')

    stream.stop()
  })

  test('start 之后建立 SSE 连接', () => {
    const { stream } = mount()

    stream.start()

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]!.url).toBe('/api/system/stream')
    expect(useMonitorStore().status).toBe('connecting')

    stream.stop()
  })

  test('stop 之后再次 start 能重新建连（登录 → 登出 → 再登录）', () => {
    const { stream } = mount()

    stream.start()
    expect(FakeEventSource.instances).toHaveLength(1)

    stream.stop()
    expect(FakeEventSource.instances[0]!.readyState).toBe(FakeEventSource.CLOSED)
    expect(useMonitorStore().status).toBe('closed')

    stream.start()
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1]!.readyState).toBe(FakeEventSource.CONNECTING)

    stream.stop()
  })

  test('重复 start 不会叠加连接', () => {
    const { stream } = mount()

    stream.start()
    stream.start()

    expect(FakeEventSource.instances).toHaveLength(1)
    stream.stop()
  })

  test('重新可见时补拉一次快照，并在连接已关闭时重连', async () => {
    const { stream } = mount()
    stream.start()
    const first = FakeEventSource.instances[0]!

    // 模拟「后台很久之后 EventSource 被浏览器静默关闭」
    first.readyState = FakeEventSource.CLOSED
    doc.hidden = false
    for (const listener of doc.listeners) listener()
    // refresh() 是异步的：等它把快照写进 store
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetched).toEqual(['/api/system/snapshot'])
    expect(useMonitorStore().latest).not.toBeNull()
    expect(FakeEventSource.instances).toHaveLength(2)

    stream.stop()
  })

  test('scope 销毁后停掉连接，且不再接受 start', () => {
    const { scope, stream } = mount()
    stream.start()
    const source = FakeEventSource.instances[0]!

    scope.stop()
    expect(source.readyState).toBe(FakeEventSource.CLOSED)
    expect(doc.listeners.size).toBe(0)

    stream.start()
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})
