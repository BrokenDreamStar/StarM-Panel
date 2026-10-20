/**
 * 生成发布用更新清单 latest.json，并把六平台裸产物打包成归档。
 *
 * 在 release 工作流里、六个平台产物全部取回之后运行：
 *
 *   bun run scripts/gen-update-manifest.ts release-out v0.1.5
 *
 * tag 是发布工作流 prepare 阶段算出来的：首发 `v0.1.5`，
 * 同版本重复发布 `v0.1.5-2`。清单被上传为 Release 资产，更新器通过官方稳定地址
 * `https://github.com/<repo>/releases/latest/download/latest.json` 读取它：
 * 一次请求就能拿到 tag、版本、各平台归档名、大小与 sha256，
 * 不占 GitHub API 配额、不需要 token，也不需要猜资产命名。
 *
 * Release 只发布归档（ADR-008）：Windows 打 `.zip`，macOS / Linux 打 `.tar.gz`
 * —— 为什么不是 zstd、为什么 Unix 不用 zip，见 src/shared/update.ts 的注释与
 * docs/DESIGN.md。裸产物在打完包后**从产物目录删掉**，不再上传，避免同一份内容
 * 在 Release 里存两遍；因此本脚本不可重复运行（第二次会找不到裸产物）。
 *
 * 清单里的 size / sha256 描述**解压后的可执行文件**，archive 字段描述归档本身；
 * 打完包立刻用更新器同一套解包代码读回来核对一遍，把格式问题挡在发版之前。
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  UPDATE_PLATFORMS,
  archiveKindBySuffix,
  archiveNameFor,
  parseReleaseTag,
  platformFromAssetName,
  type UpdateArchiveKind,
  type UpdateManifest,
  type UpdateManifestAsset,
} from '../src/shared/update'
import { extractArchive } from '../src/server/services/archive'

/** 归档扩展名：扫描产物目录时要跳过它们（它们是本脚本的产出，不是输入） */
const ARCHIVE_EXTS = ['.tar.gz', '.zip']

function fail(message: string): never {
  console.error(`\n[manifest] ${message}\n`)
  process.exit(1)
}

/** 流式算 sha256：产物 60–84MB，不把整个文件读进内存 */
async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const hasher = new Bun.CryptoHasher('sha256')
  let size = 0
  const reader = Bun.file(path).stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    hasher.update(value)
  }
  return { size, sha256: hasher.digest('hex') }
}

/**
 * 用系统自带的 `zip` / `tar` 打包（ubuntu runner 与 macOS 都有）。
 *
 * 两个工具都会把 Unix 权限位写进归档，所以用户解开后直接就是可执行文件。
 * 不用 Bun 现成的 API：`Bun.Archive` 只支持 tar（生成 tar.gz 会把权限位写成 0644），
 * 而 zip 得自己写编码器，不值得。
 */
function spawnArchive(cmd: string[], cwd: string) {
  try {
    return Bun.spawn({ cmd, cwd, stdout: 'ignore', stderr: 'pipe' })
  } catch (err) {
    fail(`调用 ${cmd[0]} 失败：${err instanceof Error ? err.message : String(err)}（需要系统自带 zip / tar）`)
  }
}

async function createArchive(dir: string, kind: UpdateArchiveKind, fileName: string, archiveName: string): Promise<void> {
  const cmd = kind === 'zip' ? ['zip', '-9', '-X', archiveName, fileName] : ['tar', '-czf', archiveName, fileName]
  const proc = spawnArchive(cmd, dir)
  const code = await proc.exited
  if (code !== 0) {
    const detail = (await new Response(proc.stderr).text()).trim()
    fail(`打包 ${archiveName} 失败（${cmd[0]} 退出码 ${code}）：${detail}`)
  }
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
  fail(`发布 tag 非法：${tag}（应形如 v0.1.5 或 v0.1.5-2，与 Release tag 一致）`)
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
  if (ARCHIVE_EXTS.some((ext) => name.endsWith(ext))) continue
  const platform = platformFromAssetName(name)
  if (!platform) continue
  if (byPlatform.has(platform)) {
    fail(`平台 ${platform} 同时匹配到多个文件：${byPlatform.get(platform)} / ${name}`)
  }
  byPlatform.set(platform, name)
}

const missing = UPDATE_PLATFORMS.filter((p) => !byPlatform.has(p))
if (missing.length > 0) {
  fail(
    `缺少这些平台的产物：${missing.join('、')}\n  目录：${dir}\n` +
      '  （本脚本会把裸产物打包成归档后删除，不能对同一目录重复运行）',
  )
}

const assets: UpdateManifestAsset[] = []
{
  for (const platform of UPDATE_PLATFORMS) {
    const name = byPlatform.get(platform)
    if (!name) fail(`缺少 ${platform} 的产物`)
    const path = join(dir, name)
    const stat = statSync(path)
    if (!stat.isFile() || stat.size <= 0) fail(`${name} 不是有效的非空文件`)

    const { size, sha256 } = await hashFile(path)
    const kind = archiveKindBySuffix(platform)
    const archiveName = archiveNameFor(name, platform)
    const archivePath = join(dir, archiveName)

    await createArchive(dir, kind, name, archiveName)
    const archive = await hashFile(archivePath)

    // 自检：用更新器同一套解包代码读回来，核对文件名与内容。
    // 归档格式 / 权限位 / 文件名这类问题必须在这里暴露，而不是等用户点更新。
    const unpacked = await extractArchive(new Uint8Array(await Bun.file(archivePath).arrayBuffer()), kind)
    if (unpacked.name !== name) {
      fail(`${archiveName} 里的文件名是 ${unpacked.name}，预期 ${name}`)
    }
    const unpackedSha = new Bun.CryptoHasher('sha256').update(unpacked.bytes).digest('hex')
    if (unpacked.bytes.byteLength !== size || unpackedSha !== sha256) {
      fail(`${archiveName} 解出来的内容和原产物不一致（${unpacked.bytes.byteLength} vs ${size} 字节）`)
    }

    // Release 只发归档：裸产物到此为止，避免同一份内容存两遍
    unlinkSync(path)

    assets.push({
      platform,
      name,
      size,
      sha256,
      archive: { kind, name: archiveName, size: archive.size, sha256: archive.sha256 },
    })
    console.log(
      `  ${platform.padEnd(14)} ${archiveName}  ${archive.size} bytes（${((100 * archive.size) / size).toFixed(0)}%）` +
        `  → 解压 ${size} bytes  sha256 ${sha256.slice(0, 12)}…`,
    )
  }
}

const manifest: UpdateManifest = {
  schema: 2,
  tag,
  version: parsed.version,
  publishedAt: new Date().toISOString(),
  assets,
}

await Bun.write(outFile, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`\n[manifest] 已生成 ${basename(outFile)}（${assets.length} 个平台，tag ${tag}）`)
