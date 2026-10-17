/**
 * 数据库连接与迁移。
 *
 * 模块加载时即完成：数据目录创建 → 打开 SQLite → 设置 PRAGMA → 应用迁移。
 * 因为 server/index.ts 的 ESM import 会在其自身代码执行前全部求值，
 * 这里通过 env 的 getConfig() 惰性取配置（env 模块本身无副作用）。
 *
 * 目录布局（见 docs/DESIGN.md §11.1）：
 *   <data-dir>/db/app.db   数据库
 *   <data-dir>/bg/         用户上传的壁纸文件（services/bg-store.ts）
 *   <data-dir>/secret.key  会话签名密钥
 */
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig } from '../env'
import { MIGRATIONS } from './migrations'
import * as schema from './schema'

const config = getConfig()

/** 数据库所在子目录 —— 与壁纸目录 bg/ 并列，都挂在数据根目录下 */
export const DB_DIR = join(config.dataDir, 'db')

try {
  mkdirSync(DB_DIR, { recursive: true })
} catch (err) {
  console.error(
    `\n[db] 无法创建数据目录：${DB_DIR}\n` +
      `  ${(err as Error).message}\n` +
      `  请用 --data-dir 指定一个可写目录。\n`,
  )
  process.exit(1)
}

export const DB_PATH = join(DB_DIR, 'app.db')

const sqlite = new Database(DB_PATH, { create: true })

// PRAGMA 必须在任何事务之前设置（journal_mode 不能在事务内切换）
sqlite.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA temp_store = MEMORY;
`)

export const db = drizzle(sqlite, { schema })

/**
 * 原生 bun:sqlite 连接。
 * 用于 PRAGMA、迁移，以及少量不值得上 ORM 的查询（如存在性检查）。
 */
export { sqlite }

function currentVersion(): number {
  const row = sqlite.prepare('PRAGMA user_version').get() as
    | { user_version: number }
    | null
  return row?.user_version ?? 0
}

function runMigrations(): number {
  const from = currentVersion()
  const pending = MIGRATIONS.filter((m) => m.version > from).sort(
    (a, b) => a.version - b.version,
  )
  if (pending.length === 0) return from

  for (const m of pending) {
    try {
      sqlite.transaction(() => {
        sqlite.exec(m.sql)
        // 版本号来自代码常量而非用户输入，直接插值（PRAGMA 不支持绑定参数）
        sqlite.exec(`PRAGMA user_version = ${Number(m.version)}`)
      })()
      console.log(`[db] 已应用迁移 v${m.version} ${m.name}`)
    } catch (err) {
      console.error(
        `\n[db] 迁移 v${m.version} (${m.name}) 失败，数据库未变更：\n` +
          `  ${(err as Error).message}\n`,
      )
      process.exit(1)
    }
  }
  return currentVersion()
}

export const SCHEMA_VERSION = runMigrations()

export function closeDb(): void {
  try {
    // 关闭前合并 WAL，避免留下 -wal / -shm 伴生文件影响备份
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    /* 忽略 */
  }
  sqlite.close()
}
