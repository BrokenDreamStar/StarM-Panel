/**
 * 从 CHANGELOG.md 取指定版本的 Release 说明。
 *
 * 用法：
 *   bun run scripts/release-notes.ts 0.1.2                  # 输出到 stdout
 *   bun run scripts/release-notes.ts 0.1.2 --out notes.md   # 写入文件（发布工作流用）
 *
 * 找不到对应版本的段落时以非零码退出：Release 说明是发布质量的一部分，
 * 宁可让发版停在 prepare 阶段，也不要静默发出一版空日志。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractChangelogSection, normalizeVersion } from './changelog'

const ROOT = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const positional = args.filter((arg) => !arg.startsWith('--'))
const outFlag = args.indexOf('--out')
const version = positional[0]?.trim() ?? ''

function fail(message: string): never {
  console.error(`\n[release-notes] ${message}\n`)
  process.exit(1)
}

const normalized = normalizeVersion(version)
if (!version) {
  fail('用法：bun run scripts/release-notes.ts <version> [--out <file>]')
}
if (!normalized) {
  fail(`版本号非法：${version}（应形如 0.1.2）`)
}

if (outFlag >= 0 && !args[outFlag + 1]) {
  fail('--out 缺少文件路径')
}

const changelogPath = resolve(ROOT, 'CHANGELOG.md')
let markdown: string
try {
  markdown = readFileSync(changelogPath, 'utf8')
} catch (err) {
  fail(`读不到 ${changelogPath}：${err instanceof Error ? err.message : String(err)}`)
}

const section = extractChangelogSection(markdown, normalized)
if (!section) {
  fail(
    `CHANGELOG.md 里没有 ${normalized} 的段落。\n` +
      '  发版前请先补上，例如：\n\n' +
      `  ## ${normalized}\n` +
      '  - 本版本的主要变化\n',
  )
}

const outFile = outFlag >= 0 ? args[outFlag + 1] : undefined
if (outFile) {
  const target = resolve(ROOT, outFile)
  writeFileSync(target, `${section}\n`, 'utf8')
  console.error(`[release-notes] ${normalized} → ${target}`)
} else {
  process.stdout.write(`${section}\n`)
}
