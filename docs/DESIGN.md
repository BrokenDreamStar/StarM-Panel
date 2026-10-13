# StarM-Panel 详细设计文档

> 版本：v0.1 (Draft)
> 状态：待评审
> 定位：轻量级自托管导航面板 —— 系统硬件监控 + 应用卡片 + 内外网一键切换

---

## 1. 需求与范围

### 1.1 核心需求

| 编号 | 需求 | 优先级 |
|---|---|---|
| R1 | 监看系统硬件信息（CPU / 内存 / 磁盘 / 网络 / **GPU** / 系统信息） | P0 |
| R2 | 添加、编辑、删除应用卡片 | P0 |
| R3 | 卡片可配置图标（图标库 / 上传图片 / 文字 / 自动 favicon） | P0 |
| R4 | 卡片可配置内网链接与外网链接 | P0 |
| R5 | 全局一键切换内网 / 外网模式 | P0 |
| R6 | 卡片分组与拖拽排序 | P1 |
| R7 | 壁纸与主题（浅色 / 深色） | P1 |
| R8 | 搜索框（多引擎可配） | P1 |
| R9 | 配置导入 / 导出 | P1 |
| R10 | 访问口令（可选，默认关闭） | P2 |
| R11 | Docker 容器状态查看 | P3（暂不做） |

### 1.2 明确不做（与 Sun-Panel 的差异）

项目刻意保持轻量，以下**明确排除**：

- ❌ **多用户系统**。单实例单配置，不区分账号，不做权限模型、不做数据隔离。
- ❌ **Docker 部署**。只提供单文件可执行程序，不做容器镜像。
- ❌ **外部数据库**。只用内嵌 SQLite。
- ❌ **SSR / SEO**。纯前端 SPA，无服务端渲染。
- ❌ 插件系统、主题市场、OAuth 登录。

> R10「访问口令」不是多用户系统：它只是给整个面板加一道单一的口令门，没有账号概念、没有角色、没有按用户隔离的数据。

### 1.3 非目标

- 不做通用监控平台（不是 Prometheus / Grafana 的替代品）。
- 不做 Docker / K8s 管理面板。
- 不做反向代理或内网穿透（内网外网切换只负责「选哪个 URL」，不负责「怎么打通」）。

---

## 2. 技术选型与决策记录

### 2.1 选型总表

| 层 | 选型 | 版本 | 理由 |
|---|---|---|---|
| 运行时 | **Bun** | 1.4.2 | 内置 SQLite / 密码哈希 / 打包器；单文件交叉编译 |
| 后端框架 | **Hono** | 4.13.11 | 零依赖、Web 标准、中间件生态、可移植 |
| 数据库 | **SQLite**（`bun:sqlite`） | 内置 | 零配置、单文件、运行时内置无需原生编译 |
| ORM | **Drizzle ORM** | 0.45.3（stable） | `drizzle-orm/bun-sqlite` 在稳定版中已可用 |
| 迁移 | **drizzle-kit** | latest | 生成 SQL 迁移文件 |
| 前端框架 | **Vue** | 3.5.x | 需求指定 Vue 生态 |
| 构建 | **Vite** | 7.x | Vue SFC 事实标准 |
| 路由 | **Vue Router** | 4.x | |
| 状态 | **Pinia** | 3.x | |
| 样式 | **UnoCSS** | latest | 原子类，体积小，毛玻璃/主题切换方便 |
| UI 组件 | **Naive UI** | latest | TS 优先、主题变量系统强、可摇树 |
| 图标 | **Iconify** | `@iconify/vue` + `@iconify-json/*` | 离线打包，不依赖外网 API |
| 图表 | **ECharts** | 5.x（按需引入） | 折线 + 仪表盘 |
| 拖拽 | **vue-draggable-plus** | latest | Vue 3 版 Sortable |
| 硬件采集 | **systeminformation** | 5.x | 纯 JS，跨平台，能力覆盖最全 |
| 校验 | **Zod** | 3.x/4.x | 前后端共享 schema |

### 2.2 关键决策记录（ADR）

#### ADR-001：运行时选 Bun 而非 Node

**决策**：使用 Bun 作为唯一运行时。

**理由**：
1. `bun:sqlite` 是运行时内置，**无原生扩展**。这是单文件交叉编译的硬前提——Node 方案必须用 `better-sqlite3`，而它无法跨平台交叉编译。
2. `Bun.build --compile` 提供官方单文件打包 + 交叉编译。
3. `Bun.password`（argon2id）内置，省掉一个密码哈希依赖。
4. `Bun.serve` 内置 HTTP + WebSocket + 静态路由。
5. Bun 1.4 重写为 Rust 后，内存占用降低最多 35%，空闲 CPU 降低 5 倍，Linux 冷启动快 50%。

**代价**：
- 单文件体积 ~70–110MB（内嵌整个运行时）。
- 生态兼容性仍不及 Node（Bun 1.4 已通过 +1517 个 Node 测试用例，风险已大幅降低）。
- 部署机器不需要预装 Bun（这是单文件方案的全部意义）。

**被否决的方案**：
- *Node + better-sqlite3*：无法交叉编译，Docker 构建需要在目标架构编译原生模块。
- *Go + Gin*：单二进制约 25MB 是最优的，但需要维护第二套语言，且与「Vue 生态」的诉求相悖。

#### ADR-002：前后端合并为单个 Bun 二进制

**决策**：前端 Vite 产物在构建期嵌入后端二进制，运行时单进程提供 API + 静态资源。

**理由**：
- 用户明确不要 Docker。单文件是「拷贝即部署」的最简形态。
- 无 CORS、无跨进程通信、无反向代理配置。
- 端口单一，防火墙规则简单。

**代价**：
- 前端改动需要重新编译整个二进制（约 10–30s），开发期用 Vite dev server 代理规避。
- 二进制与前端产物强耦合，无法单独热更前端。

#### ADR-003：不使用 Nuxt

**决策**：用 Vue 3 SPA + 独立 Hono 后端，不使用 Nuxt 4。

**理由**：
- Nuxt 的招牌能力（SSR、SEO、islands、server components）在本项目**一个都用不上**——面板在访问口令之后，无 SEO 需求。
- Nuxt 会引入 `ssr: false` 下的各种边界问题（hydration、`<ClientOnly>`、Nitro preset 语义），而这些成本换来的只是文件路由和自动导入。
- Nuxt 的 Nitro 服务层会额外增加内存开销，与「轻量」目标冲突。
- 单文件打包路径下，Vite + Hono 的链路更短、更可控。

**备注**：`shared/` 目录的共享类型能力，用一个普通的 `shared/` 源码目录 + tsconfig path alias 即可等价实现，无需框架。

#### ADR-004：图标资源采用离线打包而非 Iconify API

**决策**：构建期打包 2–3 个精选图标集的完整 JSON，运行时完全离线。

**理由**：
- 面板的核心使用场景是内网，**不能依赖 Iconify 公网 API**。
- 图标选择器需要展示全集，**无法做静态扫描摇树**（无法预知用户会选哪个图标）。

**代价**：
- 每个图标集 JSON 约 0.6–1.5MB（gzip 后约 150–400KB）。收录 3 个集合，前端产物增加约 3–4MB（压缩后传输 ~1MB）。
- 缓解：只收录 2–3 个最通用的集合；其余图标通过「上传 SVG」满足。

**被否决的方案**：
- *`unplugin-icons` 静态扫描*：只适用于编译期已知的图标名，图标选择器场景不适用。
- *Iconify API 运行时拉取*：内网不可用，且泄露访问记录。

#### ADR-005：用户上传的图标与壁纸存 SQLite BLOB

**决策**：图标、壁纸二进制直接存进 SQLite 的 BLOB 字段，而非文件系统。

**理由**：
- 使整个应用状态收敛为 **2 个文件**：`app.db` + `secret.key`。备份 = 复制文件。
- 无「数据库与文件系统不同步」问题（删除记录即删除数据）。
- SQLite 对小 BLOB（< 1MB）读写性能完全够用。

**代价与约束**：
- 单个图标上限 **512KB**，超限拒绝；壁纸不设体积上限。
- 需开启 WAL 模式，注意 `-wal` / `-shm` 伴生文件（备份时需一并处理或先 checkpoint）。
- 数据库文件预期 < 50MB。

#### ADR-006：监控数据只存内存，不落库

**决策**：硬件采样数据仅保存在进程内存的环形缓冲区中，不写入 SQLite。

**理由**：
- 1 秒一次采样写入会造成严重的写放大和闪存磨损（NAS 场景尤其敏感）。
- 历史数据无长期价值——面板只需要「当前状态 + 最近几分钟趋势」。

**代价**：进程重启后趋势图清零。可接受。

---

## 3. 系统架构

### 3.1 运行时架构

```
┌──────────────────────────────────────────────────────────────┐
│                    starm-panel (单可执行文件)                  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Bun 运行时 (内嵌)                                      │  │
│  │                                                        │  │
│  │  ┌──────────────────────┐   ┌───────────────────────┐  │  │
│  │  │  Hono App            │   │  MonitorService       │  │  │
│  │  │  ├ /api/items        │   │  ├ setInterval 1000ms │  │  │
│  │  │  ├ /api/groups       │   │  ├ RingBuffer(300)    │  │  │
│  │  │  ├ /api/system/*     │◄──┤  └ SubscriberSet      │  │  │
│  │  │  ├ /api/settings     │   ┌───────────────────────┐  │  │
│  │  │  └ /* 静态资源        │   │  Embedded Assets      │  │  │
│  │  └──────────┬───────────┘   │  (Vue SPA 产物 / 迁移) │  │  │
│  │             │               └───────────────────────┘  │  │
│  │             ▼                                          │  │
│  │  ┌──────────────────────┐                              │  │
│  │  │  Drizzle ORM         │                              │  │
│  │  │  └ bun:sqlite        │                              │  │
│  │  └──────────┬───────────┘                              │  │
│  │             │                                          │  │
│  └─────────────┼──────────────────────────────────────────┘  │
│                ▼                                             │
│         data/app.db   data/secret.key                        │
└──────────────────────────────────────────────────────────────┘
                            ▲
                            │ HTTP / SSE
                            ▼
                    ┌───────────────┐
                    │   浏览器 SPA   │
                    │  Vue 3 + Pinia │
                    └───────────────┘
```

### 3.2 请求流向

| 场景 | 路径 |
|---|---|
| 首次加载 | `GET /` → 嵌入的 `index.html` → SPA 启动 → `GET /api/bootstrap` |
| 卡片 CRUD | SPA → `/api/items` → Zod 校验 → Drizzle → SQLite → 返回实体 |
| 监控数据 | `MonitorService` 定时采样 → `GET /api/system/stream` (SSE) → SPA store |
| 内外网切换 | 用户点开关 → Pinia `network.mode` / `autoMode` → `resolveUrl()` 纯函数 → 卡片 URL 响应式更新 |
| 自动模式落地 | 面板以 IP / localhost 访问 → 内网；以域名访问 → 外网（`isLanHost` 纯函数） |

### 3.3 开发期架构

开发期不编译二进制，前后端分离运行：

```
Vite dev server (5173)  ──/api/* 代理──▶  Bun 后端 (3002)
```

