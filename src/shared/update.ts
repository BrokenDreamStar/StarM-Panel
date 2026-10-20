/**
 * 软件更新相关的纯函数 —— 前后端共用。
 *
 * 这里只做「比较版本」「认平台归档」「校验更新清单」三件事，不碰网络与文件系统：
 * 服务端（services/update.ts）负责拉取 GitHub Release、下载解包与替换，
 * 前端只消费服务端算好的结果。放在 src/shared 下是为了让这些规则只有一份，
 * 单测也只针对这一份 —— 更新器判错一步就是装错文件。
 */

/** 解析后的发布标识：`v0.1.0-5` → version=0.1.0、build=5 */
export interface ReleaseVersion {
  /** 原始 tag（保留 v 前缀，用于展示与日志） */
  tag: string
  /** 语义版本三段（`0.1.0`） */
  version: string
  /**
   * 同版本内的重复发布序号。首次发布不带序号（`v0.1.1`），
   * 之后同版本再发才追加（`v0.1.1-2`、`v0.1.1-3`…）；不带序号时为 null。
   */
  build: number | null
}

/**
 * 解析发布 tag。
 *
 * 只接受本项目 release 工作流产出的两种形态：
 *   - 版本首发：`v0.1.0`
 *   - 同版本重复发布：`v0.1.0-5`（序号从 2 开始）
 * 不符合格式（预发布版、手写 tag）返回 null —— 调用方据此拒绝「更新」，
 * 而不是猜一个语义去比大小。
 */
export function parseReleaseTag(tag: string | null | undefined): ReleaseVersion | null {
  if (!tag) return null
  const raw = tag.trim()
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(raw)
  if (!m) return null
  const version = `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`
  const build = m[4] === undefined ? null : Number(m[4])
  return { tag: raw, version, build }
}

/**
 * 比较两个三段式版本号，返回 -1 / 0 / 1。
 *
 * 刻意不引入 semver 依赖：本项目只需要 `x.y.z` 的数字比较。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/**
 * latest 是否比 current 新。
 *
 * 先比版本号；版本号相同再比「同版本重复发布序号」。
 * 不带序号的是该版本的首发，按 0 计 —— 因此 `v0.1.1` 之后发布的
 * `v0.1.1-2` 会被识别为更新；反过来，已经装了 `v0.1.1-2` 不会被首发版「更新」回去。
 * 手写构建 / 开发模式没有发布 tag，同样按 0 计：它们会被提示更新到同版本的正式发布，
 * 而更新之后产物里带上了 tag，就不会再反复提示。
 */
export function isNewerRelease(latest: ReleaseVersion, current: ReleaseVersion): boolean {
  const cmp = compareVersions(latest.version, current.version)
  if (cmp !== 0) return cmp > 0
  return (latest.build ?? 0) > (current.build ?? 0)
}

/**
 * 计算本次发布应当使用的 tag。
 *
 * 规则：**每个版本的第一次发布不带序号**（`v0.1.1`），同一版本重复发布才追加
 * （`v0.1.1-2`、`v0.1.1-3`…）。判断依据是仓库里已有的 tag：
 * 没有该版本的 tag → 首发；已有（无论带不带序号）→ 取最大序号 + 1。
 * 不带序号的那次视为 1，所以首发之后的第一次重复发布是 `-2`。
 *
 * 历史 tag `v<version>-<run_number>` 同样按数字序号参与计算，换规则不会把序号用重。
 * 版本号非法（不是三段式）返回 null。
 */
export function nextReleaseTag(version: string, existingTags: readonly string[]): string | null {
  const raw = version.trim().replace(/^v/i, '')
  const parsedVersion = parseReleaseTag(`v${raw}`)
  if (!parsedVersion || parsedVersion.build !== null) return null
  const target = parsedVersion.version

  let seen = false
  let maxBuild = 0
  for (const existing of existingTags) {
    const parsed = parseReleaseTag(existing)
    if (!parsed || parsed.version !== target) continue
    seen = true
    // 首发（不带序号）按 1 计，重复发布的序号从它之后接着排
    maxBuild = Math.max(maxBuild, parsed.build ?? 1)
  }

  if (!seen) return `v${target}`
  return `v${target}-${Math.max(maxBuild, 1) + 1}`
}

