/**
 * 单文件可执行程序构建脚本。
 *
 * 用法：
 *   bun run scripts/build.ts                      # 当前平台
 *   bun run scripts/build.ts bun-linux-x64        # 指定目标（可多个）
 *   bun run scripts/build.ts bun-linux-x64 bun-linux-arm64 bun-darwin-arm64
 *
 * 交叉编译的前提是全部依赖均为纯 JS 或运行时内置（见 docs/DESIGN.md §2.2 ADR-001）：
 * bun:sqlite 内置、systeminformation 纯 JS、Hono 零依赖 —— 满足条件。
 *
 * 产物文件名带版本号（取自 package.json）：release/starm-panel-v0.1.1-linux-x64。
 * 同一个 release 目录里放多个版本时不会互相覆盖，下载页也能一眼看出是哪个版本。
 *
 * 发布流水线额外传 `STARM_RELEASE`（Release tag）：版本首发是 `v0.1.1`，
 * 同版本重复发布是 `v0.1.1-2`。它会被
 * `--define __STARM_RELEASE__` 写进产物，供「检查更新」判断当前是不是最新发布 ——
 * 只看 package.json 的版本号无法区分「同版本的又一次发布」。
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { APP_VERSION } from '../src/shared/version'
import { parseReleaseTag } from '../src/shared/update'

const ROOT = resolve(import.meta.dir, '..')
const ENTRY = resolve(ROOT, 'src/server/index.ts')
const OUT_DIR = resolve(ROOT, 'release')
const ASSETS_FILE = resolve(ROOT, 'src/server/generated/assets.ts')

/**
 * 构建期注入的 Release tag。
 *
 * 本地手动构建不传 `STARM_RELEASE`，产物里就没有发布标识（关于页会显示
 * 当前为手动构建、检查更新仍可比较版本号，但无法区分同版本的不同构建）。
 */
const RELEASE_TAG = (process.env['STARM_RELEASE'] ?? '').trim()
if (RELEASE_TAG && !parseReleaseTag(RELEASE_TAG)) {
  console.error(
    `\n[build] STARM_RELEASE 取值非法：${RELEASE_TAG}\n  形如 v0.1.1 或 v0.1.1-2（与 Release tag 一致）\n`,
  )
  process.exit(1)
}
if (RELEASE_TAG) {
  const tagged = parseReleaseTag(RELEASE_TAG)
  if (tagged && tagged.version !== APP_VERSION) {
    console.warn(
      `[build] 注意：STARM_RELEASE 的版本段（${tagged.version}）与 package.json（${APP_VERSION}）不一致\n`,
    )
  }
}

function hostTarget(): string {
  const os =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'win32'
        ? 'windows'
        : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `bun-${os}-${arch}`
}

function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

// ── 前置检查 ────────────────────────────────────────────────
if (!existsSync(ASSETS_FILE)) {
  console.error(
    '\n[build] 缺少资源清单 src/server/generated/assets.ts\n' +
      '  请先执行：bun run build:web && bun run build:assets\n',
  )
  process.exit(1)
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const list = targets.length > 0 ? targets : [hostTarget()]

const invalid = list.filter((t) => !/^bun-[a-z0-9-]+$/.test(t))
if (invalid.length > 0) {
  console.error(`\n[build] 目标格式非法：${invalid.join(', ')}\n  形如 bun-linux-x64\n`)
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })

console.log(`[build] 入口：${basename(ENTRY)}`)
console.log(`[build] 版本：v${APP_VERSION}${RELEASE_TAG ? `（发布标识 ${RELEASE_TAG}）` : ''}`)
console.log(`[build] 目标：${list.join(', ')}\n`)

/** 注入到产物里的编译期常量（见 src/shared/version.ts 的 RELEASE_TAG） */
const defineArgs = RELEASE_TAG
  ? ['--define', `__STARM_RELEASE__:${JSON.stringify(RELEASE_TAG)}`]
  : []

let failed = 0

for (const target of list) {
  const suffix = target.replace(/^bun-/, '')
  const ext = target.includes('windows') ? '.exe' : ''
  const outfile = resolve(OUT_DIR, `starm-panel-v${APP_VERSION}-${suffix}${ext}`)

  console.log(`→ ${target}`)
  const started = Date.now()

  // 用 process.execPath 而不是字面量 'bun'：确保调用的是当前运行时，
  // 即使 bun 不在 PATH 上（例如本仓库把 Bun 装在 .tools/ 下）也能工作。
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      'build',
      '--compile',
      '--minify',
      ...defineArgs,
      `--target=${target}`,
      '--outfile',
      outfile,
      ENTRY,
    ],
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const code = await proc.exited
  const secs = ((Date.now() - started) / 1000).toFixed(1)

  if (code !== 0) {
    console.error(`  ✗ 编译失败（退出码 ${code}）\n`)
    failed++
    continue
  }

  const size = statSync(outfile).size
  console.log(`  ✓ ${basename(outfile)}  ${humanSize(size)}  ${secs}s\n`)
}

if (failed > 0) {
  console.error(`[build] ${failed}/${list.length} 个目标编译失败`)
  process.exit(1)
}

console.log(`[build] 完成。产物目录：${OUT_DIR}`)
