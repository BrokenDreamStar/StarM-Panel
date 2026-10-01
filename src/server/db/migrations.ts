/**
 * 手写迁移列表。
 *
 * 版本号写入 `PRAGMA user_version`，启动时逐条应用未执行的迁移。
 *
 * 规则：
 *   - 已发布的迁移**永不修改**，只能追加新版本
 *   - 每条迁移的 sql 在一个事务内执行
 *   - 与 ./schema.ts 的表定义保持同步
 */

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE groups (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        icon        TEXT,
        sort        INTEGER NOT NULL DEFAULT 0,
        collapsed   INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_groups_sort ON groups (sort);

      CREATE TABLE items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id     INTEGER REFERENCES groups(id) ON DELETE SET NULL,
        title        TEXT    NOT NULL,
        subtitle     TEXT,
        icon_type    TEXT    NOT NULL DEFAULT 'iconify',
        icon_value   TEXT,
        icon_color   TEXT,
        bg_color     TEXT,
        lan_url      TEXT,
        wan_url      TEXT,
        network_pref TEXT    NOT NULL DEFAULT 'auto',
        open_mode    TEXT    NOT NULL DEFAULT 'newTab',
        sort         INTEGER NOT NULL DEFAULT 0,
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_items_group_sort ON items (group_id, sort);

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE assets (
        id         TEXT    PRIMARY KEY,
        kind       TEXT    NOT NULL,
        name       TEXT    NOT NULL,
        mime       TEXT    NOT NULL,
        size       INTEGER NOT NULL,
        bytes      BLOB    NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_assets_kind ON assets (kind);
    `,
  },
  {
    /**
     * 打开方式从卡片字段升级为全局设置（ui.openMode），同时去掉「内嵌小窗」。
     * 旧库里残留的 per-card 值一律丢弃 —— 全局默认 newTab 与旧列默认值一致，
     * 所以这次迁移对既有部署是行为无感的。
     */
    version: 2,
    name: 'open-mode-to-setting',
    sql: `
      ALTER TABLE items DROP COLUMN open_mode;
    `,
  },
]