`vite.config.ts` 中配置 `server.proxy`。前端代码无需感知差异（始终请求同源 `/api/*`）。

---

## 4. 目录结构

```
StarM-Panel/
├── src/
│   ├── server/                       # 后端
│   │   ├── index.ts                  # 入口：Hono app + Bun.serve + 启动钩子
│   │   ├── cli.ts                    # 命令行参数解析 (--port/--data-dir/--host)
│   │   ├── env.ts                    # 配置解析与数据目录初始化
│   │   ├── db/
│   │   │   ├── index.ts              # Drizzle 实例 + 连接
│   │   │   ├── schema.ts             # 表定义
│   │   │   └── migrate.ts            # 启动时自动迁移
│   │   ├── routes/
│   │   │   ├── items.ts
│   │   │   ├── groups.ts
│   │   │   ├── assets.ts             # 图标/壁纸上传与读取
│   │   │   ├── favicon.ts            # favicon 抓取与缓存
│   │   │   ├── system.ts             # /info + /stream (SSE)
│   │   │   ├── settings.ts
│   │   │   ├── backup.ts             # 导入导出
│   │   │   └── auth.ts               # 可选口令
│   │   ├── services/
│   │   │   ├── monitor.ts            # 硬件采集 + 环形缓冲 + 订阅
│   │   │   └── favicon.ts            # favicon 抓取解析
│   │   ├── middleware/
│   │   │   ├── auth.ts
│   │   │   ├── error.ts
│   │   │   └── rate-limit.ts
│   │   ├── static.ts                 # 嵌入资源服务 + SPA fallback
│   │   └── generated/
│   │       └── assets.ts             # 【构建生成】资源 import 清单
│   │
│   ├── shared/                       # 前后端共享（纯 TS，禁止 import 任一侧代码）
│   │   ├── types.ts                  # 领域类型
│   │   ├── schemas.ts                # Zod schema（校验 + 类型推导）
│   │   └── resolve-url.ts            # ★ 内外网 URL 解析纯函数
│   │
│   └── web/                          # 前端
│       ├── index.html
│       ├── main.ts
│       ├── App.vue
│       ├── router/index.ts
│       ├── api/client.ts             # 类型化 fetch 封装
│       ├── stores/
│       │   ├── network.ts            # ★ 全局内外网模式 + 自动模式落地
│       │   ├── items.ts              # 卡片与分组
│       │   ├── monitor.ts            # SSE 快照 + 历史
│       │   └── settings.ts
│       ├── composables/
│       │   ├── useMonitorStream.ts   # SSE 订阅（含重连）
│       │   └── useDragSort.ts
│       ├── components/
│       │   ├── layout/
│       │   │   ├── TopBar.vue
│       │   │   ├── NetworkSwitch.vue  # ★ 一键切换开关
│       │   │   └── SearchBox.vue
│       │   ├── card/
│       │   │   ├── ItemCard.vue
│       │   │   ├── ItemEditor.vue
│       │   │   ├── IconPicker.vue
│       │   │   └── GroupSection.vue
│       │   ├── monitor/
│       │   │   ├── MonitorPanel.vue
│       │   │   ├── CpuGauge.vue
│       │   │   ├── MemBar.vue
│       │   │   ├── DiskList.vue
│       │   │   ├── NetSpark.vue
│       │   │   └── GpuPanel.vue       # 按 available 数组动态渲染
│       │   └── common/
│       │       ├── AppModal.vue
│       │       ├── IframeWindow.vue
│       │       └── Wallpaper.vue
│       ├── views/
│       │   ├── HomeView.vue
│       │   ├── SettingsView.vue
│       │   └── LockView.vue          # 口令解锁页
│       └── styles/
│
├── drizzle/                          # 【drizzle-kit 生成】迁移 SQL
├── scripts/
│   ├── build.ts                      # 完整构建流水线
│   └── gen-assets.ts                 # 生成 src/server/generated/assets.ts
├── docs/
│   └── DESIGN.md                     # 本文档
├── data/                             # 【运行时】数据目录（gitignore）
├── vite.config.ts
├── drizzle.config.ts
├── tsconfig.json
├── uno.config.ts
├── package.json
└── bunfig.toml
```

---

## 5. 数据模型

### 5.1 ER 关系

```
groups 1 ──── n items
settings (单表 KV)
assets  (独立，通过 URL 被 items 引用)
```

### 5.2 表定义

#### `groups` — 卡片分组

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `name` | TEXT | NOT NULL | 分组名 |
| `icon` | TEXT | NULL | 可选图标（Iconify 名） |
| `sort` | INTEGER | NOT NULL DEFAULT 0 | 排序权重，越小越前 |
| `collapsed` | INTEGER | NOT NULL DEFAULT 0 | 折叠状态（0/1） |
| `created_at` | INTEGER | NOT NULL | Unix 毫秒 |
| `updated_at` | INTEGER | NOT NULL | Unix 毫秒 |

索引：`idx_groups_sort (sort)`

#### `items` — 应用卡片

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `group_id` | INTEGER | NULL, FK → groups(id) ON DELETE SET NULL | NULL = 未分组 |
| `title` | TEXT | NOT NULL | 卡片标题 |
| `subtitle` | TEXT | NULL | 副标题/描述 |
| `icon_type` | TEXT | NOT NULL DEFAULT 'iconify' | `iconify` \| `asset` \| `text` \| `favicon` |
| `icon_value` | TEXT | NULL | iconify 名 / asset URL / 文字内容 / 源站 URL |
| `icon_color` | TEXT | NULL | 图标前景色（`text` 类型尤用） |
| `bg_color` | TEXT | NULL | 卡片背景色（覆盖主题默认） |
| `lan_url` | TEXT | NULL | **内网地址** |
| `wan_url` | TEXT | NULL | **外网地址** |
| `network_pref` | TEXT | NOT NULL DEFAULT 'auto' | `auto` \| `lan` \| `wan` —— 卡片级覆盖 |
| `open_mode` | TEXT | NOT NULL DEFAULT 'newTab' | `newTab` \| `iframe` \| `self` |
| `sort` | INTEGER | NOT NULL DEFAULT 0 | |
| `enabled` | INTEGER | NOT NULL DEFAULT 1 | 是否显示 |
| `created_at` | INTEGER | NOT NULL | |
| `updated_at` | INTEGER | NOT NULL | |

索引：`idx_items_group_sort (group_id, sort)`

**约束规则**：`lan_url` 与 `wan_url` 至少一个非空（应用层校验，DB 层不加 CHECK 以便导入历史数据）。

#### `settings` — 键值配置

| 字段 | 类型 | 约束 |
|---|---|---|
| `key` | TEXT | PK |
| `value` | TEXT | NOT NULL（JSON 序列化） |

已知键：

| key | 值类型 | 默认 | 说明 |
|---|---|---|---|
| `network.mode` | `'lan' \| 'wan'` | `'lan'` | 关闭自动选择时的默认模式 |
| `network.autoMode` | `boolean` | `false` | 是否按访问方式自动选择内外网 |
| `theme.mode` | `'light' \| 'dark' \| 'system'` | `'system'` | |
| `theme.accent` | `string` | `'#6366f1'` | 主题色 |
| `wallpaper.type` | `'solid' \| 'gradient' \| 'asset' \| 'bing'` | `'gradient'` | |
| `wallpaper.value` | `string \| null` | `null` | 颜色值 / asset URL |
| `search.engines` | `SearchEngine[]` | 内置 4 个 | |
| `search.defaultEngine` | `string` | `'bing'` | |
| `monitor.interval` | `number` | `1000` | 采样间隔 (ms) |
| `monitor.hiddenInterval` | `number` | `10000` | 无订阅者时的采样间隔 (ms) |
| `monitor.gpuInterval` | `number` | `3000` | GPU 采样间隔 (ms)，比 CPU 慢（见 7.3） |
| `monitor.cards` | `({ kind, device? })[]` | 全部 kind（自动） | ★ 首页「系统状态」区展示哪些硬件卡片，**数组顺序即展示顺序**。条目 = `{ kind, device? }`：`device` 缺省为「自动」条目（兼容旧版纯字符串值），按当前设备展开成多张；显式条目则一台设备一张卡。设备维度：`disk` = 挂载点、`network` = 网卡名、`gpu` = 设备序号，`cpu`/`memory`/`system` 整机唯一。由首页「添加卡片」位**按设备**增删、拖拽卡片排序（不再走设置页） |
| `auth.enabled` | `boolean` | `false` | |
| `auth.passwordHash` | `string \| null` | `null` | argon2id hash |
| `ui.showMonitor` | `boolean` | `true` | 是否显示监控区（旧侧栏方案遗留，见 §10.6） |
| `ui.showClock` | `boolean` | `true` | 首页主标题旁是否显示时钟 |
| `ui.title` | `string` | `''` | 首页主标题文案，留空显示 `StarM Panel` |
| `ui.cardSize` | `'sm' \| 'md' \| 'lg'` | `'md'` | 应用卡片与「系统状态」硬件卡片共用的尺寸：决定网格最小列宽与卡片内距 |
| `version` | `number` | `1` | 配置结构版本，用于迁移 |

#### `assets` — 上传的二进制资源

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | 内容哈希（sha256 前 16 位十六进制） |
| `kind` | TEXT | NOT NULL | `icon` \| `wallpaper` \| `favicon` |
| `name` | TEXT | NOT NULL | 原始文件名 |
| `mime` | TEXT | NOT NULL | MIME 类型 |
| `size` | INTEGER | NOT NULL | 字节数 |
| `bytes` | BLOB | NOT NULL | 内容 |
| `created_at` | INTEGER | NOT NULL | |

索引：`idx_assets_kind (kind)`

**去重**：`id` 为内容哈希，相同内容重复上传自动复用。
**上限**：`icon` / `favicon` ≤ 512KB；`wallpaper` 不设限。

### 5.3 TypeScript 类型（`src/shared/types.ts`）

```ts
export type NetworkPref = 'auto' | 'lan' | 'wan'
export type NetworkMode = 'lan' | 'wan'
export type OpenMode = 'newTab' | 'iframe' | 'self'
export type IconType = 'iconify' | 'asset' | 'text' | 'favicon'

export interface Group {
  id: number
  name: string
  icon: string | null
  sort: number
  collapsed: boolean
  createdAt: number
  updatedAt: number
}

export interface Item {
  id: number
  groupId: number | null
  title: string
  subtitle: string | null
  iconType: IconType
  iconValue: string | null
  iconColor: string | null
  bgColor: string | null
  lanUrl: string | null
  wanUrl: string | null
  networkPref: NetworkPref
  openMode: OpenMode
  sort: number
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** GET /api/bootstrap 的响应 —— 一次请求拿到全部渲染所需数据 */
export interface BootstrapPayload {
  version: string
  groups: Group[]
  items: Item[]
  settings: Record<string, unknown>
  authRequired: boolean
  platform: { os: string; arch: string; hostname: string }
}
```

### 5.4 SQLite 初始化 PRAGMA