/**
 * 当前运行平台对应的安装包后缀（不含文件名前缀与 `.exe`）。
 *
 * 与 release 工作流的矩阵保持一致：darwin / linux / windows × x64 / arm64。
 * 不支持的组合返回 null，前端据此提示「该平台没有发布包」。
 */
export function platformSuffix(platform: string, arch: string): string | null {
  const os =
    platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'windows' : null
  if (!os) return null
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null
  if (!cpu) return null
  return `${os}-${cpu}`
}

/**
 * 发布矩阵覆盖的全部平台后缀。
 *
 * `latest.json` 的 `platform` 字段与 Release 资产名里的后缀都以此为准，
 * 生成脚本与更新器共用同一份列表，避免两边各写一套。
 */
export const UPDATE_PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'windows-arm64',
  'windows-x64',
] as const

export type UpdatePlatform = (typeof UPDATE_PLATFORMS)[number]

/**
 * 从安装包 / 归档文件名识别平台后缀。
 *
 * 兼容裸可执行文件名（`starm-panel-v0.1.0-linux-x64`、Windows 带 `.exe`）、
 * 归档名（`.tar.gz` / `.zip`）以及早期不带版本号的命名。
 * 识别不出返回 null（清单生成时据此报错）。
 */
export function platformFromAssetName(name: string): UpdatePlatform | null {
  let base = name
  for (const ext of ['.tar.gz', '.zip', '.exe']) {
    if (base.endsWith(ext)) {
      base = base.slice(0, -ext.length)
      break
    }
  }
  for (const platform of UPDATE_PLATFORMS) {
    if (base.endsWith(`-${platform}`)) return platform
  }
  return null
}

/**
 * 当前平台归档的文件名候选（按优先级）。
 *
 * 新版发布带版本号（`starm-panel-v0.1.5-linux-x64.tar.gz`），早期发布不带版本号。
 * 网页备用检查拿不到 Release 的资产清单，只能按名字探测，因此两个都试一遍。
 * 归档格式按平台决定（Windows `.zip`，其余 `.tar.gz`）。
 */
export function assetNameCandidates(version: string, suffix: string): string[] {
  const ext = archiveExtension(archiveKindBySuffix(suffix))
  const versioned = `starm-panel-v${version}-${suffix}${ext}`
  const legacy = `starm-panel-${suffix}${ext}`
  return versioned === legacy ? [versioned] : [versioned, legacy]
}

/**
 * 从 `/releases/latest` 的跳转地址解析发布 tag。
 *
 * 只接受与 webBase 同源的 `/…/releases/tag/<tag>` 路径：即使 HTTPS
 * 已经保证响应可信，也没必要跟着任意跨站 Location 走。
 */
