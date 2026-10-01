/**
 * favicon 抓取接口。
 */
import { Hono } from 'hono'
import { jsonBody } from '../middleware/validate'
import { FaviconRequestSchema } from '@shared/schemas'
import { fetchFavicon } from '../services/favicon'

export const faviconRoutes = new Hono().post(
  '/',
  jsonBody(FaviconRequestSchema),
  async (c) => {
    const { url } = c.req.valid('json')
    const asset = await fetchFavicon(url)
    return c.json({ assetId: asset.id, url: `/api/assets/${asset.id}` })
  },
)
