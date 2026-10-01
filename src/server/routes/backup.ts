/**
 * 配置导入导出。
 *
 * 导出为单个 JSON 文件。资源（图标/壁纸）二进制体积可能较大，
 * 因此默认**不包含**，需要时用 `?assets=true` 显式带上（base64 内联）。
 *
 * 导入支持两种模式：
 *   - replace：清空现有分组与卡片后写入（保留资源，避免把正在用的图标删掉）
 *   - merge：追加，并把旧的分组 ID 重映射到新建的分组上
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { asc } from 'drizzle-orm'
import { db } from '../db'
import { assets, groups, items } from '../db/schema'
import { toGroup, toItem } from '../db/mappers'
import { getAllSettings, patchSettings } from '../services/settings'
import { jsonBody } from '../middleware/validate'
import { HttpError } from '../middleware/error'
import { storeAsset } from '../services/assets'

const VERSION = '0.1.0'
const FORMAT = 'starm-panel-backup'

const BackupSchema = z.object({
  format: z.literal(FORMAT),
  version: z.number().int().positive(),
  groups: z.array(z.record(z.string(), z.unknown())).default([]),
  items: z.array(z.record(z.string(), z.unknown())).default([]),
  settings: z.record(z.string(), z.unknown()).default({}),
  assets: z
    .array(
      z.object({
        kind: z.string(),
        name: z.string(),
        mime: z.string(),
        dataBase64: z.string(),
      }),
    )
    .optional(),
})

const ImportQuerySchema = z.object({
  mode: z.enum(['merge', 'replace']).default('merge'),
})

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback
}

export const backupRoutes = new Hono()
  .get('/export', (c) => {
    const withAssets = c.req.query('assets') === 'true'

    const payload: Record<string, unknown> = {
      format: FORMAT,
      version: 1,
      appVersion: VERSION,
      exportedAt: Date.now(),
      groups: db.select().from(groups).orderBy(asc(groups.sort), asc(groups.id)).all().map(toGroup),
      items: db.select().from(items).orderBy(asc(items.sort), asc(items.id)).all().map(toItem),
      settings: getAllSettings(),
    }

    if (withAssets) {
      payload['assets'] = db
        .select()
        .from(assets)
        .all()
        .map((a) => ({
          kind: a.kind,
          name: a.name,
          mime: a.mime,
          dataBase64: Buffer.from(a.bytes).toString('base64'),
        }))
    }

    const filename = `starm-panel-backup-${new Date().toISOString().slice(0, 10)}.json`
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    })
  })

  .post('/import', jsonBody(BackupSchema), (c) => {
    const payload = c.req.valid('json')
    const mode = ImportQuerySchema.parse({
      mode: c.req.query('mode') ?? 'merge',
    }).mode

    if (payload.version > 1) {
      throw new HttpError(
        400,
        'UNSUPPORTED_VERSION',
        `备份文件版本 ${payload.version} 高于当前支持的 1`,
      )
    }

    const stats = { groups: 0, items: 0, assets: 0, settings: 0 }

    // ── 资源（在事务外）：两种模式都只做补充，绝不删除已有资源，
    //    避免把正在被卡片引用的图标删掉。storeAsset 自带去重。──
    if (payload.assets) {
      for (const a of payload.assets) {
        try {
          const bytes = new Uint8Array(Buffer.from(a.dataBase64, 'base64'))
          if (bytes.byteLength === 0) continue
          storeAsset(
            bytes,
            a.kind === 'wallpaper' || a.kind === 'favicon' ? a.kind : 'icon',
            a.name,
            a.mime,
          )
          stats.assets++
        } catch {
          // 单个资源导入失败不影响整体
        }
      }
    }

    db.transaction((tx) => {
      if (mode === 'replace') {
        tx.delete(items).run()
        tx.delete(groups).run()
      }

      // ── 分组：写入并建立 旧ID → 新ID 的映射 ──
      const idMap = new Map<number, number>()
      const now = Date.now()

      for (const g of payload.groups) {
        const row = tx
          .insert(groups)
          .values({
            name: str(g['name']) ?? '未命名分组',
            icon: str(g['icon']),
            sort: num(g['sort']),
            collapsed: bool(g['collapsed']),
            createdAt: num(g['createdAt'], now),
            updatedAt: now,
          })
          .returning({ id: groups.id })
          .get()

        const oldId = num(g['id'], 0)
        if (oldId > 0) idMap.set(oldId, row.id)
        stats.groups++
      }

      // ── 卡片：把 groupId 映射到新建的分组 ──
      for (const it of payload.items) {
        const oldGroupId = it['groupId'] === null ? null : num(it['groupId'], 0)
        const newGroupId =
          oldGroupId !== null && idMap.has(oldGroupId) ? idMap.get(oldGroupId)! : null

        tx.insert(items)
          .values({
            groupId: newGroupId,
            title: str(it['title']) ?? '未命名',
            subtitle: str(it['subtitle']),
            iconType: str(it['iconType']) ?? 'iconify',
            iconValue: str(it['iconValue']),
            iconColor: str(it['iconColor']),
            bgColor: str(it['bgColor']),
            lanUrl: str(it['lanUrl']),
            wanUrl: str(it['wanUrl']),
            networkPref: str(it['networkPref']) ?? 'auto',
            sort: num(it['sort']),
            enabled: bool(it['enabled'], true),
            createdAt: num(it['createdAt'], now),
            updatedAt: now,
          })
          .run()
        stats.items++
      }
    })

    // 设置在事务外写入（settings 服务自带事务）
    const settingsPatch = Object.fromEntries(
      Object.entries(payload.settings).filter(([k]) => k !== 'auth.passwordHash'),
    )
    if (Object.keys(settingsPatch).length > 0) {
      patchSettings(settingsPatch)
      stats.settings = Object.keys(settingsPatch).length
    }

    return c.json({ ok: true, mode, imported: stats })
  })
