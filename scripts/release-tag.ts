/**
 * 校验发布 tag 与 package.json 版本号是否一致（release.yml 的 prepare 阶段调用）。
 *
 * 用法：
 *   bun run scripts/release-tag.ts v0.1.5     # 通过：版本号就是 0.1.5
 *   bun run scripts/release-tag.ts v0.1.5-2   # 通过：同一版本重复发布
 *   bun run scripts/release-tag.ts v0.1.6     # 失败：package.json 还是 0.1.5
 *
 * 为什么要在编译前校验：产物文件名、`--version`、`/healthz`、检查更新读的都是
 * package.json 的版本，Release 的 tag 却来自人工推送。两边对不上时用户会看到
 * 「v0.1.6 的发布，装进去的是 0.1.5」，而检查更新会一直提示有新版本。
 *
 * 打 tag 本身由 scripts/tag-release.ts 负责（它会先做同样的检查再推 tag）。
 */
import { version } from '../package.json'
import { parseReleaseTag } from '../src/shared/update'

const tag = process.argv.slice(2).find((arg) => !arg.startsWith('-'))?.trim() ?? ''

function fail(message: string): never {
  console.error(`\n[release-tag] ${message}\n`)
  process.exit(1)
}

if (!tag) fail('用法：bun run scripts/release-tag.ts <tag>（如 v0.1.5 / v0.1.5-2）')

// 发布工作流只由 `v*` 的 tag 触发，别的写法（1.2.3、release-1.2.3）会静默不发版
if (!tag.startsWith('v')) fail(`tag 必须以 v 开头：${tag}`)

const parsed = parseReleaseTag(tag)
if (!parsed) fail(`tag 非法：${tag}（应形如 v0.1.5 或 v0.1.5-2）`)

const repoVersion = parseReleaseTag(`v${version}`)?.version
if (!repoVersion) fail(`package.json 的版本号非法：${version}`)

if (parsed.version !== repoVersion) {
  fail(
    `tag ${tag} 与 package.json 版本 ${repoVersion} 不一致：\n` +
      `  - 发新版本：把 package.json 与 CHANGELOG.md 改到 ${parsed.version} 后重新打 tag\n` +
      `  - 同版本重发：tag 用 v${repoVersion}-2（序号接着已有 tag 往后排）`,
  )
}

// 说明信息一律走 stderr，stdout 留给调用方可能接的后续脚本
console.error(
  `[release-tag] ${tag} ↔ package.json ${repoVersion} ✓` +
    (parsed.build === null ? '' : `（重复发布序号 ${parsed.build}）`),
)
