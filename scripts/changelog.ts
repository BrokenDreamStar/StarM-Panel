/**
 * CHANGELOG.md 解析 —— 给发布工作流取「当前版本」的 Release 说明。
 *
 * 格式约定（每个版本一个二级标题，内容到下一个二级标题为止）：
 *
 *   ## 0.1.2
 *   - 改进了一些已知问题。
 *
 * 标题兼容 `## v0.1.2` 与 `## [0.1.2] - 2026-10-19`（Keep a Changelog 风格）；
 * 版本号按三段数字精确比较，`0.1.2` 不会误命中 `0.1.20`。
 *
 * 纯字符串处理，不碰文件系统：读文件与报错由 scripts/release-notes.ts 负责。
 */

/** 二级标题里的三段式版本号（允许 v 前缀、方括号与后面的日期等说明） */
const VERSION_HEADING_RE = /^##\s+\[?v?(\d+)\.(\d+)\.(\d+)\]?(?:\s|$)/

/**
 * 把 `v0.1.2`、`[0.1.2]`、`01.002.0003` 归一化成 `0.1.2` / `1.2.3`。
 * 不是三段式版本号时返回 null。
 */
export function normalizeVersion(version: string): string | null {
  const m = /^\[?v?(\d+)\.(\d+)\.(\d+)\]?$/.exec(version.trim())
  if (!m) return null
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`
}

/**
 * 取出指定版本的段落正文（不含标题）。
 *
 * 找不到该版本、或段落里没有实际内容时返回 null —— 由调用方决定报错还是兜底。
 */
export function extractChangelogSection(markdown: string, version: string): string | null {
  const wanted = normalizeVersion(version)
  if (!wanted) return null

  const lines = markdown.split(/\r?\n/)
  const collected: string[] = []
  let inside = false

  for (const line of lines) {
    // 二级标题是版本段落的边界；`###` 之类的子标题属于当前段落内容
    if (/^##\s+/.test(line)) {
      if (inside) break
      const m = VERSION_HEADING_RE.exec(line)
      if (!m) continue
      const found = `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`
      inside = found === wanted
      continue
    }
    if (inside) collected.push(line)
  }

  const body = collected.join('\n').trim()
  return body === '' ? null : body
}
