/**
 * 计算本次发布应当使用的 tag（发布工作流在 prepare 阶段调用一次）。
 *
 * 规则（与 src/shared/update.ts 的 nextReleaseTag 同一份实现）：
 *   - 每个版本的**第一次**发布不带序号：v0.1.1
 *   - 同一版本重复发布才追加序号：v0.1.1-2、v0.1.1-3 …
 *   - 是否发过以仓库里已有的 tag 为准，因此调用前必须能看到远程 tag
 *
 * 用法（工作流里）：
 *   git fetch --tags --force
 *   bun run scripts/release-tag.ts 0.1.1 >> "$GITHUB_OUTPUT"
 *
 * stdout 只输出一行 `tag=v0.1.1`（GITHUB_OUTPUT 的格式），
 * 说明信息一律走 stderr，避免把日志写进 GitHub Actions 的输出变量。
 */
import { nextReleaseTag, parseReleaseTag } from '../src/shared/update'

const VERSION = process.argv.slice(2).find((arg) => !arg.startsWith('-'))?.trim() ?? ''

if (!VERSION) {
  console.error('\n[release-tag] 用法：bun run scripts/release-tag.ts <version>\n')
  process.exit(1)
}

const listed = Bun.spawnSync({
  cmd: ['git', 'tag', '--list'],
  stdout: 'pipe',
  stderr: 'pipe',
})

if (listed.exitCode !== 0) {
  console.error(
    `\n[release-tag] 读取 git tag 失败：${listed.stderr.toString().trim() || `退出码 ${listed.exitCode}`}\n` +
      '  CI 里请先执行 git fetch --tags --force\n',
  )
  process.exit(1)
}

const tags = listed.stdout
  .toString()
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

const tag = nextReleaseTag(VERSION, tags)
if (!tag) {
  console.error(`\n[release-tag] 版本号非法：${VERSION}（应形如 0.1.1）\n`)
  process.exit(1)
}

const parsed = parseReleaseTag(tag)
const released = tags.filter((t) => parseReleaseTag(t)?.version === parsed?.version).length
console.error(
  `[release-tag] 版本 ${parsed?.version ?? VERSION} 已有 ${released} 个发布 tag，本次使用 ${tag}`,
)

console.log(`tag=${tag}`)
