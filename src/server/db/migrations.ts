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
  {
    /**
     * 卡片不透明度从三风格共用（ui.glassOpacity）拆成按风格独立配置
     * （ui.solidOpacity / ui.frostOpacity / ui.liquidOpacity）。
     * 旧共享值复制到三个新键 —— 用户调好的透明度在每种风格下都保留，之后可各自微调。
     */
    version: 3,
    name: 'glass-opacity-per-style',
    sql: `
      INSERT INTO settings (key, value)
        SELECT 'ui.solidOpacity', value FROM settings WHERE key = 'ui.glassOpacity';
      INSERT INTO settings (key, value)
        SELECT 'ui.frostOpacity', value FROM settings WHERE key = 'ui.glassOpacity';
      INSERT INTO settings (key, value)
        SELECT 'ui.liquidOpacity', value FROM settings WHERE key = 'ui.glassOpacity';
      DELETE FROM settings WHERE key = 'ui.glassOpacity';
    `,
  },
  {
    /**
     * 卡片「不透明度」→「透明度」：旧值 0 是哨兵（= 跟随风格默认：实色底
     * α0.94、浅色毛玻璃 α0.8、液态浅色 α0.22 / 深色 α0.07），1~100 才是字面
     * alpha。于是滑杆从 0 挪到 1 会跨完整个不透明度区间，手感是断的。
     *
     * 新语义去掉哨兵：0 = 完全不透明，100 = 完全透明，全程线性。
     *   - 旧 v(>0) → 100 - v（alpha v% ⇒ 透明度 (100-v)%）
     *   - 旧 0（哨兵）→ 该风格的新默认值
     *   - 库里没存过的风格不插行，直接吃新默认值
     * 代价：深浅主题不再各自用不同默认 alpha（毛玻璃/液态在深色下比过去透一档），
     * 色相仍随主题切换（main.css 的 --card-rgb）。
     */
    version: 4,
    name: 'opacity-to-transparency',
    sql: `
      INSERT OR IGNORE INTO settings (key, value)
        SELECT 'ui.solidTransparency',
               CASE WHEN CAST(value AS INTEGER) > 0
                    THEN CAST(100 - CAST(value AS INTEGER) AS TEXT)
                    ELSE '10' END
          FROM settings WHERE key = 'ui.solidOpacity';
      INSERT OR IGNORE INTO settings (key, value)
        SELECT 'ui.frostTransparency',
               CASE WHEN CAST(value AS INTEGER) > 0
                    THEN CAST(100 - CAST(value AS INTEGER) AS TEXT)
                    ELSE '20' END
          FROM settings WHERE key = 'ui.frostOpacity';
      INSERT OR IGNORE INTO settings (key, value)
        SELECT 'ui.liquidTransparency',
               CASE WHEN CAST(value AS INTEGER) > 0
                    THEN CAST(100 - CAST(value AS INTEGER) AS TEXT)
                    ELSE '85' END
          FROM settings WHERE key = 'ui.liquidOpacity';
      DELETE FROM settings
        WHERE key IN ('ui.solidOpacity', 'ui.frostOpacity', 'ui.liquidOpacity');
    `,
  },
  {
    /**
     * 移除监控白名单与 GPU 采样开关：
     *   - monitor.disks / monitor.netIfaces 白名单已从设置面板移除，
     *     磁盘与网卡改为始终展示全部设备
     *   - monitor.gpuEnabled 开关已移除，GPU 采样器常驻
     * 清掉旧行，避免残留配置继续影响行为。
     */
    version: 5,
    name: 'drop-monitor-whitelist-and-gpu-toggle',
    sql: `
      DELETE FROM settings
        WHERE key IN ('monitor.disks', 'monitor.netIfaces', 'monitor.gpuEnabled');
    `,
  },
]