```sql
PRAGMA journal_mode = WAL;      -- 并发读 + 单写
PRAGMA synchronous = NORMAL;    -- WAL 下的安全/性能平衡点
PRAGMA foreign_keys = ON;       -- 启用外键约束
PRAGMA busy_timeout = 5000;     -- 写锁等待 5s
PRAGMA temp_store = MEMORY;
```

---

## 6. 内外网一键切换设计 ★

这是本项目最核心的功能，单独成章。

### 6.1 两层优先级模型

```
卡片级 network_pref  >  全局 network.autoMode / network.mode
```

`network.autoMode` 开启时，生效模式由前端按**面板自身的访问方式**判定成具体的
`lan` / `wan`（见 §6.4）；关闭时使用 `network.mode`。全程不依赖任何服务端探测。

### 6.2 解析算法（`src/shared/resolve-url.ts`）

```ts
import type { Item, NetworkMode } from './types'

export interface ResolveContext {
  /** 已落地的具体模式：自动模式由调用方按访问方式（isLanHost）先解析再传入 */
  mode: NetworkMode
}

export type ResolveSource = 'lan' | 'wan' | 'fallback' | 'none'

export interface ResolvedUrl {
  url: string | null
  source: ResolveSource
}

/**
 * 纯函数，前后端共用。无副作用、不访问 IO、不依赖运行时。
 */
export function resolveUrl(item: Item, ctx: ResolveContext): ResolvedUrl {
  const { lanUrl, wanUrl, networkPref } = item

  // 1. 卡片级强制
  if (networkPref === 'lan') {
    if (lanUrl) return { url: lanUrl, source: 'lan' }
    if (wanUrl) return { url: wanUrl, source: 'fallback' }
    return { url: null, source: 'none' }
  }
  if (networkPref === 'wan') {
    if (wanUrl) return { url: wanUrl, source: 'wan' }
    if (lanUrl) return { url: lanUrl, source: 'fallback' }
    return { url: null, source: 'none' }
  }

  // 2. 全局模式（auto 已由调用方落地成 lan / wan）
  if (ctx.mode === 'lan') {
    if (lanUrl) return { url: lanUrl, source: 'lan' }
    if (wanUrl) return { url: wanUrl, source: 'fallback' }
    return { url: null, source: 'none' }
  }
  if (wanUrl) return { url: wanUrl, source: 'wan' }
  if (lanUrl) return { url: lanUrl, source: 'fallback' }
  return { url: null, source: 'none' }
}
```

**设计要点**：
- 纯函数，**零依赖**，可被前端 store 高频调用（每次模式切换 = O(n) 次调用）。
- 永远返回最佳可用 URL，绝不返回 `null` 除非两个地址都为空 —— 保证用户永远点得开。
- `source` 字段供 UI 展示来源标记（如卡片角标显示「内网」/「外网」/「回退」）。

### 6.3 前端状态与响应式

```ts
// src/web/stores/network.ts
export const useNetworkStore = defineStore('network', () => {
  const settings = useSettingsStore()
  const mode = ref<NetworkMode>(readLocalMode())   // 初值来自 localStorage

  /** 是否按访问方式自动选择 —— 单一事实来源是 settings store */
  const autoMode = computed(() => settings.get('network.autoMode'))

  const effectiveMode = computed<NetworkMode>(() => {
    if (!autoMode.value) return mode.value
    return isLanHost(window.location.hostname) ? 'lan' : 'wan'
  })

  /** 卡片解析结果，随 mode / autoMode / items 自动重算 */
  function resolve(item: Item): ResolvedUrl {
    return resolveUrl(item, { mode: effectiveMode.value })
  }

  function setMode(next: NetworkMode) {
    // 先同步写 localStorage（立即生效、离线可用），再异步 PATCH，失败不回滚
    writeLocalMode(next)
    mode.value = next
    void api.settings.patch({ 'network.mode': next }).catch(() => {})
  }

  function setAutoMode(next: boolean) {
    void settings.patch({ 'network.autoMode': next })
  }

  return { mode, autoMode, effectiveMode, resolve, setMode, setAutoMode, syncFromServer }
})
```

**持久化策略（双写）**：
1. `localStorage` —— 立即生效，离线可用，刷新不闪。
2. 服务端 `settings['network.mode']` —— 跨设备/跨浏览器一致。

启动顺序：先用 `localStorage` 渲染 → `GET /api/bootstrap` 返回服务端值 → 若不一致以服务端为准（并回写 localStorage）。

### 6.4 自动模式的落地（按访问方式判定）

开启 `network.autoMode` 时，不依赖任何后端探测，而是在前端按**面板自身是怎么被访问的**落地：

| 访问主机 | 落地模式 | 说明 |
|---|---|---|
| IPv4 字面量（任意） | 内网 | `192.168.x.x`、`10.x.x.x`、`8.8.8.8` … |
| IPv6 字面量（含 `::1` / `::`） | 内网 | 域名不可能含冒号，含冒号即为 IPv6 字面量 |
| `localhost` / `*.localhost` | 内网 | 本机访问 |
| 其余（域名） | 外网 | 反向代理 / 公网域名 |

```ts
// src/shared/resolve-url.ts
export function isLanHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) return ipv4.slice(1).map(Number).every((n) => n <= 255)
  return host.includes(':')   // IPv6 字面量
}
```

**为什么不做服务端探测**：早期版本曾用 `ProbeService` 周期 TCP 探测各卡片的内网
地址，但探测结果与「我在不在内网」并不等价 —— 内网地址可能是域名、设备可能只开
ICMP、https 面板还会被浏览器以混合内容为由阻断探测请求，且引入 SSRF 攻击面与常驻
后台任务。改为按访问方式判定后逻辑完全前移到 `isLanHost` 纯函数：零 IO、零后台任务、
可单测，也彻底移除了 SSRF 风险。

### 6.5 顶栏开关交互

```
┌──────────────────────────────────────────────────────────┐
│  🔍 搜索…            [ 内网 | 外网 | 自动 ]      ⚙  ⛶    │
└──────────────────────────────────────────────────────────┘
```

- **分段控件**（segmented control）三态：内网 / 外网 / 自动。
- 「自动」选项按面板的访问方式实时落地，不依赖任何后端探测。
- 键盘快捷键：`Ctrl/Cmd + Shift + N` 循环切换。
- 切换时若存在打开的 iframe 小窗，弹出提示条：「网络模式已切换，N 个内嵌窗口需要重载」+「全部重载」按钮。
- 卡片角标：当实际使用的 URL 与全局模式不一致（例如全局内网但该卡片回退到外网），在卡片右上角显示来源标记。

### 6.6 已知限制（须在 UI 或文档中明示）

| 限制 | 说明 | 缓解 |
|---|---|---|
| 以 IP 访问但实际经公网 | 只要访问主机是 IP 就判为内网，不区分该 IP 是否可路由 | 需要精确控制时改用卡片级 `network_pref` 或手动切换 |
| iframe 内嵌被拦 | 目标站点 `X-Frame-Options: DENY` / CSP `frame-ancestors` | 打开前服务端 HEAD 预检，命中则提示改用新窗口 |

---

## 7. 硬件监控设计

### 7.1 采集项

| 分类 | 字段 | 来源（systeminformation） | 刷新 |
|---|---|---|---|
| CPU | 型号、厂商、物理/逻辑核心数、主频 | `si.cpu()` + `si.cpuFlags()` | 启动 + 60s |
| CPU | 总使用率、各核心使用率 | `si.currentLoad()` | 每次采样 |
| CPU | 负载均值 1/5/15 分钟 | `si.currentLoad()` | 每次采样 |
| CPU | 温度 | `si.cpuTemperature()` | 每次采样（可能不可用） |
| 内存 | 总量 / 已用 / 空闲 / 可用 | `si.mem()` | 每次采样 |
| 交换 | 总量 / 已用 | `si.mem()` | 每次采样 |
| 磁盘 | 各挂载点容量 / 已用 / 使用率 | `si.fsSize()` | 30s |
| 磁盘 | 读写速率 | `si.disksIO()` | 每次采样（需差分） |
| 网络 | 各网卡上下行速率 | `si.networkStats()` | 每次采样（需差分） |
| 网络 | 累计收发字节 | `si.networkStats()` | 每次采样 |
| GPU | 厂商、型号、驱动版本、显存总量 | `si.graphics()` | 启动 + 300s |
| GPU | 使用率、显存已用/空闲、温度、功耗、风扇转速、核心/显存频率 | `si.graphics()`（macOS 额外用 `ioreg` 补使用率与已用共享内存，见 §7.3） | 3s（独立于主循环，见 7.3） |
| GPU | 显示器列表（型号、分辨率、刷新率、连接方式） | `si.graphics()` | 启动 + 300s |
| 系统 | OS、内核、架构、主机名 | `si.osInfo()` | 启动 |
| 系统 | 运行时长 | `si.time().uptime` | 每次采样 |
| 系统 | 进程数、当前用户数 | `si.processes()` / `si.users()` | 30s |

### 7.2 采样快照格式

```ts
export interface SystemSnapshot {
  ts: number

  cpu: {
    usage: number            // 0-100
    perCore: number[]        // 每核心 0-100
    load: [number, number, number]
    temp: number | null      // °C，不可用时 null
    speed: number | null     // GHz
  }

  mem: {
    total: number            // bytes
    used: number
    free: number
    available: number
    swapTotal: number
    swapUsed: number
  }

  disks: Array<{
    fs: string               // 设备名 /dev/sda1
    mount: string            // 挂载点
    type: string             // ext4 / apfs / ntfs
    total: number
    used: number
    readBps: number          // 差分计算
    writeBps: number
  }>

  net: Array<{
    iface: string
    rxBps: number            // 差分计算
    txBps: number
    rxTotal: number
    txTotal: number
  }>

  /** GPU 动态指标。无可用 GPU 或指标不可获取时为空数组 */
  gpus: Array<{
    index: number
    vendor: string           // nvidia / amd / intel / apple
    model: string
    utilization: number | null      // 0-100，% —— 仅 NVIDIA 稳定可用
    memoryUsed: number | null       // bytes
    memoryTotal: number | null      // bytes
    memoryUtilization: number | null// 0-100，%
    temperature: number | null      // °C
    powerDraw: number | null        // W
    powerLimit: number | null       // W
    fanSpeed: number | null         // 0-100，%
    clockCore: number | null        // MHz
    clockMemory: number | null      // MHz
    /** 该 GPU 哪些指标是真实可用的 —— 避免 UI 显示一堆 "N/A" */
    available: Array<'utilization' | 'memory' | 'temperature' | 'power' | 'fan' | 'clock'>
  }>

  system: {
    uptime: number           // 秒
    processes: number
    users: number
  }
}

/** 不随时间变化的信息，单独接口返回并缓存 */
export interface SystemStaticInfo {
  cpu: { manufacturer: string; brand: string; cores: number; physicalCores: number; speed: number }
  os: { platform: string; distro: string; release: string; kernel: string; arch: string; hostname: string }
  disks: Array<{ fs: string; mount: string; type: string; size: number }>
  net: Array<{ iface: string; ifaceName: string; ip4: string; mac: string; speed: number | null }>
  gpus: Array<{
    index: number
    vendor: string
    model: string
    vram: number | null             // bytes，动态显存时可能不准
    vramDynamic: boolean            // Apple Silicon / 集显为 true（共享内存，无独立显存）
    driverVersion: string | null
    bus: string | null              // PCI 地址
  }>
  displays: Array<{
    vendor: string | null
    model: string
    resolutionX: number
    resolutionY: number
    refreshRate: number | null
    connection: string | null       // HDMI / DisplayPort / eDP
    main: boolean
  }>
}
```

