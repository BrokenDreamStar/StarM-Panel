import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getStaticInfo } from '../services/system-info'
import { monitor } from '../services/monitor'
import { scheduleRestart } from '../services/restart'

export const systemRoutes = new Hono()
  // 静态信息（CPU 型号、OS、磁盘布局、GPU 列表、显示器）
  .get('/info', async (c) => {
    return c.json(await getStaticInfo())
  })

  // 最新一次快照（用于 SSE 不可用时的轮询降级）
  .get('/snapshot', (c) => {
    const snap = monitor.latest()
    if (!snap) return c.json({ error: { code: 'NOT_READY', message: '尚未完成首次采样' } }, 503)
    return c.json(snap)
  })

  // 环形缓冲全量（页面重新聚焦时补齐趋势图）
  .get('/history', (c) => c.json(monitor.history()))

  // 重启面板进程。先回响应、200ms 后才真正关停并拉起新进程，
  // 所以前端拿到 200 只代表「已受理」，是否起来要自己轮询 /healthz（见 services/restart）
  .post('/restart', (c) => c.json({ ok: true, ...scheduleRestart() }))

  // 实时推送
  .get('/stream', (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false

      const unsubscribe = monitor.subscribe((snap) => {
        if (closed) return
        // 不 await：写失败由 onAbort 统一清理，避免阻塞采样循环
        void stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snap) })
      })

      // 心跳：防止中间代理因空闲而断开长连接
      const heartbeat = setInterval(() => {
        if (closed) return
        void stream.writeSSE({ event: 'ping', data: String(Date.now()) })
      }, 15_000)

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          closed = true
          clearInterval(heartbeat)
          unsubscribe()
          resolve()
        })
      })
    })
  })
