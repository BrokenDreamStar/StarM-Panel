/**
 * 生成发布用更新清单 latest.json。
 *
 * 在 release 工作流里、六个平台产物全部取回之后运行：
 *
 *   bun run scripts/gen-update-manifest.ts release-out v0.1.1
 *
 * tag 是发布工作流 prepare 阶段算出来的：首发 `v0.1.1`，
 * 同版本重复发布 `v0.1.1-2`。清单被上传为 Release 资产，更新器通过官方稳定地址
 * `https://github.com/<repo>/releases/latest/download/latest.json` 读取它：
 * 一次请求就能拿到 tag、版本、各平台资产名、大小与 sha256，
 * 不占 GitHub API 配额、不需要 token，也不需要猜资产命名。
 *
 * 清单从**即将上传的同一批文件**算出 sha256，与二进制一一对应；
 * 六个平台缺任何一个都直接失败 —— 宁可这次不发版，也不发一份残缺清单。
 *
 * 每个平台产物同时压一份 `<文件名>.zst`（level 19，实测 60–84MB → 19–29MB）：
 * 更新器优先下载压缩包、解压后再按未压缩产物的 size / sha256 校验，
 * 所以压缩只影响下载流量，不影响校验强度与安装后的体积。
 * 原始产物照旧上传 —— 旧版客户端（不认识 `zstd` 字段）仍然直接下它。
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  COMPRESSED_ASSET_EXT,
  UPDATE_PLATFORMS,
  compressedAssetName,
  parseReleaseTag,
  platformFromAssetName,
  type UpdateManifest,
  type UpdateManifestAsset,
} from '../src/shared/update'

/** zstd 压缩级别：19 是「离线一次、下载无数次」场景的常用档位，单产物约 15–20 秒 */
const ZSTD_LEVEL = 19

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
  fail(`发布 tag 非法：${tag}（应形如 v0.1.1 或 v0.1.1-2，与 Release tag 一致）`)
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
// `.zst` 是本脚本自己产的压缩包，不是安装包本体，跳过。
const byPlatform = new Map<string, string>()
for (const name of names) {
  if (name === 'latest.json' || name.startsWith('.') || name.endsWith(COMPRESSED_ASSET_EXT)) continue
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

  // 产物 60–84MB：整个读进内存再压缩（六平台顺序处理，同一时刻只占一份），
  // zstd 19 级单产物约 15–20 秒，整个发布任务多花两分钟左右，换来下载量省 2/3。
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
  const size = bytes.byteLength
  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

  const zstdBytes = Bun.zstdCompressSync(bytes, { level: ZSTD_LEVEL })
  const zstdName = compressedAssetName(name)
  await Bun.write(join(dir, zstdName), zstdBytes)
  const zstdSha256 = new Bun.CryptoHasher('sha256').update(zstdBytes).digest('hex')

  assets.push({
    platform,
    name,
    size,
    sha256,
    zstd: { name: zstdName, size: zstdBytes.byteLength, sha256: zstdSha256 },
  })
  console.log(
    `  ${platform.padEnd(14)} ${name}  ${sha256.slice(0, 12)}…  ${size} bytes` +
      `  →  ${zstdName}  ${zstdBytes.byteLength} bytes（${((100 * zstdBytes.byteLength) / size).toFixed(0)}%）`,
  )
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
