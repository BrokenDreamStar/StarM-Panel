/**
 * 监控数据流 composable —— SSE 订阅 + 自动重连 + 页面可见性联动。
 *
 * 关键行为：
 *   - 由外壳在**认证门禁放行之后**调用 start()；未 start 前不建连、不发请求
 *     （登录页没有会话，SSE / 快照接口都只会返回 401）
 *   - EventSource('/api/system/stream')，监听 `snapshot` / `ping` 事件
 *   - 断线后指数退避重连（1s → 2s → 4s … 上限 30s），连接成功后重置
 *   - 页面隐藏时**保持连接**（服务端会因订阅者减少而自动降频到 hiddenInterval），
 *     但暂停向图表追加历史点；重新可见时用一次 REST 快照补齐
 *   - stop() 之后可以再次 start()（登出 → 重新登录要走这条路）
 *   - 组件卸载 / scope 销毁时关闭连接并清理定时器
 *
 * 服务端 SSE 已带 15s 心跳，正常情况下不会进入重连分支。
 */
import { onScopeDispose, watch } from 'vue'
import { useMonitorStore } from '@/stores/monitor'
import { TEXT as T } from '@shared/text'
import type { SystemSnapshot } from '@shared/types'

const BASE_DELAY = 1_000
const MAX_DELAY = 30_000

export function useMonitorStream() {
  const store = useMonitorStore()

  let es: EventSource | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 是否处于「已停止」状态。初始为 true：**登录页不该建连**。
   *
   * `/api/system/stream` 挂在门禁后面，未登录时连上去只会拿到 401，
   * 而 401 又会触发全局 `starm:auth-required` 事件 —— 外壳据此把面板打回锁屏，
   * 顺带停掉数据流。以前这个标志初始化成 false，于是 `start()` 在
   * 「先 stop 过」（登录前的 401、登出、会话过期）之后永远直接 return，
   * 重新登录也只能显示 `—`，直到手动刷新页面 —— 那是一次完整的
   * 「新建 composable → start()」的新生命周期才绕过的坑。
   */
  let stopped = true
  /** scope 已销毁（组件卸载）：之后即使有人再调 start 也不该建连 */
  let disposed = false

  function clearRetry(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function closeSource(): void {
    if (es) {
      es.close()
      es = null
    }
  }

  /** 指数退避：1s, 2s, 4s, … 30s（带 ±20% 抖动，避免多标签同时重连） */
  function scheduleReconnect(): void {
    if (stopped || retryTimer !== null) return
    const attempt = store.retryCount
    const delay = Math.min(BASE_DELAY * 2 ** attempt, MAX_DELAY)
    const jittered = Math.round(delay * (0.8 + Math.random() * 0.4))
    store.retryCount = attempt + 1
    store.status = 'retrying'
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, jittered)
  }

  function connect(): void {
    if (stopped) return
    closeSource()
    store.status = store.status === 'idle' ? 'connecting' : store.status
    store.status = 'connecting'

    let source: EventSource
    try {
      source = new EventSource('/api/system/stream')
    } catch {
      scheduleReconnect()
      return
    }
    es = source

    source.addEventListener('open', () => {
      if (es !== source) return
      store.status = 'open'
      store.retryCount = 0
      store.error = null
    })

    source.addEventListener('snapshot', (event) => {
      if (es !== source) return
      const data = (event as MessageEvent<string>).data
      try {
        const snap = JSON.parse(data) as SystemSnapshot
        store.pushSnapshot(snap)
      } catch {
        // 忽略畸形帧，不中断连接
      }
    })

    // 心跳：只用于确认链路存活
    source.addEventListener('ping', () => {
      if (es !== source) return
      store.lastMessageAt = Date.now()
    })

    source.addEventListener('error', () => {
      if (es !== source) return
      // EventSource 自身也会重连；这里主动接管以获得指数退避
      closeSource()
      store.error = T.monitor.disconnected
      scheduleReconnect()
    })
  }

  function start(): void {
    // 已经在跑就不重复建连：retryBoot / 重复的 enterApp 都会再次调用 start
    if (disposed || !stopped) return
    stopped = false
    // 新生命周期从干净状态开始：退避计数与可见性都按当前页面重新取
    store.retryCount = 0
    store.visible = !document.hidden
    connect()
  }

  function stop(): void {
    stopped = true
    clearRetry()
    closeSource()
    store.status = 'closed'
  }

  // 页面可见性：隐藏时暂停历史采集，回到前台立刻补齐一次
  function onVisibility(): void {
    // 未 start（登录页 / 已登出）时不做任何事 —— 这一层没有会话，
    // 请求只会拿到 401，反过来把外壳推回锁屏
    if (stopped) return
    const isVisible = !document.hidden
    store.visible = isVisible
    if (isVisible) {
      void store.refresh()
      // 长时间后台后 EventSource 可能已被浏览器静默关闭
      if (es === null || es.readyState === EventSource.CLOSED) {
        store.retryCount = 0
        connect()
      }
    }
  }

  document.addEventListener('visibilitychange', onVisibility)

  // 图表重绘依赖 store.visible，这里同步一次初始值（不触发任何请求）
  store.visible = !document.hidden

  watch(
    () => store.visible,
    (v) => {
      if (!stopped && v) void store.refresh()
    },
  )

  onScopeDispose(() => {
    disposed = true
    document.removeEventListener('visibilitychange', onVisibility)
    stop()
  })

  return { start, stop, store }
}
