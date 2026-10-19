/**
 * 生成发布用更新清单 latest.json。
 *
 * 在 release 工作流里、六个平台产物全部取回之后运行：
 *
 *   bun run scripts/gen-update-manifest.ts release-out v0.1.0-6
 *
 * 清单被上传为 Release 资产，更新器通过官方稳定地址
 * `https://github.com/<repo>/releases/latest/download/latest.json` 读取它：
 * 一次请求就能拿到 tag、版本、各平台资产名、大小与 sha256，
 * 不占 GitHub API 配额、不需要 token，也不需要猜资产命名。
 *
 * 清单从**即将上传的同一批文件**算出 sha256，与二进制一一对应；
 * 六个平台缺任何一个都直接失败 —— 宁可这次不发版，也不发一份残缺清单。
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  UPDATE_PLATFORMS,
  parseReleaseTag,
  platformFromAssetName,
  type UpdateManifest,
  type UpdateManifestAsset,
} from '../src/shared/update'

function fail(message: string): never {
  console.error(`\n[manifest] ${message}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const outFlag = args.indexOf('--out')

const dirArg = positional[0]
const tag = positional[1]?.trim()

if (!dirArg || !tag) {
  fail('用法：bun run scripts/gen-update-manifest.ts <产物目录> <v版本-序号> [--out <文件>]')
}

const parsed = parseReleaseTag(tag)
if (!parsed || !tag.startsWith('v')) {
  fail(`发布 tag 非法：${tag}（应形如 v0.1.0-6，与 Release tag 一致）`)
}

const dir = resolve(dirArg)
const outFile = outFlag >= 0 && args[outFlag + 1] ? resolve(args[outFlag + 1]) : join(dir, 'latest.json')

let names: string[]
try {
  names = readdirSync(dir)
} catch (err) {
  fail(`无法读取产物目录 ${dir}：${err instanceof Error ? err.message : String(err)}`)
}

// 文件名 → 平台。重复（新旧两代命名同时存在）视为错误，避免清单指向不确定的文件。
const byPlatform = new Map<string, string>()
for (const name of names) {
  if (name === 'latest.json' || name.startsWith('.')) continue
  const platform = platformFromAssetName(name)
  if (!platform) continue
  if (byPlatform.has(platform)) {
    fail(`平台 ${platform} 同时匹配到多个文件：${byPlatform.get(platform)} / ${name}`)
  }
  byPlatform.set(platform, name)
}

const missing = UPDATE_PLATFORMS.filter((p) => !byPlatform.has(p))
if (missing.length > 0) {
  fail(`缺少这些平台的产物：${missing.join('、')}\n  目录：${dir}`)
}

const assets: UpdateManifestAsset[] = []
for (const platform of UPDATE_PLATFORMS) {
  const name = byPlatform.get(platform)
  if (!name) fail(`缺少 ${platform} 的产物`)
  const path = join(dir, name)
  const stat = statSync(path)
  if (!stat.isFile() || stat.size <= 0) fail(`${name} 不是有效的非空文件`)
  const size = stat.size

  // 流式算 sha256：产物 60–80MB，不把整个文件读进内存
  const hasher = new Bun.CryptoHasher('sha256')
  const reader = Bun.file(path).stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    hasher.update(value)
  }
  const sha256 = hasher.digest('hex')

  assets.push({ platform, name, size, sha256 })
  console.log(`  ${platform.padEnd(14)} ${name}  ${sha256.slice(0, 12)}…  ${size} bytes`)
}

const manifest: UpdateManifest = {
  schema: 1,
  tag,
  version: parsed.version,
  publishedAt: new Date().toISOString(),
  assets,
}

await Bun.write(outFile, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`\n[manifest] 已生成 ${basename(outFile)}（${assets.length} 个平台，tag ${tag}）`)
