/**
 * 内网可达性探测接口。
 *
 * 前端「自动」模式依赖 /status 的结果来决定每张卡片走内网还是外网。
 */
import { Hono } from 'hono'
import { jsonBody } from '../middleware/validate'
import { ProbeCheckSchema } from '@shared/schemas'
import { probe } from '../services/probe'

export const probeRoutes = new Hono()
  /** 全部卡片的探测结果缓存，前端轮询这个 */
  .get('/status', (c) => c.json(probe.getStatus()))

  /** 立即触发一轮全量探测（设置页的「重新探测」按钮、切换模式时预热） */
  .post('/refresh', async (c) => {
    await probe.refreshAll()
    return c.json(probe.getStatus())
  })

  /** 探测任意一个地址，供卡片编辑器的「测试」按钮使用 */
  .post('/check', jsonBody(ProbeCheckSchema), async (c) => {
    const { url } = c.req.valid('json')
    return c.json(await probe.checkUrl(url))
  })
