/**
 * 分组 CRUD。
 *
 * 删除分组时组内卡片 group_id 被外键置为 NULL（ON DELETE SET NULL），
 * **不级联删除卡片** —— 这是刻意的：用户删分组通常只是想取消归类。
 */
import { Hono } from 'hono'
import { jsonBody } from '../middleware/validate'
import { asc, eq } from 'drizzle-orm'
import { db } from '../db'
import { groups } from '../db/schema'
import { toGroup } from '../db/mappers'
import {
  GroupCreateSchema,
  GroupReorderSchema,
  GroupUpdateSchema,
} from '@shared/schemas'
import { HttpError } from '../middleware/error'

export const groupRoutes = new Hono()

function nextSort(): number {
  const rows = db.select({ sort: groups.sort }).from(groups).orderBy(asc(groups.sort)).all()
  const max = rows.length > 0 ? rows[rows.length - 1]!.sort : 0
  return max + 10
}

groupRoutes
  .get('/', (c) => {
    const rows = db.select().from(groups).orderBy(asc(groups.sort), asc(groups.id)).all()
    return c.json(rows.map(toGroup))
  })

  .post('/', jsonBody(GroupCreateSchema), (c) => {
    const body = c.req.valid('json')
    const now = Date.now()

    const row = db
      .insert(groups)
      .values({
        name: body.name,
        icon: body.icon,
        sort: body.sort ?? nextSort(),
        collapsed: body.collapsed ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()

    return c.json(toGroup(row), 201)
  })

  .patch('/:id', jsonBody(GroupUpdateSchema), (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'BAD_ID', '分组 ID 非法')

    const body = c.req.valid('json')
    const now = Date.now()

    const row = db
      .update(groups)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.icon !== undefined && { icon: body.icon }),
        ...(body.sort !== undefined && { sort: body.sort }),
        ...(body.collapsed !== undefined && { collapsed: body.collapsed }),
        updatedAt: now,
      })
      .where(eq(groups.id, id))
      .returning()
      .get()

    if (!row) throw new HttpError(404, 'NOT_FOUND', `分组 ${id} 不存在`)
    return c.json(toGroup(row))
  })

  .delete('/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'BAD_ID', '分组 ID 非法')

    const row = db.delete(groups).where(eq(groups.id, id)).returning().get()
    if (!row) throw new HttpError(404, 'NOT_FOUND', `分组 ${id} 不存在`)
    return c.body(null, 204)
  })

  .post('/reorder', jsonBody(GroupReorderSchema), (c) => {
    const { order } = c.req.valid('json')
    const now = Date.now()

    db.transaction((tx) => {
      for (const o of order) {
        tx.update(groups).set({ sort: o.sort, updatedAt: now }).where(eq(groups.id, o.id)).run()
      }
    })

    const rows = db.select().from(groups).orderBy(asc(groups.sort), asc(groups.id)).all()
    return c.json(rows.map(toGroup))
  })
