# AGENTS.md

本文件为在本仓库工作的编码代理提供上下文。修改代码前请先读这里和 `docs/DESIGN.md`（设计文档是架构决策的权威来源）。

## 项目概览

StarM Panel —— 轻量级自托管导航面板：系统硬件监控 + 应用卡片 + 内外网一键切换。

- 全栈 TypeScript，Bun 单文件编译为**单个可执行文件**，零运行时依赖、无 Docker、无外部数据库。
- 后端：Hono + `bun:sqlite`（WAL + `user_version` 迁移）+ SSE 实时推送 + `systeminformation`。
- 前端：Vue 3 + naive-ui + Pinia + vue-router，Vite 构建（SPA，无 SSR）。
- 注释、文档、提交信息用中文。

## 常用命令

```bash
bun run dev          # 并行：后端 3002 + Vite 5173
bun run dev:server   # 仅后端（bun --watch src/server/index.ts）
bun run dev:web      # 仅前端（Vite，/api 代理到 127.0.0.1:3002）
bun run typecheck    # vue-tsc --noEmit，提交前必跑
bun test             # 单元测试（*.test.ts 就近放置）
bun run build        # build:web → build:assets → build:bin，产物在 release/
bun run scripts/build.ts bun-linux-x64 bun-darwin-arm64   # 指定交叉编译目标
```

**运行/重启项目一律用 `bun run dev`（HMR 开发模式）**：后端 3002 + Vite 5173，前端热更新、`/api` 代理到 3002。切勿用「单文件产物模式」（`dist` + `generated/assets.ts`）做日常开发 —— 改了前端不重新构建看不到效果；产物模式只在构建 / 发布 / 交叉编译时使用。

## 目录结构

```
src/shared/     # 前后端共用：resolve-url.ts、schemas.ts(zod)、types.ts
src/server/     # Hono 服务端
  index.ts      #   bun build --compile 入口，所有资源经 ./generated/assets 访问
  db/           #   schema.ts(表定义)、migrations.ts(手写迁移)、mappers.ts
  routes/       #   按资源拆分的路由
  services/     #   业务逻辑（monitor、favicon、assets…）
  middleware/   #   error.ts(HttpError/onError)、validate.ts
  generated/    #   构建生成，勿手改
src/web/        # Vue 前端：components/ composables/ stores/ views/ api/ styles/
scripts/        # build.ts（单文件编译）、gen-assets.ts（生成资源嵌入清单）
docs/DESIGN.md  # 架构与 ADR
data/           # 运行时数据（app.db、secret.key），不入库
```

## 约定与硬性约束

- **`src/shared` 必须同构**：不得引入仅 Node/Bun 或仅浏览器可用的 API，前后端都从这里 import。
- **别名双份维护**：`@`、`@shared`（前端）与 `@server` 同时定义在 `vite.config.ts` 和 `tsconfig.json`，改动需同步两处。
- **统一错误格式**：接口错误一律 `{ error: { code, message, details } }`；业务代码抛 `HttpError`，由 `middleware/error.ts` 统一处理。
- **入参校验用 zod**：schema 放 `src/shared/schemas.ts`，路由经 `middleware/validate.ts` 校验，不在处理函数里手写校验。
- **数据库迁移只追加**：已发布的迁移**永不修改**，新增迁移追加到 `MIGRATIONS` 末尾并同步 `db/schema.ts`；每条迁移在单事务内执行，版本写入 `PRAGMA user_version`。
- **`src/server/generated/assets.ts` 是生成物**：由 `scripts/gen-assets.ts` 在 `vite build` 之后生成，不要手改；打包时所有前端产物与迁移 SQL 都必须走它。
- **打包兼容性**：依赖必须是纯 JS 或 Bun 内置（`bun:sqlite`、`Bun.password` 等）。避免引入原生模块、需要 postinstall 编译或体积过大的包 —— 这会破坏单文件交叉编译（见 DESIGN.md §2.2 ADR-001）。
- 部分更新语义（PATCH）只改传入字段，不得清空其它字段；跨字段不变量（如内外网地址至少填一个）在创建与更新两条路径都要校验。
- URL 归一化与内外网解析统一走 `src/shared/resolve-url.ts` 的纯函数，不要在组件里重复实现。

## 测试

- 用 `bun test`；测试文件与被测代码就近同级命名 `*.test.ts`（如 `src/shared/resolve-url.test.ts`、`src/server/services/gpu-macos.test.ts`）。
- 纯函数（URL 解析、`isLanHost` 访问方式判定）是历史 bug 高发区，改这些逻辑必须补/跑对应单测。

## 注意事项

- `data/` 为运行时数据，删除即重置面板配置；不要把 `data/`、`dist/`、`release/`、`.tools/` 提交进仓库。
- 后端默认 `0.0.0.0:3002`，可用 `--port/--host/--data-dir/--base-url` 或 `STARM_PORT`、`STARM_HOST`、`STARM_DATA_DIR`、`STARM_BASE_URL` 覆盖。
- 自动选择（`network.autoMode` 开关）按**面板的访问方式**落地：用 IP / localhost 访问判为内网，用域名访问判为外网；判定逻辑是 `src/shared/resolve-url.ts` 的 `isLanHost`，不要再引入服务端探测。
