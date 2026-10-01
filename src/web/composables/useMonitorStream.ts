/**
 * 监控数据流 composable —— SSE 订阅 + 自动重连 + 页面可见性联动。
 *
 * 关键行为：
 *   - EventSource('/api/system/stream')，监听 `snapshot` / `ping` 事件
 *   - 断线后指数退避重连（1s → 2s → 4s … 上限 30s），连接成功后重置
 *   - 页面隐藏时**保持连接**（服务端会因订阅者减少而自动降频到 hiddenInterval），
 *     但暂停向图表追加历史点；重新可见时用一次 REST 快照补齐
 *   - 组件卸载 / scope 销毁时关闭连接并清理定时器
 *
 * 服务端 SSE 已带 15s 心跳，正常情况下不会进入重连分支。
 */
import { onScopeDispose, watch } from 'vue'
import { useMonitorStore } from '@/stores/monitor'
import type { SystemSnapshot } from '@shared/types'

const BASE_DELAY = 1_000
const MAX_DELAY = 30_000

export function useMonitorStream() {
  const store = useMonitorStore()

  let es: EventSource | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

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
      store.error = '监控连接已断开，正在重连…'
      scheduleReconnect()
    })
  }

  function start(): void {
    if (stopped) return
    stopped = false
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

  // 首次进入即拉静态信息（监控面板需要静态卡兜底）
  void store.loadStaticInfo()

  // 图表重绘依赖 store.visible，这里同步一次初始值
  store.visible = !document.hidden

  watch(
    () => store.visible,
    (v) => {
      if (v) void store.refresh()
    },
  )

  onScopeDispose(() => {
    document.removeEventListener('visibilitychange', onVisibility)
    stop()
  })

  return { start, stop, store }
}
