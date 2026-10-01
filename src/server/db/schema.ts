/**
 * Drizzle 表定义。
 *
 * ⚠️ 本文件与 ./migrations.ts 中的手写 SQL 必须保持同步。
 * 之所以不用 drizzle-kit 生成 + 运行时 migrate()：
 * 单文件二进制里的资源是 /$bunfs 虚拟路径，drizzle 的 migrator 需要真实
 * 文件系统目录。手写迁移（PRAGMA user_version 跟踪）更简单、完全可嵌入，
 * 且本项目的 schema 规模完全撑得住。详见 docs/DESIGN.md §9.4。
 */
import { blob, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const groups = sqliteTable(
  'groups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    icon: text('icon'),
    sort: integer('sort').notNull().default(0),
    collapsed: integer('collapsed', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_groups_sort').on(t.sort)],
)

export const items = sqliteTable(
  'items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groupId: integer('group_id').references(() => groups.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    iconType: text('icon_type').notNull().default('iconify'),
    iconValue: text('icon_value'),
    iconColor: text('icon_color'),
    bgColor: text('bg_color'),
    lanUrl: text('lan_url'),
    wanUrl: text('wan_url'),
    networkPref: text('network_pref').notNull().default('auto'),
    sort: integer('sort').notNull().default(0),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_items_group_sort').on(t.groupId, t.sort)],
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const assets = sqliteTable(
  'assets',
  {
    /** 内容哈希（sha256 前 16 位十六进制）—— 天然去重 */
    id: text('id').primaryKey(),
    /** icon | wallpaper | favicon */
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    bytes: blob('bytes', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_assets_kind').on(t.kind)],
)

export type GroupRow = typeof groups.$inferSelect
export type ItemRow = typeof items.$inferSelect
export type AssetRow = typeof assets.$inferSelect
