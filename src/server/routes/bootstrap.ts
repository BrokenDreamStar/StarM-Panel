/**
 * 首屏数据聚合接口。
 *
 * 前端只需一次请求即可完成首屏渲染，避免 bootstrap → groups → items → settings
 * 的瀑布式请求。
 */
import { Hono } from 'hono'
import os from 'node:os'
import { asc, eq } from 'drizzle-orm'
import { db } from '../db'
import { groups, items } from '../db/schema'
import { toGroup, toItem } from '../db/mappers'
import { getAllSettings } from '../services/settings'
import type { BootstrapPayload } from '@shared/types'

const VERSION = '0.1.0'

export const bootstrapRoutes = new Hono().get('/', (c) => {
  const groupRows = db.select().from(groups).orderBy(asc(groups.sort), asc(groups.id)).all()
  const itemRows = db
    .select()
    .from(items)
    .where(eq(items.enabled, true))
    .orderBy(asc(items.sort), asc(items.id))
    .all()

  const payload: BootstrapPayload = {
    version: VERSION,
    groups: groupRows.map(toGroup),
    items: itemRows.map(toItem),
    settings: getAllSettings(),
    // 访问口令尚未实现（M5），固定 false
    authRequired: false,
    platform: {
      os: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
    },
  }

  return c.json(payload)
})