### 7.3 MonitorService 设计

```ts
class MonitorService {
  private buffer = new RingBuffer<SystemSnapshot>(300)   // 默认 5 分钟 @1s
  private subscribers = new Set<(s: SystemSnapshot) => void>()
  private timer: Timer | null = null
  private prev: { disks: Map<string, IoCounters>; net: Map<string, IoCounters> } | null = null

  start() { this.reschedule() }

  /** 订阅者数量决定采样频率 —— 无人看时降频，省 CPU */
  private reschedule() {
    if (this.timer) clearInterval(this.timer)
    const ms = this.subscribers.size > 0
      ? settings.get('monitor.interval')            // 默认 1000
      : settings.get('monitor.hiddenInterval')      // 默认 10000
    this.timer = setInterval(() => void this.sample(), ms)
  }

  subscribe(fn) {
    this.subscribers.add(fn)
    this.reschedule()
    // 立即推一次缓冲里的最新值，避免新连接空窗
    const last = this.buffer.last()
    if (last) fn(last)
    return () => { this.subscribers.delete(fn); this.reschedule() }
  }

  private async sample() { /* si.* 采集 + 差分算速率 + 入缓冲 + 广播 */ }
}
```

**关键设计**：
- **进程级单例**，在 `src/server/index.ts` 中 `Bun.serve` 之前启动。
- **零订阅者时降频到 10s**（而非停止），保证用户切回页面时立即有数据。
- **速率靠差分**：`si.disksIO()` 与 `si.networkStats()` 返回的是累计计数器，需与上次采样做差除以时间间隔。
- **首次采样**只记录基线，速率字段为 0。
- **失败隔离**：任何一项 `si.*` 调用失败只影响该字段（置 `null` 或空数组），不中断整轮采样。
- **超时即失败**：卡死（既不 resolve 也不 reject）与抛异常同等对待 —— `safe()` 给每项采集套超时，静态信息 10s、高频采样 3s，超时同样降级为 fallback。没有这层预算的话，进程级资源耗尽（如 fd 打满）会让 `/api/system/info` 永久挂起，前端「关于」页整块空白（实测故障）。超时只是**放弃等待**，不中断底层调用，所以主循环与 GPU 采样器都必须有「同一轮不叠加执行」的守卫（`sampling` / `gpuSampling`）；`gpu-macos.ts` 的 `Bun.spawnSync` 是同步调用，天然不受超时保护（已知残留风险）。

#### GPU 采集的独立性（重要）

GPU 指标**不能跟随 1 秒主循环采集**，原因：

1. `si.graphics()` 在 NVIDIA 平台会 **spawn `nvidia-smi` 子进程**并解析输出。每秒 fork 一次进程，在低功耗 NAS 上开销可观。
2. 它同时返回大量静态信息（显示器列表、驱动版本、所有控制器），这些根本不需要高频刷新。
3. GPU 使用率本身变化比 CPU 慢得多，3 秒粒度足够。

因此设计为**独立采样器**：

```ts
class GpuSampler {
  private timer: Timer | null = null
  private latest: SystemSnapshot['gpus'] = []
  private staticInfo: SystemStaticInfo['gpus'] = []
  private displays: SystemStaticInfo['displays'] = []

  /** 启动时调一次，抓静态信息 + 判断哪些指标真实可用 */
  async init() {
    const g = await si.graphics()
    this.staticInfo = mapControllers(g.controllers)
    this.displays = mapDisplays(g.displays)
    this.latest = this.collectDynamic(g)   // 复用同一次调用，不浪费
  }

  /** 独立定时器，间隔取 settings['monitor.gpuInterval']（默认 3000ms） */
  start() { this.timer = setInterval(() => void this.tick(), interval) }

  private async tick() {
    // 无订阅者时跳过（GPU 无历史价值，不需要为了"回来时有数据"而空转）
    if (monitor.subscriberCount === 0) return
    const g = await si.graphics()
    this.latest = this.collectDynamic(g)
  }
}
```

主循环 `MonitorService.sample()` **不调用 `si.graphics()`**，而是直接读 `gpuSampler.latest` 拼进快照。这样快照里的 `gpus` 字段始终存在（可能是 3 秒前的值），前端无需处理字段缺失。

**`available` 字段的推导**：在 `collectDynamic()` 里对每个指标做有效性判断（非 `undefined`、非 `null`、非 `-1`、非 `NaN`），把可用的指标名列进 `available` 数组。前端据此**只渲染真实存在的指标**，而不是显示一排 `N/A`。这是 GPU 监控体验的关键——不同厂商暴露的指标差异极大。

#### GPU 指标可得性矩阵

| 指标 | NVIDIA (Linux/Win) | AMD (Linux, rocm-smi) | Intel 核显 | Apple Silicon (macOS) | 树莓派 VideoCore |
|---|---|---|---|---|---|
| 型号 / 显存总量 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 使用率 | ✅ | ✅ | ❌ | ✅ | ❌ |
| 显存已用 | ✅ | ✅ | ❌ | ⚠️ 仅已用¹ | ❌ |
| 温度 | ✅ | ✅ | ❌ | ❌ | ✅ |
| 功耗 | ✅ | ⚠️ 部分 | ❌ | ❌ | ❌ |
| 风扇转速 | ✅ | ⚠️ 部分 | ❌ | ❌ | ❌ |
| 核心频率 | ✅ | ⚠️ 部分 | ❌ | ❌ | ✅ |

> **结论**：GPU 监控的完整度**高度依赖平台和厂商驱动**，只有 NVIDIA + 官方驱动这一组合能拿到全套指标。因此：
> - 设计上必须容忍「有 GPU 但只有型号、没有任何动态指标」的情况，此时 UI 只显示一张静态的 GPU 信息卡（型号 + 显存 + 驱动版本），不显示图表。
> - macOS 上 `systeminformation` 不返回任何动态字段，但 **IORegistry 的 `IOAccelerator.PerformanceStatistics` 有** `Device Utilization %`（使用率）与 `In use system memory`（已用显存）。因此额外用系统自带的 `ioreg`（约 30ms）补齐这两项，见 `services/gpu-macos.ts`；温度 / 功耗 / 风扇 / 频率仍然拿不到。
> - 仍然必须容忍「有 GPU 但零动态指标」的情况（如未装驱动的核显、受限容器），此时 UI 只显示一张静态 GPU 信息卡。
> - 前端 `SystemStatDetail.vue` 的渲染逻辑：`available.length === 0` → 静态卡片；否则按 `available` 动态决定显示哪些指标。
>
> ¹ Apple Silicon 为统一内存，无固定显存上限，因此只上报「已用」（`memoryTotal: null`），卡片与弹窗只显示已用值。该字段在 `available` 中仍然算 `memory`。


### 7.4 SSE 推送

```ts
// src/server/routes/system.ts
app.get('/api/system/stream', (c) => {
  return streamSSE(c, async (stream) => {
    let closed = false
    const unsubscribe = monitor.subscribe((snap) => {
      if (closed) return
      void stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snap) })
    })

    // 心跳：防止中间代理因空闲断连
    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: String(Date.now()) })
    }, 15000)

    stream.onAbort(() => {
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
    })

    // 阻塞直到客户端断开
    await new Promise<void>((resolve) => stream.onAbort(resolve))
  })
})
```

**为什么不落库 / 不做 WebSocket**：
- 监控是**单向推送**，SSE 天然契合，且浏览器原生自动重连。
- WebSocket 需要额外的协议约定、心跳、重连逻辑，收益为零。

### 7.5 前端图表

- `useMonitorStream()` 建立 `EventSource`，断线自动重连（带指数退避）。
- `stores/monitor.ts` 维护本地固定长度数组（与后端一致的 300 点窗口）。
- ECharts 按需注册：`LineChart`、`GaugeChart`、`GridComponent`、`TooltipComponent`。
- **渲染节流**：SSE 每秒到达，但图表 `setOption` 限制为最多每 2 秒一次，避免不必要的重绘。
- 页面 `visibilitychange` 隐藏时：保留 SSE 连接（服务端已降频），暂停图表重绘。

### 7.6 平台限制

| 平台 | 限制 | 处理 |
|---|---|---|
| macOS | `si.cpuTemperature()` 需要额外权限/可选依赖，通常返回 -1 | `temp` 置 `null`，UI 隐藏该指标 |
| macOS | **GPU 完全没有动态指标**（Apple 不对外暴露），`si.graphics()` 只返回型号/显存 | `available` 为空数组 → 前端降级为静态 GPU 信息卡，不显示图表 |
| Linux | 温度需 `/sys/class/thermal` 可读或安装 `lm-sensors` | 同上；文档说明 |
| Linux + NVIDIA | `si.graphics()` 依赖 `nvidia-smi` 在 PATH 中 | 启动时检测，缺失则记 warn 日志并降级为静态信息 |
| Linux + AMD | 需要 `rocm-smi`；指标覆盖不完整 | `available` 数组按实际情况裁剪 |
| 非 root | 部分磁盘/进程/GPU 信息不可读 | 字段降级为 null；文档说明 |
| 容器内 | 看到的是容器视角而非宿主机（GPU 需 `--gpus all` + nvidia-container-toolkit） | 支持 `--proc-root /host/proc` 参数；文档给出挂载示例 |
| 树莓派 | VideoCore GPU 需 `vcgencmd`，仅温度与频率可用 | 尽力而为 |
| Windows | 大部分指标可用，网卡速率需注意；GPU 走 WMI + nvidia-smi | 尽力而为 |

> **开发期坑（macOS + `bun --watch` / `--hot`）**：`systeminformation` 会 `require` 两个可选
> 原生依赖（`osx-temperature-sensor` / `macos-temperature-sensor`）读温度。本项目按 ADR-001
> 不装原生依赖，而 Bun 在 watch / hot 模式下**模块解析失败**时每次会泄漏一个目录 fd
> （`si.cpuTemperature()` 2 个、`si.graphics()` 1 个，合计约 2.3 个/秒）。fd 打满后 `si.*`
> 既不 resolve 也不 reject，静态信息整块降级成空 —— 表现是首页只剩 CPU / RAM / SYS 三张卡、
> 「添加卡片」没有任何设备候选。仓库在 `vendor/si-optional-stubs/` 放了两个纯 JS 占位模块，
> 以 `file:` 依赖安装，让 require 解析成功、从根上不触发这条路径。
> 另外静态信息只在**本轮零失败**时才进 5 分钟缓存，避免一次资源耗尽把空设备清单钉住 5 分钟。

---

## 8. API 契约

所有接口前缀 `/api`。请求/响应均为 JSON（除文件上传与资源读取）。所有写操作经 Zod 校验。

### 8.1 通用约定

