/**
 * 软件更新接口。
 *
 *   GET  /api/update/check   查询 GitHub 最新 Release 与当前版本比较
 *   GET  /api/update/status  查询进行中的更新进度（前端轮询）
 *   POST /api/update/apply   开始下载并替换程序；完成后自动重启
 *
 * 「检查」与「应用」都只认服务端算出来的同一条 Release 记录，
 * 客户端传的 tag 只用来防止「看到的是 A、下的是 B」的竞态。
 */
import { Hono } from 'hono'
import { UpdateApplySchema } from '@shared/schemas'
import { jsonBody } from '../middleware/validate'
import { checkForUpdate, getUpdateState, startUpdate } from '../services/update'

export const updateRoutes = new Hono()
  .get('/check', async (c) => c.json(await checkForUpdate()))

  .get('/status', (c) => c.json(getUpdateState()))

  .post('/apply', jsonBody(UpdateApplySchema), async (c) => {
    const { tag } = c.req.valid('json')
    // 202：只表示「已受理」，下载进度看 /status
    return c.json({ ok: true, ...(await startUpdate(tag)) }, 202)
  })
