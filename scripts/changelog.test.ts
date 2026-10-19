/**
 * CHANGELOG.md 解析单测。
 *
 * 发布工作流依赖这里取 Release 说明：标题格式、段落边界、版本精确匹配
 * 任何一条判错，都会让 Release 页面带出别的版本的内容或直接为空。
 */
import { describe, expect, test } from 'bun:test'
import { extractChangelogSection, normalizeVersion } from './changelog'

const CHANGELOG = `# 更新日志

说明文字。

## 0.1.2

- 改进了一些已知问题。

## 0.1.1

- 新增更新功能。
- 修改毛玻璃 / 液态玻璃的显示效果。

### 子标题

- 子标题下的条目也属于 0.1.1。

## 0.1.0

- 首个版本。
`

describe('normalizeVersion', () => {
  test('接受 v 前缀、方括号与前导零', () => {
    expect(normalizeVersion('0.1.2')).toBe('0.1.2')
    expect(normalizeVersion('v0.1.2')).toBe('0.1.2')
    expect(normalizeVersion('[0.1.2]')).toBe('0.1.2')
    expect(normalizeVersion(' v01.002.0003 ')).toBe('1.2.3')
  })

  test('非法版本号返回 null', () => {
    expect(normalizeVersion('')).toBeNull()
    expect(normalizeVersion('0.1')).toBeNull()
    expect(normalizeVersion('0.1.2-beta.1')).toBeNull()
  })
})

describe('extractChangelogSection', () => {
  test('取出指定版本的段落，不包含标题与相邻版本', () => {
    expect(extractChangelogSection(CHANGELOG, '0.1.1')).toBe(
      [
        '- 新增更新功能。',
        '- 修改毛玻璃 / 液态玻璃的显示效果。',
        '',
        '### 子标题',
        '',
        '- 子标题下的条目也属于 0.1.1。',
      ].join('\n'),
    )
  })

  test('版本号按三段精确匹配：0.1.2 不命中 0.1.20', () => {
    expect(extractChangelogSection('## 0.1.20\n\n- 别的版本。\n', '0.1.2')).toBeNull()
  })

  test('标题兼容 v 前缀与 Keep a Changelog 的方括号 + 日期', () => {
    const md = '## [v0.1.2] - 2026-10-19\n\n- 改进了一些已知问题。\n'
    expect(extractChangelogSection(md, '0.1.2')).toBe('- 改进了一些已知问题。')
  })

  test('CRLF 换行同样能解析', () => {
    const md = '## 0.1.2\r\n\r\n- 改进了一些已知问题。\r\n'
    expect(extractChangelogSection(md, '0.1.2')).toBe('- 改进了一些已知问题。')
  })

  test('版本不存在或段落为空时返回 null', () => {
    expect(extractChangelogSection(CHANGELOG, '9.9.9')).toBeNull()
    expect(extractChangelogSection('## 0.1.2\n\n## 0.1.1\n\n- 旧版本。\n', '0.1.2')).toBeNull()
    expect(extractChangelogSection('', '0.1.2')).toBeNull()
  })

  test('不是二级标题的版本号不会被误认', () => {
    expect(extractChangelogSection('### 0.1.2\n\n- 不是版本段落。\n', '0.1.2')).toBeNull()
  })
})