- **错误响应**：`{ error: { code: string; message: string; details?: unknown } }`
- **HTTP 状态码**：200 成功 / 201 创建 / 204 删除成功 / 400 参数错 / 401 未授权 / 404 不存在 / 409 冲突 / 413 超限 / 429 限流 / 500 服务端错误
- **时间戳**：一律 Unix 毫秒（`number`）
- **字段命名**：JSON 用 camelCase，DB 列用 snake_case，由 Drizzle 映射

### 8.2 启动数据

#### `GET /api/bootstrap`

一次请求拿到首屏全部数据，避免瀑布式请求。

**响应 200**：`BootstrapPayload`（见 5.3）

未通过口令校验时返回 `401` + `{ error: { code: 'LOCKED' } }`。

### 8.3 卡片

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/items` | 创建卡片 |
| `PATCH` | `/api/items/:id` | 部分更新 |
| `DELETE` | `/api/items/:id` | 删除 |
| `POST` | `/api/items/reorder` | 批量重排（含跨分组） |

**`POST /api/items` 请求体**（`ItemCreateSchema`）：

```ts
{
  groupId: number | null,
  title: string,                    // 1-24 字符（再长卡片上会省略号截断）
  subtitle?: string | null,         // ≤ 128
  iconType: 'iconify' | 'asset' | 'text' | 'favicon',
  iconValue?: string | null,
  iconColor?: string | null,        // CSS 颜色
  bgColor?: string | null,
  lanUrl?: string | null,           // 合法 URL 或空
  wanUrl?: string | null,
  networkPref?: 'auto' | 'lan' | 'wan',
  openMode?: 'newTab' | 'iframe' | 'self',
  sort?: number,
  enabled?: boolean
}
```

**跨字段校验**（Zod `.refine`）：`lanUrl` 与 `wanUrl` 不可同时为空。

**`POST /api/items/reorder` 请求体**：

```ts
{ order: Array<{ id: number; groupId: number | null; sort: number }> }
```

在单个事务中批量更新。

### 8.4 分组

| 方法 | 路径 |
|---|---|
| `POST` | `/api/groups` |
| `PATCH` | `/api/groups/:id` |
| `DELETE` | `/api/groups/:id` |
| `POST` | `/api/groups/reorder` |

删除分组时，组内卡片 `group_id` 置 `NULL`（外键 `ON DELETE SET NULL`），**不级联删除卡片**。

### 8.5 资源（图标 / 壁纸）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/assets` | 列表（不含 BLOB），支持 `?kind=icon` |
| `POST` | `/api/assets` | `multipart/form-data` 上传，字段 `file` + `kind` |
| `GET` | `/api/assets/:id` | 读取二进制，`Cache-Control: public, max-age=31536000, immutable` |
| `DELETE` | `/api/assets/:id` | 删除（若被卡片引用，返回 409 并列出引用者） |

上传响应：`{ id, kind, name, mime, size, url }`

> ⚠️ **实现修正**：`mime` 由服务端按**文件头 magic bytes 嗅探**得出，不接受客户端的
> `file.type` 声明（实测 Bun 的 fetch 会忽略 `File.type` 而按文件名后缀推断 part 的
> Content-Type，因此该字段完全由客户端摆布）。详见附录 D.1。
>
> 另注：`assets.id` 为内容哈希，因此**同一份字节以不同 `kind` 上传会复用同一条记录**，
> `kind` 保持首次上传的值 —— 内容寻址存储的预期行为，避免重复占用空间。
>
> SVG 响应会附加 `Content-Security-Policy: default-src 'none'; …; sandbox`，
> 防止用户直接打开 `/api/assets/<id>` 时执行 SVG 内嵌脚本。


### 8.6 Favicon 抓取

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/favicon` | 请求体 `{ url: string }`，抓取并缓存，返回 `{ assetId, url }` |

抓取逻辑：
1. 请求目标站点 HTML，解析 `<link rel="icon">` / `<link rel="shortcut icon">` / `<link rel="apple-touch-icon">`。
2. 找不到则回退 `GET /favicon.ico`。
3. 校验响应是图片类型且 ≤ 512KB。
4. 存为 `assets.kind = 'favicon'`，内容哈希去重。
5. 全流程 5s 超时；只允许 http/https，拒绝链路本地 / 云元数据端点（`169.254.0.0/16`、`metadata.google.internal`、`*.internal`），其余（含公网域名）均可抓取。

**缓存策略**：以源站 host 为键查缓存（`settings` 或 `assets.name` 记录来源），命中直接返回，避免重复抓取。

### 8.7 系统监控

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/system/info` | `SystemStaticInfo`，缓存 60s |
| `GET` | `/api/system/stream` | SSE 流，事件 `snapshot` / `ping` |
| `GET` | `/api/system/history` | 当前环形缓冲全量（用于页面重新聚焦时补齐） |

### 8.8 设置

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/settings` | 全部设置 |
| `PATCH` | `/api/settings` | 部分更新，`{ [key]: value }` |

### 8.9 备份

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/backup/export` | 导出 JSON（含分组、卡片、设置、可选内嵌资源 base64） |
| `POST` | `/api/backup/import` | 导入，`?mode=merge\|replace` |

### 8.10 口令（可选）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/auth/state` | `{ enabled: boolean; unlocked: boolean }` |
| `POST` | `/api/auth/unlock` | `{ password }` → 设置签名 Cookie |
| `POST` | `/api/auth/lock` | 清除 Cookie |
| `POST` | `/api/auth/password` | 设置/修改口令（需已解锁） |

**实现**：`Bun.password.hash(pw, { algorithm: 'argon2id' })` + 签名 Cookie（密钥为 `data/secret.key`，首次启动生成 32 随机字节，`chmod 600`）。登录失败限流：每 IP 每分钟 5 次。

### 8.11 其他

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/healthz` | `{ status: 'ok', uptime, version }` |

---

## 9. 单文件构建方案 ★

### 9.1 构建流水线

```
bun run build
  │
  ├─ [1] vite build
  │      产出 dist/  (index.html + assets/*.js + assets/*.css + ...)
  │
  ├─ [2] bun run scripts/gen-assets.ts
  │      扫描 dist/ 与 drizzle/ ，生成 src/server/generated/assets.ts
  │      每条资源一行 `import ... with { type: 'file' }`
  │
  ├─ [3] bun build --compile --minify \
  │        --target=bun-linux-x64 \
  │        --outfile release/starm-panel-linux-x64 \
  │        src/server/index.ts
  │
  └─ [4] (可选) 交叉编译其余目标平台
```

### 9.2 资源嵌入机制（关键实现）

**不要用 glob** —— `bun build --compile entry.ts dist/**/*` 有已知缺陷（见 11 章风险登记册）。改为**构建期生成显式 import 清单**：

```ts
// scripts/gen-assets.ts
import { Glob } from 'bun'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, relative } from 'node:path'

const ROOTS = [
  { dir: 'dist',     prefix: '/' },        // 前端产物 -> 根路径
  { dir: 'drizzle',  prefix: '/migrations/' }, // 迁移 SQL
]

const entries: Array<{ key: string; file: string; varName: string }> = []
for (const { dir, prefix } of ROOTS) {
  for (const file of new Glob('**/*').scanSync({ cwd: dir, onlyFiles: true, absolute: false })) {
    const varName = `f_${entries.length}`
    entries.push({ key: prefix + file.replaceAll('\\', '/'), file, varName })
  }
}

const out = [
  `// 本文件由 scripts/gen-assets.ts 自动生成，请勿手动编辑。`,
  `// 生成时间：${new Date().toISOString()}`,
  `// 资源数量：${entries.length}`,
  '',
  ...entries.map((e, i) =>
    `import ${e.varName} from ${JSON.stringify('../../' + e.dir + '/' + e.file)} with { type: 'file' }`),
  '',
  'export const assets: ReadonlyMap<string, string> = new Map([',
  ...entries.map(e => `  [${JSON.stringify(e.key)}, ${e.varName}],`),
  '])',
  '',
  `export const assetCount = ${entries.length}`,
  '',
].join('\n')

mkdirSync('src/server/generated', { recursive: true })
writeFileSync('src/server/generated/assets.ts', out)
console.log(`[gen-assets] 嵌入 ${entries.length} 个资源`)
```

生成的产物形如：

```ts
import f_0 from '../../dist/index.html' with { type: 'file' }
import f_1 from '../../dist/assets/index-a1b2c3d4.js' with { type: 'file' }
import f_2 from '../../dist/assets/index-e5f6g7h8.css' with { type: 'file' }
// ...

export const assets: ReadonlyMap<string, string> = new Map([
  ['/index.html', f_0],
  ['/assets/index-a1b2c3d4.js', f_1],
  ['/assets/index-e5f6g7h8.css', f_2],
  // ...
])
```

### 9.3 静态资源服务

```ts
// src/server/static.ts
import { assets } from './generated/assets'

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', ico: 'image/x-icon', woff2: 'font/woff2',
}

/** 带哈希的构建产物 —— 永不变化，可永久缓存 */
const IMMUTABLE = /\/assets\/.+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|jpe?g|svg|webp)$/

export function registerStatic(app: Hono) {
  app.get('*', async (c) => {
    const pathname = c.req.path === '/' ? '/index.html' : c.req.path
    const embedded = assets.get(pathname)          // 返回嵌入文件路径（/$bunfs/...）

    if (embedded) {
      const ext = pathname.split('.').pop() ?? ''
      const headers: Record<string, string> = {
        'content-type': MIME[ext] ?? 'application/octet-stream',
      }
      headers['cache-control'] = IMMUTABLE.test(pathname)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache'
      // API 之外的 GET 才走这里，故无鉴权顾虑
      return new Response(Bun.file(embedded), { headers })
    }

    // SPA fallback：非 API、非静态资源的路径一律交给前端路由
    const index = assets.get('/index.html')
    if (!index) return c.text('index.html not found in bundle', 500)
    return new Response(Bun.file(index), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    })
  })
}
```

**必须遵守的约束**：
- ❌ **不要**用 `Bun.serve({ routes: { '/x/*': { dir: <嵌入路径> } } })` —— 已知会在启动时 abort。
- ❌ **不要**用 `Bun.Glob` 去扫 `Bun.embeddedFiles` —— 扫不到；如需枚举请用 `node:fs` 的 `readdir`。
- ✅ 只用 `Bun.file(<嵌入路径>)` 手工构造 `Response`。

### 9.4 迁移文件嵌入

Drizzle 的迁移 SQL 也必须嵌入（否则运行时找不到文件）：

```ts
// src/server/db/migrate.ts
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assets } from '../generated/assets'