export function tagFromReleaseLocation(location: string, webBase: string): string | null {
  try {
    const base = new URL(webBase)
    const u = new URL(location, base)
    if (u.origin !== base.origin) return null
    const m = /\/releases\/tag\/([^/?#]+)\/?$/.exec(u.pathname)
    if (!m?.[1]) return null
    return decodeURIComponent(m[1]) || null
  } catch {
    return null
  }
}

/**
 * 文件头是否为当前平台的可执行格式。
 *
 * 网页备用路径拿不到 GitHub 资产的 sha256 digest，用它做最后一道兜底：
 * 至少保证下载到的不是 HTML 错误页或被换成的错误平台文件。
 */
export function isPlatformExecutableHeader(bytes: Uint8Array, platform: string): boolean {
  if (bytes.byteLength < 4) return false
  const hex = Array.from(bytes.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join('')
  switch (platform) {
    case 'linux':
      return hex === '7f454c46' // \x7fELF
    case 'darwin':
      return (
        // MH_CIGAM_64 / MH_MAGIC_64 / MH_CIGAM / MH_MAGIC / FAT / FAT_CIGAM / FAT_64 变体
        ['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(
          hex,
        )
      )
    case 'win32':
      return hex.startsWith('4d5a') // MZ
    default:
      // 未知平台不做格式假设（目前 release 矩阵只覆盖以上三种）
      return true
  }
}

/**
 * 归档格式。
 *
 * Windows 用 `.zip`（资源管理器双击即可解压），macOS / Linux 用 `.tar.gz`
 * （系统自带 tar，而 `unzip` 在很多最小化发行版里要额外安装）。
 * 体积上两者几乎一样（同一套 deflate 算法，实测 60/79MB 产物差 0.01–0.10 MiB），
 * 所以选格式只看「用户手里有什么工具」。
 */
export type UpdateArchiveKind = 'zip' | 'tar.gz'

/** 归档扩展名 */
export function archiveExtension(kind: UpdateArchiveKind): string {
  return kind === 'zip' ? '.zip' : '.tar.gz'
}

/** 平台后缀 → 归档格式 */
export function archiveKindBySuffix(suffix: string): UpdateArchiveKind {
  return suffix.startsWith('windows-') ? 'zip' : 'tar.gz'
}

/**
 * 归档名 → 归档内那个可执行文件的名字（Windows 在 zip 里带 `.exe`）。
 *
 * 网页备用路径拿不到清单，只能按归档名反推该期待什么文件名；清单路径直接用
 * 清单里的 `name`，两条路径都对解包结果做同样的核对。
 */
export function executableNameFromArchive(archiveName: string, suffix: string): string {
  let base = archiveName
  for (const ext of ['.tar.gz', '.zip']) {
    if (base.endsWith(ext)) {
      base = base.slice(0, -ext.length)
      break
    }
  }
  return archiveKindBySuffix(suffix) === 'zip' ? `${base}.exe` : base
}

/**
 * 归档文件名。
 *
 * Windows 的可执行文件带 `.exe`，归档名去掉它（`…-windows-x64.zip`），
 * 归档内部仍然是 `…-windows-x64.exe`；其余平台直接加 `.tar.gz`。
 */
export function archiveNameFor(assetName: string, suffix: string): string {
  const kind = archiveKindBySuffix(suffix)
  const base = kind === 'zip' && assetName.endsWith('.exe') ? assetName.slice(0, -'.exe'.length) : assetName
  return `${base}${archiveExtension(kind)}`
}

/**
 * `latest.json` 里单个平台产物的归档 —— 更新器实际下载的对象。
 *
 * 归档只用于**传输**：更新器解压后按未压缩产物的 `size` / `sha256` 校验，
 * 再写盘替换，所以压缩不降低校验强度，也不改变安装后的文件体积。
 */
export interface UpdateManifestArchive {
  kind: UpdateArchiveKind
  /** 归档文件名，形如 `starm-panel-v0.1.5-linux-x64.tar.gz` */
  name: string
  /** 归档字节数 */
  size: number
  /** 归档的 sha256（hex） */
  sha256: string
}

/**
 * `latest.json` 更新清单的单个平台条目。
 *
 * `name` / `size` / `sha256` 描述**解压后的可执行文件**（也是安装后的文件名），
 * `archive` 描述要下载的归档；两者都从即将上传的同一批文件算出。
 */
export interface UpdateManifestAsset {
  platform: UpdatePlatform
  name: string
  size: number
  sha256: string
  archive: UpdateManifestArchive
}

/**
 * `latest.json` 更新清单（schema = 2）。
 *
 * 从 schema 2 起 Release 只发布归档、不再有裸可执行文件，因此 0.1.4 及更早的
 * 客户端无法再自动更新 —— 这是刻意接受的取舍（见 docs/DESIGN.md ADR-008）。
 */
export interface UpdateManifest {
  schema: 2
  /** 发布 tag，如 v0.1.0-6 */
  tag: string
  /** 版本号（必须与 tag 的版本段一致） */
  version: string
  /** ISO 8601，可选展示 */
  publishedAt: string | null
  assets: UpdateManifestAsset[]
}

const SHA256_RE = /^[0-9a-f]{64}$/i
/** 资产名只允许文件名字符：它会被拼进下载 URL，不接受路径分隔符 */
const ASSET_NAME_RE = /^[A-Za-z0-9._-]+$/

/**
 * 解析条目的 `archive` 字段。
 *
 * 归档是唯一的下载对象，没有任何容错余地：格式必须与平台匹配、文件名必须是
 * 该安装包对应的归档名、size / sha256 必须合法 —— 有一项不对就整份清单判坏，
 * 否则就会出现「下到的不是被校验过的东西」。
 */
function parseArchiveAsset(
  raw: unknown,
  assetName: string,
  platform: UpdatePlatform,
): UpdateManifestArchive | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const kind = o.kind === 'zip' || o.kind === 'tar.gz' ? o.kind : null
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const size = typeof o.size === 'number' && Number.isFinite(o.size) && o.size > 0 ? o.size : null
  const sha256 = typeof o.sha256 === 'string' ? o.sha256.trim() : ''
  if (!kind || size === null || !SHA256_RE.test(sha256)) return null
  if (!ASSET_NAME_RE.test(name) || name !== archiveNameFor(assetName, platform)) return null
  // 平台与归档格式必须对得上：Windows 只能 zip，其余只能 tar.gz
  if (kind !== archiveKindBySuffix(platform)) return null
  return { kind, name, size, sha256: sha256.toLowerCase() }
}

/**
 * 校验并解析 `latest.json`。
 *
 * 这里是更新器的信任边界：结构、平台、大小、sha256、tag 版本一致性
 * 任何一项不合法都返回 null，由调用方退回网页检查或报错；
 * 不做「尽量猜」的容错 —— 猜测只会让坏清单变成装错文件。
 */
export function parseUpdateManifest(raw: unknown): UpdateManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.schema !== 2) return null

  const tag = typeof o.tag === 'string' ? o.tag.trim() : ''
  const parsed = parseReleaseTag(tag)
  if (!parsed) return null

  const version = typeof o.version === 'string' ? o.version.trim() : ''
  if (version !== parsed.version) return null

  const publishedAt = typeof o.publishedAt === 'string' && o.publishedAt !== '' ? o.publishedAt : null
  const rawAssets = Array.isArray(o.assets) ? o.assets : null
  if (!rawAssets || rawAssets.length === 0) return null

  const assets: UpdateManifestAsset[] = []
  for (const item of rawAssets) {
    if (!item || typeof item !== 'object') return null
    const a = item as Record<string, unknown>
    const platform = typeof a.platform === 'string' ? a.platform : ''
    const name = typeof a.name === 'string' ? a.name.trim() : ''
    const size = typeof a.size === 'number' && Number.isFinite(a.size) && a.size > 0 ? a.size : null
    const sha256 = typeof a.sha256 === 'string' ? a.sha256.trim() : ''
    // 未知平台直接忽略：以后发布矩阵增加平台时，旧客户端不该整份清单判坏
    if (!UPDATE_PLATFORMS.includes(platform as UpdatePlatform)) continue
    if (!ASSET_NAME_RE.test(name) || size === null || !SHA256_RE.test(sha256)) return null
    const archive = parseArchiveAsset(a.archive, name, platform as UpdatePlatform)
    if (!archive) return null
    // 同一平台出现两次说明清单生成有 bug，直接判坏
    if (assets.some((x) => x.platform === platform)) return null
    assets.push({
      platform: platform as UpdatePlatform,
      name,
      size,
      sha256: sha256.toLowerCase(),
      archive,
    })
  }

  // 全部条目都是未知平台时等同于坏清单
  if (assets.length === 0) return null

  return { schema: 2, tag: parsed.tag, version: parsed.version, publishedAt, assets }
}

/**
 * 是否允许从该地址下载安装包。
 *
 * 资产地址由更新器按 `base/repo/releases/download/tag/name` 拼出，
 * 正常情况下是 github.com，重定向后是 *.githubusercontent.com。
 * 白名单之外的地址一律拒绝，避免把面板变成下载器去请求任意地址（SSRF）。
 * 自定义镜像只从服务端环境变量读取，不走这里 —— 那是部署者显式配置的可信来源。
 */
export function isAllowedDownloadUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  return host === 'github.com' || host.endsWith('.githubusercontent.com')
}

/** 回环地址（本地镜像 / 调试用的模拟 Release 服务） */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * 部署者配置的更新源地址（`STARM_UPDATE_BASE` / `STARM_UPDATE_MIRROR`）。
 *
 * 默认要求 https；只对回环地址放行 http，方便本机调试与本地镜像，
 * 同时不会因为一条环境变量把面板变成向任意明文地址请求下载器的跳板。
 * GitHub 返回的资产地址仍由 isAllowedDownloadUrl 限制为 https。
 */
export function isAllowedSourceUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.username || u.password || !u.hostname) return false
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && isLoopbackHost(u.hostname)
  } catch {
    return false
  }
}
