/**
 * 卡片 CRUD 与排序。
 *
 * 关键不变量：**lanUrl 与 wanUrl 至少有一个非空**。
 * 创建时由 ItemCreateSchema 强制；更新时是部分更新，可能只改其中一个字段，
 * 因此在这里读取既有记录、合并后再校验。
 */
import { Hono } from 'hono'
import { jsonBody } from '../middleware/validate'
import { asc, eq, inArray, isNull } from 'drizzle-orm'
import { db, sqlite } from '../db'
import { items } from '../db/schema'
import { toItem } from '../db/mappers'
import {
  ItemCreateSchema,
  ItemReorderSchema,
  ItemUpdateSchema,
} from '@shared/schemas'
import { HttpError } from '../middleware/error'
import { probe } from '../services/probe'

export const itemRoutes = new Hono()

function parseId(raw: string | undefined): number {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'BAD_ID', '卡片 ID 非法')
  }
  return id
}

function nextSortIn(groupId: number | null): number {
  const rows = db
    .select({ sort: items.sort })
    .from(items)
    // group_id = NULL 在 SQL 中永不成立，未分组必须用 IS NULL
    .where(groupId === null ? isNull(items.groupId) : eq(items.groupId, groupId))
    .orderBy(asc(items.sort))
    .all()
  const max = rows.length > 0 ? rows[rows.length - 1]!.sort : 0
  return max + 10
}

/** 分组是否真实存在（避免写入悬空外键；SQLite 外键开启时会直接报错） */
function assertGroupExists(groupId: number | null): void {
  if (groupId === null) return
  const row = sqlite.prepare('SELECT id FROM groups WHERE id = ?').get(groupId)
  if (!row) throw new HttpError(400, 'GROUP_NOT_FOUND', `分组 ${groupId} 不存在`)
}

itemRoutes
  .get('/', (c) => {
    const groupIdParam = c.req.query('groupId')
    const onlyEnabled = c.req.query('enabled') !== 'false'

    const base = db.select().from(items)
    const rows = (
      groupIdParam !== undefined
        ? base.where(eq(items.groupId, Number(groupIdParam)))
        : base
    )
      .orderBy(asc(items.sort), asc(items.id))
      .all()

    const list = rows.map(toItem).filter((i) => (onlyEnabled ? i.enabled : true))
    return c.json(list)
  })

  .get('/:id', (c) => {
    const id = parseId(c.req.param('id'))
    const row = db.select().from(items).where(eq(items.id, id)).get()
    if (!row) throw new HttpError(404, 'NOT_FOUND', `卡片 ${id} 不存在`)
    return c.json(toItem(row))
  })

  .post('/', jsonBody(ItemCreateSchema), (c) => {
    const body = c.req.valid('json')
    assertGroupExists(body.groupId)

    const now = Date.now()
    const row = db
      .insert(items)
      .values({
        groupId: body.groupId,
        title: body.title,
        subtitle: body.subtitle,
        iconType: body.iconType,
        iconValue: body.iconValue,
        iconColor: body.iconColor,
        bgColor: body.bgColor,
        lanUrl: body.lanUrl,
        wanUrl: body.wanUrl,
        networkPref: body.networkPref,
        sort: body.sort ?? nextSortIn(body.groupId),
        enabled: body.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()

    // 立即探测一次内网地址，不必等下一轮全量调度
    void probe.refreshOne(row.id)

    return c.json(toItem(row), 201)
  })

  .patch('/:id', jsonBody(ItemUpdateSchema), (c) => {
    const id = parseId(c.req.param('id'))
    const body = c.req.valid('json')

    const existing = db.select().from(items).where(eq(items.id, id)).get()
    if (!existing) throw new HttpError(404, 'NOT_FOUND', `卡片 ${id} 不存在`)

    if (body.groupId !== undefined) assertGroupExists(body.groupId)

    // 合并后再校验「至少一个地址」的不变量
    const mergedLan = body.lanUrl !== undefined ? body.lanUrl : existing.lanUrl
    const mergedWan = body.wanUrl !== undefined ? body.wanUrl : existing.wanUrl
    if (mergedLan === null && mergedWan === null) {
      throw new HttpError(
        400,
        'URL_REQUIRED',
        '内网地址与外网地址至少填写一个',
        { path: 'lanUrl' },
      )
    }

    const row = db
      .update(items)
      .set({
        ...(body.groupId !== undefined && { groupId: body.groupId }),
        ...(body.title !== undefined && { title: body.title }),
        ...(body.subtitle !== undefined && { subtitle: body.subtitle }),
        ...(body.iconType !== undefined && { iconType: body.iconType }),
        ...(body.iconValue !== undefined && { iconValue: body.iconValue }),
        ...(body.iconColor !== undefined && { iconColor: body.iconColor }),
        ...(body.bgColor !== undefined && { bgColor: body.bgColor }),
        ...(body.lanUrl !== undefined && { lanUrl: body.lanUrl }),
        ...(body.wanUrl !== undefined && { wanUrl: body.wanUrl }),
        ...(body.networkPref !== undefined && { networkPref: body.networkPref }),
        ...(body.sort !== undefined && { sort: body.sort }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        updatedAt: Date.now(),
      })
      .where(eq(items.id, id))
      .returning()
      .get()

    // 地址或偏好可能变了，重探该卡片
    void probe.refreshOne(id)

    return c.json(toItem(row))
  })

  .delete('/:id', (c) => {
    const id = parseId(c.req.param('id'))
    const row = db.delete(items).where(eq(items.id, id)).returning().get()
    if (!row) throw new HttpError(404, 'NOT_FOUND', `卡片 ${id} 不存在`)
    // 卡片已删除 —— refreshOne 查不到记录时会顺手清掉探测缓存
    void probe.refreshOne(id)
    return c.body(null, 204)
  })

  /** 拖拽排序：一次提交完整顺序，含跨分组移动 */
  .post('/reorder', jsonBody(ItemReorderSchema), (c) => {
    const { order } = c.req.valid('json')
    const now = Date.now()

    const ids = order.map((o) => o.id)
    const existing = db.select({ id: items.id }).from(items).where(inArray(items.id, ids)).all()
    const existingIds = new Set(existing.map((r) => r.id))

    const missing = ids.filter((id) => !existingIds.has(id))
    if (missing.length > 0) {
      throw new HttpError(400, 'NOT_FOUND', `以下卡片不存在：${missing.join(', ')}`)
    }

    // 事务外先校验完所有分组，避免事务中途抛错
    const targetGroups = [...new Set(order.map((o) => o.groupId).filter((g): g is number => g !== null))]
    for (const gid of targetGroups) {
      const g = sqlite.prepare('SELECT id FROM groups WHERE id = ?').get(gid)
      if (!g) throw new HttpError(400, 'GROUP_NOT_FOUND', `分组 ${gid} 不存在`)
    }

    db.transaction((tx) => {
      for (const o of order) {
        tx.update(items)
          .set({ groupId: o.groupId, sort: o.sort, updatedAt: now })
          .where(eq(items.id, o.id))
          .run()
      }
    })

    const rows = db.select().from(items).orderBy(asc(items.sort), asc(items.id)).all()
    return c.json(rows.map(toItem))
  })
