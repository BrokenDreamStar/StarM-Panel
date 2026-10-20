/**
 * 打发布 tag 并推送 —— **推送 tag 是唯一的发版触发条件**（见 .github/workflows/release.yml）。
 *
 * 用法：
 *   bun run release:tag --dry-run   # 只做检查并打印将使用的 tag
 *   bun run release:tag             # 打 annotated tag 并推送到 origin
 *
 * 发版顺序：dev 的改动合进 main → 在 main 上跑这个脚本 → CI 构建六平台并发布 Release。
 * 脚本先在本地把 CI 会校验的事情做一遍，避免「tag 推上去才发现版本号 / CHANGELOG 不对」：
 *
 *   1. 当前分支必须是 main，且 HEAD 与 origin/main 完全一致（发布只从主干走）；
 *   2. 工作区必须干净（不能把未提交的改动当成这个版本发出去）；
 *   3. CHANGELOG.md 必须有当前版本段落（Release 说明取自这里，缺失会让 prepare 失败）。
 *
 * tag 由 `nextReleaseTag` 按仓库已有 tag 算出（与 CI 的版本判定同一份实现）：
 * 首发 v<version>，同一版本重复发布才追加序号 v<version>-2、-3 …
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { version } from '../package.json'
import { nextReleaseTag, parseReleaseTag } from '../src/shared/update'
import { extractChangelogSection } from './changelog'

const ROOT = resolve(import.meta.dir, '..')
const dryRun = process.argv.includes('--dry-run')

function fail(message: string): never {
  console.error(`\n[release-tag] ${message}\n`)
  process.exit(1)
}

/** 跑一条 git 命令，失败时带上 stderr（不让非零退出码静默通过） */
function git(args: string[]): string {
  const proc = Bun.spawnSync({ cmd: ['git', ...args], cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    const detail = proc.stderr.toString().trim()
    fail(`git ${args.join(' ')} 失败：${detail || `退出码 ${proc.exitCode}`}`)
  }
  return proc.stdout.toString().trim()
}

const repoVersion = parseReleaseTag(`v${version}`)?.version
if (!repoVersion) fail(`package.json 的版本号非法：${version}`)

// ── 1. 只允许在 main 上发版 ─────────────────────────────────
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') {
  const where = branch === 'HEAD' ? 'detached HEAD' : `${branch} 分支`
  fail(
    `当前在 ${where}。发版只从 main 走：\n` +
      '  先把 dev 的 PR 合并进 main，再切到 main 执行（dev 上打 tag 会绕过 PR 审核）',
  )
}

// ── 2. 工作区干净 ───────────────────────────────────────────
const dirty = git(['status', '--porcelain'])
if (dirty) fail(`工作区有未提交改动：\n${dirty}\n先提交或 stash，避免把半个版本发出去`)

// ── 3. 与远端一致 ───────────────────────────────────────────
git(['fetch', 'origin', 'main', '--tags', '--force'])
const head = git(['rev-parse', 'HEAD'])
const remoteHead = git(['rev-parse', 'origin/main'])
if (head !== remoteHead) {
  fail(
    `本地 main（${head.slice(0, 7)}）与 origin/main（${remoteHead.slice(0, 7)}）不一致：\n` +
      '  落后就 git pull --ff-only；领先就先把提交推上去',
  )
}

// ── 4. CHANGELOG 段落 ───────────────────────────────────────
const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8')
if (!extractChangelogSection(changelog, repoVersion)) {
  fail(
    `CHANGELOG.md 缺少 ## ${repoVersion} 段落：\n` +
      '  Release 说明取自这里，缺失会让发布在 prepare 阶段失败',
  )
}

// ── 5. 算 tag、打 tag、推 tag ───────────────────────────────
const tags = git(['tag', '--list'])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
const tag = nextReleaseTag(repoVersion, tags)
if (!tag) fail(`无法为版本 ${repoVersion} 计算 tag`)
if (tags.includes(tag)) fail(`tag ${tag} 已存在（nextReleaseTag 本应跳过已有 tag，请检查 tag 列表）`)

if (dryRun) {
  console.log(`[release-tag] dry-run：将创建并推送 ${tag}（来源提交 ${head.slice(0, 7)}）`)
  process.exit(0)
}

git(['tag', '-a', tag, '-m', `StarM Panel ${tag}`])
git(['push', 'origin', tag])
console.log(`[release-tag] 已推送 ${tag}：GitHub Actions 将构建六平台产物并发布 Release`)