// drizzle-orm 的 migrator 需要真实文件系统路径。
// SQLite 迁移很小，改为把 SQL 内容读出来后用 db.run() 手动执行，
// 并用 PRAGMA user_version 记录已应用版本，避免依赖虚拟文件系统。
```

> **实现建议**：M1 阶段先用**手写的迁移列表**（`migrations = [{ version: 1, sql: '...' }]`，用 `PRAGMA user_version` 跟踪），零依赖、可嵌入、可控。等 schema 稳定后再评估是否引入 drizzle-kit 生成 + 自定义嵌入。

### 9.5 构建脚本

```json
{
  "scripts": {
    "dev":            "bun run --parallel dev:server dev:web",
    "dev:server":     "bun --watch src/server/index.ts",
    "dev:web":        "vite",
    "build":          "bun run build:web && bun run build:assets && bun run build:bin",
    "build:web":      "vite build",
    "build:assets":   "bun run scripts/gen-assets.ts",
    "build:bin":      "bun build --compile --minify --target=bun-linux-x64 --outfile release/starm-panel-linux-x64 src/server/index.ts",
    "build:all":      "bun run scripts/build-all.ts",
    "typecheck":      "vue-tsc --noEmit",
    "lint":           "eslint .",
    "test":           "bun test"
  }
}
```

### 9.6 体积预算（预期）

| 组成 | 预估 |
|---|---|
| Bun 运行时基线 | ~55–60MB |
| Vue + Router + Pinia | ~100KB |
| Naive UI（摇树后） | ~200KB |
| ECharts（按需） | ~300KB |
| Iconify 图标集 ×3 | ~3–4MB |
| 其他 | ~200KB |
| **合计** | **~60–70MB** |

> ⚠️ 单文件 ≠ 小文件。Bun 会把整个运行时嵌入。这是选择 Bun 路线的既定代价，需在项目 README 中明示。

---

## 10. 前端设计

### 10.1 路由

| 路径 | 视图 | 说明 |
|---|---|---|
| `/` | `HomeView` | 桌面：卡片墙 + 监控面板 |
| `/settings` | `SettingsView` | 设置（标签页：通用 / 外观 / 监控 / 数据 / 关于） |
| `/lock` | `LockView` | 口令解锁页（仅在 `auth.enabled` 时可达） |

### 10.2 Store 职责

| Store | 状态 | 说明 |
|---|---|---|
| `network` | `mode`, `autoMode`, `effectiveMode`, `resolve()` | ★ 内外网切换核心 |
| `items` | `groups`, `items`, CRUD actions | 乐观更新 + 失败回滚 |
| `monitor` | `latest`, `history[300]`, `connected` | SSE 快照与趋势 |
| `settings` | 全部配置项 | 与 `/api/settings` 同步 |

### 10.3 组件树

> ⚠️ 本节已按 §10.6 的 UI 方向修订。实现中的实际文件名与此略有出入
> （如 `CardEditor.vue` 对应下方的 `ItemEditor.vue`、`FaviconGlyph.vue` 承担离线图标渲染）。

```
App.vue                              # 外壳：NConfigProvider 主题同步 + 壁纸层
├─ Wallpaper.vue                     # 背景层（固定，z-index -1）
├─ FloatingControls.vue              # 右上角浮动按钮组（不再是常驻顶栏）
│   ├─ SearchBox.vue                 #   搜索（标题/副标题/解析后 host）
│   ├─ NetworkSwitch.vue             # ★ 内网/外网/自动 三态分段控件
│   └─ 主题切换 / 设置入口
├─ HomeView.vue
│   ├─ HeroHeader.vue                #   居中：大标题 │ 时钟 + 日期
│   ├─ 系统状态区（按 monitor.cards 顺序）
│   │   └─ SystemStatCard.vue        #   硬件卡片，按 kind 渲染
│   │       └─ SystemStatDetail.vue  #   ★ 点击卡片弹出的详情弹窗
│   ├─ GroupSection.vue  (v-for groups)
│   │   └─ ItemCard.vue              #   与硬件卡片同一视觉语言
│   └─ GroupSection.vue  (未分组)
├─ CardEditor.vue                    # 新增/编辑卡片弹窗
│   ├─ 图标选择器（上传 / 文字 / 抓取 / 图标库 一级菜单，动作在预览框上）
│   └─ 内外网双地址 + 网络偏好 + 打开方式
├─ EmbedLayer.vue                    # iframe 内嵌小窗层
└─ BootNotice.vue                    # 启动/错误提示
```

**硬件卡片类型**（`monitor.cards` 的合法取值）：

| kind | 卡片显示 | 弹窗显示 |
|---|---|---|
| `cpu` | 总使用率 + 进度条 | 每核心条形、负载 1/5/15、温度（无则隐藏）、型号与核心数 |
| `memory` | 已用/总量 + 进度条 | 已用/空闲/可用/交换、分段条 |
| `disk` | 每个挂载点一张：已用/总量 + 进度条 | 容量、文件系统、设备名、读写速率 |
| `network` | 每块网卡一张：上下行速率 | 累计流量、IP/MAC/链路速率 |
| `gpu` | 每块 GPU 一张：使用率（无动态指标时只显示型号） | `available` 驱动，无指标则显示提示文案 |
| `system` | 运行时长 | 主机名/发行版/内核/架构/进程数/用户数 |

### 10.4 交互细节

**硬件卡片**：
- 单击 → 打开详情弹窗。
- 分区标题「系统状态」悬停时浮现隐藏的「编辑」开关，点击进入编辑模式。
- 编辑模式下：卡片右上角显示移除角标（点击移除**该设备**这一张卡，移除前弹 `useDeleteConfirm` 确认弹窗，可在「添加卡片」重新加回），可直接拖拽卡片调整顺序（按设备粒度）；末尾「添加卡片」位浮层**逐台列出可添加的设备**（如「磁盘 /data」「网卡 eth0」「GPU #1」），点一下即追加。
- `monitor.cards` 中的「自动」条目（旧值 / 默认值，无 `device`）仍按设备展开，且跳过已被显式条目占用的设备；对自动展开出来的卡片做移除 / 拖拽时，先把该类型物化成显式设备条目，保持行为可预测。
- 「添加卡片」位仅在**编辑模式或暂无卡片**时出现，其余时候不占位。
- 非编辑模式不显示任何操作图标，界面保持干净。
- `gpu` 在无 GPU 设备时整卡跳过，添加浮层里也会置灰。

**卡片**：
- 单击 → 按 `openMode` 打开解析后的 URL。
- 右键 → 上下文菜单（编辑 / 复制链接 / 在新窗口打开）。删除只从编辑模式的移除角标与卡片编辑器里发起，右键菜单不提供删除。默认不显示常驻操作图标。
- 删除卡片一律走 `/composables/useDeleteConfirm.ts` 的应用内弹窗确认（标题 + 「删除后无法恢复」提示），取消则不发请求；卡片编辑器在 `NPopconfirm`（一级）之后还会再弹一次该弹窗（二级确认）。
- 「APP」分区标题悬停时浮现隐藏的「编辑」开关；编辑模式下卡片右上角显示移除角标，且单击卡片改为打开编辑器（不跳转链接）。
- 「新建卡片」位（分组标题旁的 + 与网格末尾的卡片位）仅在**编辑模式或该分组暂无卡片**时出现。
- 与全局模式不一致时才显示来源角标（如「内网」「外网」）；`networkPref` 非 `auto` 的卡片显示小锁图标，提示「已固定」。

**图标选择器**（在 `CardEditor.vue` 内，`FaviconGlyph.vue` 负责离线渲染）：
一级菜单选来源（上传 / 文字 / 抓取 / 图标库），四种来源的动作统一由左侧预览框触发，
控件全部塞在「一级菜单 + 预览行」里，因此切来源不会改变弹窗高度：

1. **图标库** — 点预览框弹出图标列表（10 组 247 个）带搜索。数据是**本地常量**：
   构建期从 Iconify 的 `mdi` + `simple-icons` 取单 path 图标，内联进 `FaviconGlyph` 的 `GLYPHS`，
   运行时不联网；未收录的名字按名称哈希出几何字形兑底（同一名字永远同一形状）。
2. **上传** — 预览框是「+」，点击选文件；单文件 ≤ 256KB，优先 `POST /api/assets`，失败回落 dataURL。
3. **文字** — 取标题首字符（支持 emoji），前景/背景取色器并进预览行（带透明度滑块，色块里不显示色值）。
4. **抓取** — 按选中的「内网 / 外网」地址调 `/api/favicon`（内网优先，按钮只切来源不发请求）；
   抓不到直接报错，**不写任何占位地址**。

**拖拽排序**：`vue-draggable-plus`，跨分组拖拽，`onEnd` 时收集完整顺序调 `/api/items/reorder`。乐观更新 + 失败回滚。

**搜索框**：
- 引擎列表可配（名称 + `{q}` 模板 + 图标）。
- 支持 bang 语法：`gh vue` → GitHub 搜索 `vue`。
- 快捷键：`/` 或 `Ctrl/Cmd+K` 聚焦；`Tab` 切换引擎；`Esc` 清空。

### 10.5 响应式布局

| 断点 | 布局 |
|---|---|
| ≥ 1280px | 卡片 6 列 |
| 768–1279px | 卡片 4 列 |
| < 768px | 卡片 2 列；英雄区标题与时钟改为上下排列 |

### 10.6 ★ UI 方向修订：硬件信息即卡片

> **背景**：初版实现把硬件监控做成了**右侧常驻侧栏**（`MonitorPanel.vue`），
> 这是错误的方向。用户要求对齐 Sun-Panel 的信息架构（参考图见
> `docs/reference/sun-panel-ui.webp`）。

**修订后的首页结构**：

```
┌──────────────────────────────────────────────────────┐
│                                        [浮动控制按钮组] │  ← 搜索/网络切换/主题/设置
│                                                      │
│              StarM Panel │ 23:16                     │  ← 居中英雄区：标题 + 时钟
│                          9-29 星期二                  │
│                                                      │
│  系统状态                                             │  ← 分区标题
│  ┌────────┐ ┌────────┐ ┌────────┐                    │
│  │💻 CPU   │ │🧠 RAM   │ │💾 /     │  ← 硬件卡片，与 App │
│  │  1.51% │ │1.6/3.9G│ │27/58GB │     卡片同一视觉语言 │
│  │ ▓▓░░░░ │ │ ▓▓▓░░░ │ │ ▓▓▓▓░░ │                    │
│  └────────┘ └────────┘ └────────┘                    │
│                                                      │
│  APP                                                 │
│  ┌────────┐ ┌────────┐ ┌────────┐                    │
│  │  图标   │ │  图标   │ │   ＋    │                    │
│  └────────┘ └────────┘ └────────┘                    │
│                                                      │
│                Powered By StarM Panel                │  ← 居中、很淡
└──────────────────────────────────────────────────────┘
```

**关键设计决策**：

| 决策 | 说明 |
|---|---|
| 硬件信息不再有专属侧栏 | 与 App 卡片共用同一个网格与卡片语言，信息层级扁平 |
| 卡片只显示「一眼可读」的一个数值 + 进度条 | 详情收进弹窗，避免首页噪音 |
| **点击卡片弹出详情弹窗** | 每核心 CPU、磁盘 IO、网卡明细、系统静态信息等都在弹窗内 |
| 展示哪些卡片在首页直接增删 | `monitor.cards`（数组顺序 = 展示顺序）；分区标题悬停显示「编辑」开关，编辑模式下末尾「添加卡片」位**按设备**新增、卡片右上角按设备移除、按设备拖拽排序（`disk` 挂载点 / `network` 网卡 / `gpu` 设备序号） |
| 常驻顶栏改为右上浮动按钮组 | 减少视觉重量，让英雄区成为视觉焦点 |
| 移除了 `MonitorPanel.vue` 的侧栏用法 | 内部渲染逻辑拆入详情弹窗复用 |
| `ui.showClock` / `ui.title` | 英雄区可按用户偏好定制 |

**GPU 卡片的特殊处理（延续 §7.3）**：`available` 为空数组时跳过渲染该卡片；
若用户强制开启，则卡片只显示静态信息（型号/显存/驱动），点开的弹窗显示
「该平台不暴露 GPU 动态指标」而**不渲染任何空图表**。

---

## 11. 配置、数据目录与 CLI

### 11.1 数据目录

```
<data-dir>/
├── app.db          # SQLite 主库（含图标/壁纸 BLOB）
├── app.db-wal      # WAL 日志（运行时存在）
├── app.db-shm      # 共享内存索引（运行时存在）
└── secret.key      # 会话签名密钥，32 字节随机，权限 0600
```

**解析优先级**：
1. `--data-dir <path>` 命令行参数
2. `STARM_DATA_DIR` 环境变量
3. `./data`（当前工作目录）
4. `~/.starm-panel`

首次启动自动创建目录与文件。目录不可写时**立即以清晰错误信息退出**（退出码 1），不静默降级。

### 11.2 命令行接口

```
starm-panel [options]

