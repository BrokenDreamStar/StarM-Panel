/**
 * 生成资源嵌入清单 src/server/generated/assets.ts
 *
 * 为什么不用 `bun build --compile entry.ts dist/**\/*` 的 glob 方式：
 * 该路径有已知缺陷（oven-sh/bun#21977、#40932），显式 import 清单是稳定做法。
 * 详见 docs/DESIGN.md §9.2。
 *
 * 运行时机：vite build 之后、bun build --compile 之前。
 */
import { Glob } from 'bun'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const OUT_FILE = resolve(ROOT, 'src/server/generated/assets.ts')

/** 待嵌入的目录：源目录 → 运行时 URL 前缀 */
const ROOTS: Array<{ dir: string; prefix: string; optional?: boolean }> = [
  // 前端构建产物 → 站点根
  { dir: resolve(ROOT, 'dist'), prefix: '/' },
  // 手写 SQL 迁移 → /migrations/*
  { dir: resolve(ROOT, 'migrations'), prefix: '/migrations/', optional: true },
]

interface Entry {
  key: string
  absolute: string
  varName: string
}

const entries: Entry[] = []
const skipped: string[] = []

for (const root of ROOTS) {
  if (!existsSync(root.dir)) {
    if (root.optional) {
      skipped.push(root.dir)
      continue
    }
    console.error(
      `\n[gen-assets] 目录不存在：${relative(ROOT, root.dir)}\n` +
        `  请先执行 bun run build:web\n`,
    )
    process.exit(1)
  }

  const files = new Glob('**/*').scanSync({
    cwd: root.dir,
    onlyFiles: true,
    dot: true,
  })

  for (const file of [...files].sort()) {
    const key = (root.prefix + file).replaceAll('\\', '/')
    entries.push({
      key,
      absolute: resolve(root.dir, file),
      varName: `f${entries.length}`,
    })
  }
}

// 必须保证 /index.html 存在，否则 SPA fallback 无从谈起
if (!entries.some((e) => e.key === '/index.html')) {
  console.error(
    '\n[gen-assets] dist/index.html 缺失 —— 前端构建产物不完整，请重新执行 bun run build:web\n',
  )
  process.exit(1)
}

const outDir = dirname(OUT_FILE)
const lines: string[] = [
  '// @ts-nocheck —— 本文件由脚本生成，其中的 `with { type: "file" }` 导入',
  '// 是 Bun 专有的语法，TypeScript 无法为其找到声明文件，故整文件跳过检查。',
  '// ⚠️ 本文件由 scripts/gen-assets.ts 自动生成，请勿手动编辑。',
  `// 生成时间：${new Date().toISOString()}`,
  `// 资源数量：${entries.length}`,
  '//',
  '// 每个 import 都带 `with { type: "file" }`，Bun 会在 --compile 时',
  '// 把文件内容嵌入可执行文件，并在运行时解析为 /$bunfs/... 路径。',
  '',
]

for (const e of entries) {
  // 计算相对于生成文件的路径，避免硬编码层级
  const rel = relative(outDir, e.absolute).replaceAll('\\', '/')
  const spec = rel.startsWith('.') ? rel : `./${rel}`
  lines.push(`import ${e.varName} from ${JSON.stringify(spec)} with { type: 'file' }`)
}

lines.push('')
lines.push('/** 运行时 URL 路径 → 嵌入文件句柄路径 */')
lines.push('export const assets: ReadonlyMap<string, string> = new Map([')
for (const e of entries) {
  lines.push(`  [${JSON.stringify(e.key)}, ${e.varName}],`)
}
lines.push('])')
lines.push('')
lines.push(`export const assetCount = ${entries.length}`)
lines.push('')

mkdirSync(outDir, { recursive: true })
writeFileSync(OUT_FILE, lines.join('\n'), 'utf8')

console.log(`[gen-assets] 已嵌入 ${entries.length} 个资源 → ${relative(ROOT, OUT_FILE)}`)
for (const s of skipped) {
  console.log(`[gen-assets] 跳过不存在的可选目录：${relative(ROOT, s)}`)
}