选项：
  --port <number>        监听端口（默认 3002）
  --host <string>        监听地址（默认 0.0.0.0）
  --data-dir <path>      数据目录（默认 ./data）
  --base-url <path>      子路径部署前缀（默认 /）
  --log-level <level>    debug | info | warn | error（默认 info）
  --reset-password       清除访问口令后退出
  --version              显示版本
  --help                 显示帮助
```

### 11.3 子路径部署

支持 `--base-url /panel` 部署在反向代理子路径下：
- 前端 Vite `base` 配置为运行时注入（通过 `/api/bootstrap` 返回或在 `index.html` 中占位替换）。
- 后端所有路由挂载到该前缀。

---

## 12. 里程碑与验收标准

### M0 — 可行性验证（0.5 天）★ 最优先

**目标**：在写任何业务功能之前，先证明「单文件打包 + 交叉编译 + 嵌入前端 + 内嵌 SQLite」全链路跑通。

**内容**：
1. `bun init`，装 Hono，写一个返回 `{"ok":true}` 的 API。
2. Vite + Vue 建一个显示该 API 结果的页面。
3. 跑通 9.1 的三步构建流水线。
4. `scp` 二进制到一台 Linux 机器（或本机 Linux 容器）直接执行，浏览器能访问。

**验收**：生成的 `starm-panel-linux-x64` 单文件在无 Bun、无 Node 的 Linux 上运行，页面正常显示 API 数据。

> **为什么 M0 必须最先做**：嵌入资源 + 交叉编译是整个方案中唯一有已知 Bun 缺陷的部分。若此处受阻，整个架构需要调整（退路见 13 章）。绝不能等到功能写完才发现打不出包。

### M1 — 卡片核心（2 天）

- `groups` / `items` 表 + 迁移框架（`PRAGMA user_version`）
- `GET /api/bootstrap`、items / groups 全套 CRUD
- 桌面视图渲染分组与卡片
- 卡片编辑器（标题、图标、URL、打开方式）

**验收**：能创建分组、增删改卡片、刷新后数据持久化。

### M2 — 内外网切换（1.5 天）★ 核心功能

- `shared/resolve-url.ts` + 单元测试（覆盖全部 3×3 优先级矩阵）
- `network` store + 顶栏分段控件（`network.autoMode` 开启时按访问方式落地）
- 卡片来源角标 + iframe 切换提示

**验收**：全局切换到外网模式，所有卡片立即使用 `wanUrl`；卡片级固定为内网的卡片不受影响；以域名访问面板时 `auto` 落地为外网，以 IP 访问时落地为内网。

### M3 — 硬件监控（2.5 天）

- `MonitorService`（采集 + 差分 + 环形缓冲 + 订阅降频）
- `GpuSampler`（独立 3s 采样 + `available` 推导 + 静态信息）
- `GET /api/system/info` + `/api/system/stream`（SSE）
- 前端 SSE 订阅 + 图表组件（含 `GpuPanel` 的降级路径）

**验收**：监控面板实时刷新；关闭浏览器标签页后服务端采样降频（可通过日志验证）；重新打开立即有数据；**在无动态 GPU 指标的机器（如 macOS）上不显示空白图表**。

### M4 — 打磨（2 天）

- 图标选择器四个标签页 + 上传接口 + favicon 抓取
- 拖拽排序
- 壁纸与主题
- 搜索框
- 导入导出

**验收**：全部 P1 需求可用；导出的 JSON 能在全新数据目录导入还原。

### M5 — 可选增强

- 访问口令（argon2id + 签名 Cookie + 限流）
- Docker 容器状态（可能需要 `--docker-sock` 参数）
- 国际化

**总计**：约 8 个工作日（M0–M4）。

---

## 13. 风险登记册

| # | 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|---|
| R1 | `bun build --compile` 嵌入目录失败（已知缺陷 [#21977](https://github.com/oven-sh/bun/issues/21977)、[#40932](https://github.com/oven-sh/bun/issues/40932)） | 中 | 高 | **使用显式 import 清单而非 glob**（见 9.2）；M0 阶段最先验证 |
| R2 | `Bun.serve` 静态目录路由指向嵌入路径导致启动 abort（[#40778](https://github.com/oven-sh/bun/issues/40778)） | 中 | 高 | **不使用 `routes.dir`**，只用 `Bun.file()` 手工响应 |
| R3 | 单文件体积 ~60–70MB 超出预期 | 高 | 低 | 已知并接受；README 明示；如需更小可提供「二进制 + public 目录」的替代分发包 |
| R4 | `systeminformation` 在 Bun 上的兼容性问题 | 中 | 高 | M3 之前先做冒烟测试；退路：用 `Bun.spawn` 直接读 `/proc`（Linux-only）或降级为部分指标 |
| R5 | 交叉编译（macOS → Linux）产物在目标机无法启动 | 中 | 高 | M0 阶段在真实目标机上验证；退路：在目标机或 CI（Linux runner）上原生构建 |
| R6 | macOS 无法获取 CPU 温度 | 高 | 低 | `temp` 字段设为 `null`，UI 自动隐藏该指标 |
| R7 | 非 root / 容器中读不到完整系统信息 | 高 | 中 | 提供 `--proc-root` 参数；文档给出挂载示例；字段级降级 |
| R10 | Iconify 图标集体积导致前端产物过大 | 高 | 低 | 只收录 2–3 个集合；提供上传 SVG 作为无限扩展手段 |
| R11 | iframe 打开被目标站 `X-Frame-Options` 拦截，表现为白屏 | 高 | 中 | 打开前服务端 HEAD 预检 `X-Frame-Options` / `frame-ancestors`；命中则提示改用新窗口 |
| R12 | SQLite WAL 伴生文件导致备份不完整 | 中 | 中 | 导出接口在事务内读取；文档说明备份需先 `PRAGMA wal_checkpoint(TRUNCATE)` |
| R13 | Bun 版本升级引入回归 | 中 | 中 | 固定 `packageManager` 字段；二进制内置运行时，升级需显式重新构建 |
| R14 | 用户本机 `~/.npm` 权限异常导致依赖安装失败（已实测） | — | 低 | 使用 Bun 安装依赖（`bun install`）不走 npm；必要时修复 `~/.npm` 属主 |
| R15 | GPU 指标在不同厂商/平台差异极大，用户期望与实际严重不符 | 高 | 中 | `available` 数组驱动 UI；`available` 为空时只显示静态信息卡；文档给出可得性矩阵（§7.3） |
| R16 | `si.graphics()` 每次调用 spawn `nvidia-smi`，高频采样拖垮低功耗设备 | 中 | 中 | **独立 3s 采样器**，不跟随 1s 主循环；无订阅者时直接跳过 |
| R17 | NVIDIA 驱动未装时 `nvidia-smi` 缺失，采集抛异常 | 中 | 低 | 启动时探测并记 warn；异常被字段级失败隔离吞掉，不影响其他指标 |

---

## 14. 待决问题

在进入 M1 前需要确认：

| # | 问题 | 备选 | 建议 |
|---|---|---|---|
| Q1 | 前端 UI 组件库 | Naive UI / Element Plus / 不引入手写 | **Naive UI**（TS 优先、主题变量强、摇树友好） |
| Q2 | 收录哪些 Iconify 图标集 | mdi / lucide / simple-icons / tabler / ph | **mdi + lucide + simple-icons**（覆盖最广；simple-icons 用于品牌 logo） |
| Q3 | 是否需要访问口令 | 是 / 否 | 建议**做但默认关闭**（R10，P2） |
| Q4 | 壁纸来源 | 纯色 / 渐变 / 本地上传 / Bing 每日 | 先做**渐变 + 本地上传**；Bing 每日需外网，内网场景价值低，可作为开关 |
| Q5 | 是否需要 Docker 容器状态 | 是 / 否 | 建议**暂不做**（与「轻量」目标冲突，且需 socket 挂载） |
| Q6 | 默认监听地址 | `0.0.0.0` / `127.0.0.1` | **`0.0.0.0`**（面板本身就要被内网其他设备访问） |
| Q7 | 是否需要子路径部署支持 | 是 / 否 | 建议**做**（`--base-url`），反代场景常见 |
| Q8 | 监控数据窗口长度 | 300 点(5min) / 1800 点(30min) | **300 点**起步，做成可配置 |

---

## 附录 A：与 Sun-Panel 的对比

| 维度 | Sun-Panel | StarM-Panel |
|---|---|---|
| 前端 | Vue 3 + TS + Less | Vue 3 + TS + UnoCSS |
| 后端 | Go + Gin + GORM | Bun + Hono + Drizzle |
| 数据库 | SQLite | SQLite（`bun:sqlite`） |
| 分发 | Docker 镜像 / Go 二进制 | 单文件可执行（交叉编译） |
| 多用户 | 支持 | ❌ 刻意不做 |
| 内外网切换 | 全局开关 + 卡片双地址 + 自动探测 | 同左，但**解析逻辑抽为共享纯函数**、可选的「按访问方式（IP/域名）自动选择」、零探测零后台任务 |
| 图标 | Iconify API / 内置 | 离线打包 Iconify + 上传 + favicon 抓取 |
| 系统监控 | 有 | 有（SSE 推送 + 环形缓冲 + 无订阅降频） |
| 资源占用 | Go 二进制约 25MB | 单文件约 60–70MB（代价：单文件零依赖分发） |

**Sun-Panel 的架构更省资源**（Go 二进制小一个数量级）。StarM-Panel 选择 Bun 的核心理由是**全栈 TypeScript + 零原生依赖的交叉编译单文件**，这是取舍而非优劣。若体积是关键约束，应回到 Go 方案（见 ADR-001 被否决方案）。

## 附录 B：参考链接

- [Sun-Panel 仓库](https://github.com/hslr-s/sun-panel/)
- [Bun 单文件可执行文档](https://bun.com/docs/bundler/executables)
- [Bun 1.4 发布说明](https://bun.com/blog/bun-v1.4)
- [Bun.embeddedFiles API](https://bun.com/reference/bun/embeddedFiles)
- [Hono 文档](https://hono.dev/docs/)
- [Hono Bun 适配器](https://hono.dev/docs/getting-started/bun)
- [Drizzle ORM - Bun SQLite](https://orm.drizzle.team/docs/sqlite/connect-bun-sqlite)
- [systeminformation 文档](https://systeminformation.io/)
- [Iconify](https://iconify.design/)

---

## 附录 C：M0 可行性验证结果

> 验证时间：2026-09-29 · Bun 1.4.2 · 构建机 macOS 27.0 / Apple M2 (arm64)

### C.1 验证矩阵

四个目标全部在**真实运行环境**中启动并通过 HTTP 自检（非仅编译成功）：

| 目标 | 实测体积 | 验证环境 | 结果 |
|---|---|---|---|
| `bun-darwin-arm64` | 59.6 MB | macOS 27.0 / M2（拷贝到空目录运行，无 `dist/`） | ✅ |
| `bun-linux-arm64` | 81.6 MB | `debian:stable-slim` @ linux/arm64 (Docker) | ✅ |
| `bun-linux-x64` | 81.7 MB | `debian:stable-slim` @ linux/amd64 (Docker，跨架构模拟) | ✅ |
| `bun-linux-arm64-musl` | 74.8 MB | `alpine:latest` + `apk add libstdc++` | ✅（需补依赖，见 C.3） |

每一项均验证了：进程启动、`/healthz` 响应、**内嵌 index.html 与 JS 资源可访问**、`/api/system/info` 返回目标机真实硬件信息。

### C.2 关键结论

1. **资源嵌入方案有效**。二进制拷贝到不含 `dist/` 的空目录后仍能完整提供前端——证明资源确实编译进了可执行文件，而非运行时读盘。
2. **交叉编译完全可用**。macOS arm64 上编译出的 x86-64 ELF 在 amd64 Linux 上正常运行。
3. **风险 R1 / R2 解除**：显式 import 清单方式未触发任何 Bun 已知缺陷。
4. **风险 R4 解除**：`systeminformation` 5.33.x 在 Bun 1.4.2 上工作正常，跨 macOS/Linux 均能采集。
5. **`/proc/diskstats` 在 Linux 容器内可读**，`capabilities.disksIo` 正确返回 `true`；macOS 上正确返回 `false`。
6. 交叉编译会在首次构建时**自动下载目标平台运行时**（每个约 26–35 MB，之后缓存复用），因此首次多目标构建需要网络。

### C.3 ⚠️ 重要运维发现：musl 构建并非自包含

`bun-linux-*-musl` 产物在**纯净 Alpine 镜像上会启动失败**：

```
Error loading shared library libstdc++.so.6: No such file or directory (needed by /app/starm-panel)
Error relocating /app/starm-panel: _ZSt15get_new_handlerv: symbol not found
```

Bun 的 musl 构建依赖 `libstdc++`，而 Alpine 基础镜像不含它。**解决**：

```dockerfile
RUN apk add --no-cache libstdc++
```

已实测该修复后 Alpine 上正常运行。

> 更广泛地说：**所有产物都是动态链接的**（glibc 或 musl），不是全静态二进制。
> - glibc 版依赖目标的 glibc 版本，极老旧发行版（如旧版 Synology DSM）可能因版本过低而失败。
> - musl 版面向 Alpine，需补 `libstdc++`。
> - 部署前应先在目标机执行 `./starm-panel-linux-x64 --version` 做冒烟测试。

### C.4 实现期间修正的设计偏差

| 问题 | 现象 | 处理 |
|---|---|---|
| macOS 磁盘误导 | `si.fsSize()` 把 `/` 报为系统卷（14/245GB），用户数据实际在 `/System/Volumes/Data`（185/245GB） | 新增 `normalizeDisks()`：darwin 下将 Data 卷重标为 `/`，丢弃其余 `/System/Volumes/*` 与 `/Volumes/Recovery`；Linux 下过滤 tmpfs/overlay/squashfs 等伪文件系统 |
| macOS 网卡噪音 | `si.networkInterfaces()` 返回 15 个接口（`anpi0`/`awdl0`/`utun*`/`bridge0`/`ap1`/`llw0`/`nan0`），绝大多数无 IP 无流量 | 新增 `normalizeNetInterfaces()`：只保留具有非回环 IPv4 或非链路本地 IPv6 的接口 |
| 磁盘 IO 数据源 | `si.disksIO()` 只给系统级聚合值，无法按挂载点拆分 | 新增 `services/diskstats.ts`，直接读 `/proc/diskstats` 做差分（Linux），并提供分区名→父设备的回退查找 |
| 负载均值 | `si.currentLoad()` 只提供 1 分钟负载 | 1/5/15 分钟改用 `node:os` 的 `loadavg()` |
| GPU 采样开销 | `si.graphics()` 在 NVIDIA 平台会 spawn `nvidia-smi` | 独立 `GpuSampler`（默认 3s），不跟随 1s 主循环；无订阅者时直接跳过 |

### C.5 GPU 降级路径实测

在 Apple M2 上，`si.graphics()` 返回：

```json
{ "vendor": "apple", "model": "Apple M2", "vramDynamic": true,
  "utilization": 7, "memoryUsed": 453443584, "memoryTotal": null,
  "available": ["utilization", "memory"] }
```

> 历史记录：早期版本 macOS 的 `available` 为空数组，前端降级为纯静态信息卡（§7.3 的降级路径）。后来补上了 `ioreg` 数据源（`services/gpu-macos.ts`），Apple Silicon 现在能拿到使用率与已用共享内存；「零动态指标」的降级路径改由未装驱动的核显 / 受限容器场景覆盖。

⚠️ **NVIDIA 路径仍未验证**：本机无 NVIDIA 硬件，`available` 非空的完整渲染路径、以及 `nvidia-smi` 缺失时的容错，均需在真实 NVIDIA 机器上补测。

### C.6 风险登记册状态更新

| # | 风险 | 新状态 |
|---|---|---|
| R1 | `--compile` 嵌入目录失败 | ✅ **已规避**（改用显式 import 清单） |
| R2 | 静态目录路由启动 abort | ✅ **已规避**（只用 `Bun.file()`） |
| R3 | 体积超预期 | ✅ **已确认**：59.6–81.7 MB，符合预估 |
| R4 | systeminformation 兼容性 | ✅ **已解除** |
| R5 | 交叉编译产物无法启动 | ✅ **已解除**（4 目标实测通过） |
| R15 | GPU 指标期望落差 | 🟡 **部分**：macOS 降级已实证；NVIDIA 路径待测 |
| R18 | **产物动态链接，依赖目标 libc** | 🆕 **新增**：musl 需 `libstdc++`；旧 glibc 发行版可能不兼容。部署前须在目标机冒烟测试 |

---

## 附录 D：实现期发现的安全问题与处置

> 记录于 M1–M4 后端实现期间。这些问题在设计阶段未被识别，均为实测发现。

### D.1 客户端声明的 MIME 完全不可信（中危 → 已修复）

**发现过程**：集成测试中，「上传 `text/plain` 应被拒绝」持续失败。排查后确认：

```
Bun fetch + FormData 实际传输的 MIME（实测）：
  name=test.png, type=text/plain  → 服务端收到 image/png
  name=test.txt, type=image/png   → 服务端收到 text/plain;charset=utf-8
  name=noext,   type=text/plain   → 服务端收到 ""（空）
```

Bun 的 `fetch` + `FormData` **忽略 `File` 对象上的 `type`，改从文件名后缀推断** part 的 `Content-Type`。

**影响**：原设计（§8.5）用 `file.type` 做 MIME 白名单校验。由于客户端同时控制文件名与 type，攻击者只需把任意文件命名为 `.png`，服务端就会认为它是合法图片并存入。配合 §8.5 的直接读取接口，可形成**存储型 XSS**（例如上传伪装成 PNG 的 HTML）。

**处置**：
1. 新增 `sniffImageMime()`，按**文件头 magic bytes** 判定真实类型（PNG/JPEG/GIF/WebP/AVIF/HEIC/BMP/TIFF/ICO/SVG）。
2. `storeAsset()` 一律以嗅探结果为准，客户端声明仅用于错误提示文案。
3. 对 `image/svg+xml` 响应附加严格 CSP：`default-src 'none'; style-src 'unsafe-inline'; sandbox` —— SVG 可内嵌 `<script>`，以 `<img>` 引用时不执行，但用户**直接打开** `/api/assets/<id>` 时是同源文档，脚本会执行。
4. 补充测试：伪造声明的文本、伪装成 PNG 的 HTML、真实 ICO 字节、SVG 的 CSP 头。

**一般性结论**：任何以「客户端声明的 Content-Type」为安全依据的上传校验都是无效的，必须嗅探内容本身。

### D.2 URL 校验可被 WHATWG 解析器的宽松性绕过（低危 → 已修复）

**发现**：`ht!tp://[` 被判定为合法 URL。

**原因**：协议检测失败后会补 `http://` 前缀；而 WHATWG URL 解析器允许 `!` 出现在 host 中，于是 `http://ht!tp://[` 被解析为 host=`ht!tp`、path=`//[`，校验通过。

**处置**：`normalizeUrlInput()` 增加两道校验 ——
1. 输入含 `://` 但前缀不是合法 scheme 时直接判非法（不再盲目补协议）；
2. 用严格的主机名规则（DNS 名 / IPv4 / 括号包裹的 IPv6）替代「hostname 非空」检查。

补充测试覆盖 `ht!tp://[`、`ftp://`、`999.1.2.3`、`javascript:` 等形态。

### D.3 Zod 校验错误绕过统一错误处理（低危 → 已修复）

`@hono/zod-validator` 默认 hook 在失败时自行返回 `{ success: false, error: ZodError }`，绕过了 `middleware/error.ts` 的统一错误格式，前端需要处理两种错误结构。

**处置**：新增 `middleware/validate.ts` 包装 `jsonBody()`，把校验失败转成 `HttpError`，统一为 `{ error: { code, message, details } }`。

### D.4 内容寻址存储下 kind 的语义（提示，非缺陷）

`assets.id = sha256(内容)`，因此**同一份字节以不同 `kind` 上传会复用同一条记录**，`kind` 保持首次上传的值。这是 ADR-005 内容寻址的预期行为（避免重复占用空间），但会让「上传壁纸却拿到 icon 记录」看起来奇怪。已在 `storeAsset()` 的文档注释中写明，并有专门测试固化该行为。

### D.5 新增的测试覆盖

| 测试文件 | 用例数 | 覆盖内容 |
|---|---|---|
| `src/shared/resolve-url.test.ts` | 44 | 内外网解析优先级矩阵 + `isLanHost` 访问方式判定（IP / localhost / 域名） |
| `src/server/api.test.ts` | 39 | 端到端：启动真实服务进程，覆盖全部 API、校验边界、上传安全、备份往返 |
| **合计** | **83** | 全部通过 |

其中 `api.test.ts` 是**真实进程级**集成测试（`Bun.spawn` 启动服务器 + 真实 HTTP 请求），而非 in-process 调用，因此能覆盖数据库、中间件、后台服务的真实组合行为。
