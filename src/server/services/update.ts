/**
 * 软件更新 —— 从 GitHub Releases 拉取新版本、下载并原地替换当前可执行文件。
 *
 * 背景（见 docs/DESIGN.md ADR-008）：
 *   - 面板是单文件产物、没有进程守护，自己的更新只能「自己替换自己再重启」；
 *   - 发布 tag 首发为 `v<version>`，同一版本重复发布才带序号（`v<version>-2`…），
 *     因此「当前版本」以构建期注入的 RELEASE_TAG 为准（见 src/shared/version.ts）。
 *
 * 流程：检查（latest.json，缺失时回退网页）→ 下载归档 → 校验归档大小 / sha256 →
 * 解压并核对可执行文件（名字 + 大小 + sha256）→ 写临时文件、改名替换 →
 * 交给 services/restart 拉起新进程。
 *
 * 下载体积：Release 只发布归档（Windows `.zip`、macOS/Linux `.tar.gz`，
 * 60–84MB → 25–35MB，约四成），解压后仍按清单里的可执行文件 size / sha256 校验，
 * 校验强度与下载裸可执行文件一致。压缩只省下载流量，装上去的文件体积不变。
 *
 * 平台差异：Windows 不能覆盖正在运行的 exe，但**可以改名**，所以
 * 「旧文件改成 .old、新文件改成原名」这条路径两个平台通用。
 * 替换成功后 .old 会保留到下一次成功启动 —— 新版本起不来时它就是回滚点。
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  archiveKindBySuffix,
  assetNameCandidates,
  executableNameFromArchive,
  isAllowedDownloadUrl,
  isAllowedSourceUrl,
  isNewerRelease,
  isPlatformExecutableHeader,
  parseReleaseTag,
  parseUpdateManifest,
  platformSuffix,
  tagFromReleaseLocation,
  type ReleaseVersion,
  type UpdateArchiveKind,
} from '@shared/update'
import type { UpdateCheckResult, UpdateReleaseInfo, UpdateState } from '@shared/types'
import { APP_VERSION, RELEASE_TAG } from '@shared/version'
import { getConfig } from '../env'
import { HttpError } from '../middleware/error'
import { extractArchive } from './archive'
import { isVirtualEntry, scheduleRestart } from './restart'

/** 一次检查的总预算：清单 + 网页回退 + 资产探测都在这个窗口内完成 */
const CHECK_TIMEOUT_MS = 25_000
/** 拉取 latest.json / 网页检查的单步超时；网络不可达时最多等这么久 */
const MANIFEST_TIMEOUT_MS = 10_000
/** 安装包下载超时：80MB 级产物在慢速网络上也要给足时间 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
/** 网页方式探测安装包（HEAD）的超时 */
const PROBE_TIMEOUT_MS = 10_000
/** 检查结果缓存时长：避免反复点「检查更新」时重复下载清单 / 探测资产 */
const CACHE_TTL_MS = 60_000

/**
 * 从 Release 里挑出来的安装包。
 *
 * Release 只发布归档，所以下载对象永远是 `archive`；`name` / `size` / `digest`
 * 描述解压之后的可执行文件（清单才有，网页备用路径拿不到）。
 */
interface DownloadAsset {
  /** 归档内的可执行文件名，也是安装后的文件名 */
  name: string
  /** 解压后的字节数；未知为 null */
  size: number | null
  /** 解压后的 sha256（hex）；未知为 null */
  digest: string | null
  /** 归档本身（唯一的下载对象） */
  archive: {
    kind: UpdateArchiveKind
    name: string
    /** 归档字节数；未知为 null */
    size: number | null
    /** 归档的 sha256（hex）；网页备用路径为 null */
    digest: string | null
    url: string
  }
  /** 可信来源 origin：下载时据此核对最终跳转地址 */
  origin: string
}

interface LatestRelease {
  info: UpdateReleaseInfo
  /** 当前平台对应的安装包；该 Release 没有上传时为 null */
  asset: DownloadAsset | null
}

interface CachedCheck {
  at: number
  result: UpdateCheckResult
  release: LatestRelease | null
}

/** 校验过的更新源配置（每台机器固定，检查时解析一次） */
interface UpdateRuntimeConfig {
  /** owner/name */
  repo: string
  /** GitHub 网页根地址（GitHub.com 或 Enterprise 域名） */
  base: string
  mirror: string
}

/**
 * 清单不可用。
 *
 * 清单缺失（老版本发布）、清单损坏、网络/代理拒绝时不直接失败，
 * 而是回退到网页方式再试一次；这类失败都不代表「没有新版本」。
 */
class ManifestUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestUnavailableError'
  }
}

/**
 * 下载地址不在白名单内 —— 属于信任边界问题，直接中止整次更新，
 * 不做任何「换条路径再试」的兜底。
 */
const UNTRUSTED_ASSET_MESSAGE = '下载地址不在允许的域名内，已中止'

/** 进程级单例：同一时间只允许一个更新任务（见 startUpdate） */
let cached: CachedCheck | null = null

const IDLE_STATE: UpdateState = {
  phase: 'idle',
  tag: null,
  received: 0,
  total: null,
  error: null,
  startedAt: null,
}

let state: UpdateState = { ...IDLE_STATE }

const ACTIVE_PHASES: ReadonlySet<UpdateState['phase']> = new Set([
  'downloading',
  'verifying',
  'installing',
  'restarting',
])

/** 只有编译成单文件产物之后才能替换自身；`bun run dev` 下 execPath 是 bun 本体 */
export function isCompiledBinary(): boolean {
  return isVirtualEntry(process.argv[1])
}

/** 当前运行的版本描述 —— 没有构建期 tag 时退化为 package.json 版本（不参与序号比较） */
function currentRelease(): ReleaseVersion {
  return parseReleaseTag(RELEASE_TAG) ?? {
    tag: `v${APP_VERSION}`,
    version: APP_VERSION,
    build: null,
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 删除临时文件 / 备份时的尽力而为：清理失败不应掩盖真正的错误 */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    /* 忽略 */
  }
}

/** 校验 owner/name，同时挡掉 `..` 这类会把 URL 路径带偏的写法 */
function repoPath(repo: string): string | null {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo.trim())
  if (!m) return null
  if (m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return null
  return `${m[1]}/${m[2]}`
}

export function getUpdateState(): UpdateState {
  return { ...state }
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
}

/** 单步超时：不超过上限，也不超出本次检查的总预算 */
function stepTimeout(deadline: number, cap: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    throw new Error(`检查更新超时：面板在 ${Math.round(CHECK_TIMEOUT_MS / 1000)} 秒内没能访问到 GitHub`)
  }
  return Math.min(cap, remaining)
}

/** 拼下载地址：配置了镜像就前缀拼接（ghproxy 约定），否则直连 GitHub 资产地址 */
function resolveDownloadUrl(original: string, mirror: string): string {
  if (!mirror) return original
  return `${mirror}${original}`
}

/** 解析并校验更新源配置；非法配置直接抛错（不触发网页回退） */
function resolveUpdateRuntimeConfig(): UpdateRuntimeConfig {
  const { update } = getConfig()
  const repo = repoPath(update.repo)
  if (!repo) {
    throw new Error(`STARM_UPDATE_REPO 配置非法：${update.repo}（应形如 owner/name）`)
  }
  if (!isAllowedSourceUrl(update.base)) {
    throw new Error(
      `STARM_UPDATE_BASE 配置非法：${update.base}（需要 https 地址；本机回环可用 http）`,
    )
  }
  if (update.mirror && !isAllowedSourceUrl(update.mirror)) {
    throw new Error(
      `STARM_UPDATE_MIRROR 配置非法：${update.mirror}（需要 https 地址；本机回环可用 http）`,
    )
  }
  return { repo, base: update.base, mirror: update.mirror }
}

/**
 * 清单路径（首选）：读取 Release 附带的最新版本清单 latest.json。
 *
 * 地址是 GitHub 官方支持的最新媒体资产链接：
 *   {base}/{repo}/releases/latest/download/latest.json
 * 一次请求就能拿到 tag、版本、各平台资产名、大小与 sha256，
 * 不占 GitHub API 配额、不需要 token、也不依赖网页 HTML 结构。
 */
async function fetchLatestReleaseViaManifest(
  cfg: UpdateRuntimeConfig,
  deadline: number,
): Promise<LatestRelease> {
  const manifestUrl = `${cfg.base}/${cfg.repo}/releases/latest/download/latest.json`

  let res: Response
  try {
    res = await fetch(manifestUrl, {
      headers: { 'user-agent': `starm-panel/${APP_VERSION}` },
      signal: AbortSignal.timeout(stepTimeout(deadline, MANIFEST_TIMEOUT_MS)),
    })
  } catch (err) {
    throw new ManifestUnavailableError(`无法连接 GitHub：${errorMessage(err)}`)
  }

  if (res.status === 404) {
    // 旧版本发布没有清单；交给网页回退，而不是直接告诉用户「没有新版本」
    throw new ManifestUnavailableError('最新发布里没有 latest.json')
  }
  if (res.status === 403 || res.status === 429) {
    throw new ManifestUnavailableError(`GitHub 拒绝访问（HTTP ${res.status}）`)
  }
  if (!res.ok) {
    throw new ManifestUnavailableError(`下载 latest.json 失败（HTTP ${res.status}）`)
  }

  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    throw new ManifestUnavailableError('latest.json 不是合法 JSON')
  }
  const manifest = parseUpdateManifest(raw)
  if (!manifest) {
    throw new ManifestUnavailableError('latest.json 结构不合法或缺少关键字段')
  }

  const suffix = platformSuffix(process.platform, process.arch)
  if (!suffix) {
    throw new Error(`当前平台（${process.platform}-${process.arch}）没有对应的发布包`)
  }

  const entry = manifest.assets.find((a) => a.platform === suffix)
  let asset: DownloadAsset | null = null
  if (entry) {
    // 固定到清单里的 tag，而不是 /latest/：检查与下载之间再发版也不会串版本
    const releaseUrl = (assetName: string): string =>
      `${cfg.base}/${cfg.repo}/releases/download/${encodeURIComponent(manifest.tag)}/${encodeURIComponent(assetName)}`
    asset = {
      name: entry.name,
      size: entry.size,
      digest: entry.sha256,
      archive: {
        kind: entry.archive.kind,
        name: entry.archive.name,
        size: entry.archive.size,
        digest: entry.archive.sha256,
        url: resolveDownloadUrl(releaseUrl(entry.archive.name), cfg.mirror),
      },
      origin: cfg.base,
    }
  }

  return {
    info: {
      tag: manifest.tag,
      version: manifest.version,
      name: manifest.tag,
      publishedAt: manifest.publishedAt,
      htmlUrl: `${cfg.base}/${cfg.repo}/releases/tag/${encodeURIComponent(manifest.tag)}`,
      assetName: asset?.name ?? null,
      // 展示 / 初始化进度条都用「这次要下载多少」—— 也就是归档的大小
      assetSize: asset?.archive.size ?? null,
    },
    asset,
  }
}

/**
 * 网页路径（兜底）：latest.json 不可用时才走这里。
 *
 * 先用 `/releases/latest` 的 302 跳转拿到最新 tag（与网页「最新发布」语义一致），
 * 再按发布资产命名规则探测当前平台的归档（`.tar.gz` / `.zip`）。拿不到 digest，
 * 因此下载后只做「归档大小 + 解包后的可执行文件头」校验（见 runUpdate）。
 */
async function fetchLatestReleaseViaWeb(
  cfg: UpdateRuntimeConfig,
  deadline: number,
): Promise<LatestRelease> {
  const latestUrl = `${cfg.base}/${cfg.repo}/releases/latest`
  let res: Response
  try {
    res = await fetch(latestUrl, {
      redirect: 'manual',
      headers: { 'user-agent': `starm-panel/${APP_VERSION}` },
      signal: AbortSignal.timeout(stepTimeout(deadline, MANIFEST_TIMEOUT_MS)),
    })
  } catch (err) {
    throw new Error(`无法连接 GitHub 网页：${errorMessage(err)}`)
  }

  const location = res.headers.get('location')
  if (!location) {
    if (res.status === 403 || res.status === 429) {
      throw new Error(`GitHub 网页请求被拒绝（HTTP ${res.status}）`)
    }
    throw new Error(`GitHub 网页没有返回最新版本地址（HTTP ${res.status}）`)
  }

  const tag = tagFromReleaseLocation(location, cfg.base)
  if (!tag) throw new Error('无法从 GitHub 网页解析最新版本号')
  const parsed = parseReleaseTag(tag)
  if (!parsed) throw new Error(`无法识别的发布 tag：${tag}（应形如 v0.1.1 或 v0.1.1-2）`)

  const suffix = platformSuffix(process.platform, process.arch)
  if (!suffix) throw new Error(`当前平台（${process.platform}-${process.arch}）没有对应的发布包`)

  let asset: DownloadAsset | null = null
  let probeError: Error | null = null
  for (const name of assetNameCandidates(parsed.version, suffix)) {
    const url = `${cfg.base}/${cfg.repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
    try {
      const probe = await probeAsset(url, cfg, deadline)
      if (!probe) continue
      asset = {
        name: executableNameFromArchive(name, suffix),
        size: null,
        // 网页方式拿不到官方 digest，由 runUpdate 用大小 + 可执行文件头兜底
        digest: null,
        archive: {
          kind: archiveKindBySuffix(suffix),
          name,
          size: probe.size,
          digest: null,
          url: resolveDownloadUrl(url, cfg.mirror),
        },
        origin: cfg.base,
      }
      break
    } catch (err) {
      // 记下网络/信任校验错误：两个候选都失败时要报「连不上」，
      // 而不是误报成「这个版本没有当前平台的安装包」
      probeError = err instanceof Error ? err : new Error(String(err))
    }
  }
  if (!asset && probeError) throw probeError

  return {
    info: {
      tag,
      version: parsed.version,
      name: tag,
      publishedAt: null,
      htmlUrl: `${cfg.base}/${cfg.repo}/releases/tag/${encodeURIComponent(tag)}`,
      assetName: asset?.name ?? null,
      assetSize: asset?.archive.size ?? null,
    },
    asset,
  }
}

/**
 * 用 HEAD 探测资产是否存在并取大小。
 *
 * 失败（404 / 网络错误 / 最终跳转到了不可信域名）返回 null，
 * 由调用方继续尝试下一个候选文件名。
 */
async function probeAsset(
  url: string,
  cfg: UpdateRuntimeConfig,
  deadline: number,
): Promise<{ size: number | null } | null> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'user-agent': `starm-panel/${APP_VERSION}` },
      signal: AbortSignal.timeout(stepTimeout(deadline, PROBE_TIMEOUT_MS)),
    })
  } catch (err) {
    throw new Error(`无法连接 GitHub：${errorMessage(err)}`)
  }
  // 404 表示这个候选文件名不存在，继续试下一个
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`获取安装包信息失败（HTTP ${res.status}）`)
  if (!isTrustedAssetUrl(res.url || url, cfg.base)) {
    throw new Error('安装包地址不在允许的域名内')
  }
  const len = Number(res.headers.get('content-length'))
  return { size: Number.isFinite(len) && len > 0 ? len : null }
}

/** 下载地址是否可信：与 GitHub 来源同源，或落在 GitHub 官方资产域名 */
function isTrustedAssetUrl(raw: string, base: string): boolean {
  try {
    if (new URL(raw).origin === new URL(base).origin) return true
  } catch {
    return false
  }
  return isAllowedDownloadUrl(raw)
}

/**
 * 拉取最新版本：latest.json 优先，不可用时回退网页方式。
 *
 * 所有用户都能零配置使用：清单是普通 Release 资产，不占 GitHub API 配额、
 * 不需要 token；旧版本发布还没有清单时，网页跳转仍能把更新功能撑起来。
 */
async function fetchLatestRelease(): Promise<{
  release: LatestRelease
  source: 'manifest' | 'web'
}> {
  const cfg = resolveUpdateRuntimeConfig()
  const deadline = Date.now() + CHECK_TIMEOUT_MS
  try {
    return { release: await fetchLatestReleaseViaManifest(cfg, deadline), source: 'manifest' }
  } catch (err) {
    if (!(err instanceof ManifestUnavailableError)) throw err
    try {
      return { release: await fetchLatestReleaseViaWeb(cfg, deadline), source: 'web' }
    } catch (fallbackErr) {
      // 两条路都失败时保留原始原因，并说明备用方式也试过了
      throw new Error(`${errorMessage(err)}；网页备用检查也失败：${errorMessage(fallbackErr)}`)
    }
  }
}

/**
 * 检查是否有更新。
 *
 * 结果缓存 60 秒（只缓存成功结果），失败原因原样返回给前端展示，
 * 不抛 HTTP 错误 —— 「连不上 GitHub」是外部状态，不是面板接口故障。
 */
export async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  const now = Date.now()
  if (!force && cached && now - cached.at < CACHE_TTL_MS) {
    return { ...cached.result, checkedAt: cached.at }
  }

  const platform = platformSuffix(process.platform, process.arch)
  const result: UpdateCheckResult = {
    current: {
      version: APP_VERSION,
      release: RELEASE_TAG,
      platform: platform ?? `${process.platform}-${process.arch}`,
      supported: isCompiledBinary(),
    },
    latest: null,
    hasUpdate: false,
    source: null,
    error: null,
    checkedAt: now,
  }

  // 开发模式 / 非单文件产物：不联网，直接告诉前端无法自更新
  if (!result.current.supported) {
    cached = { at: now, result, release: null }
    return result
  }
  if (!platform) {
    result.error = `当前平台（${process.platform}-${process.arch}）没有对应的发布包`
    cached = { at: now, result, release: null }
    return result
  }

  try {
    const { release, source } = await fetchLatestRelease()
    result.source = source
    result.latest = release.info
    const latest = parseReleaseTag(release.info.tag)
    if (latest) result.hasUpdate = isNewerRelease(latest, currentRelease())
    if (result.hasUpdate && !release.asset) {
      result.error = `最新版本 ${release.info.tag} 没有适用于 ${platform} 的安装包`
    }
    cached = { at: now, result, release: release.asset ? release : null }
  } catch (err) {
    result.error = errorMessage(err)
    // 失败结果不缓存：下次点击立刻重试
  }

  return result
}

/**
 * 开始更新：校验目标版本后立即返回，下载与替换在后台进行。
 *
 * 前端拿 202 之后轮询 GET /api/update/status 看进度；替换完成会触发重启，
 * 因此状态里不会出现「done」，最后一个可观察阶段是 restarting。
 */
export async function startUpdate(tag: string): Promise<{ tag: string }> {
  if (ACTIVE_PHASES.has(state.phase)) {
    throw new HttpError(409, 'UPDATE_BUSY', '已有更新任务在进行中，请等待它完成')
  }
  if (!isCompiledBinary()) {
    throw new HttpError(409, 'UPDATE_UNSUPPORTED', '开发模式或非单文件产物无法自更新，请更新源码后重启')
  }

  let check = cached
  if (!check || check.release?.info.tag !== tag) {
    await checkForUpdate(true)
    check = cached
  }
  if (!check || !check.release || check.release.info.tag !== tag) {
    throw new HttpError(
      409,
      'UPDATE_UNAVAILABLE',
      check?.result.error ?? '目标版本已不是最新发布，请重新检查更新',
    )
  }
  if (!check.result.hasUpdate) {
    throw new HttpError(409, 'UPDATE_UNAVAILABLE', '当前已是最新版本')
  }
  if (!check.release.asset) {
    throw new HttpError(409, 'UPDATE_UNAVAILABLE', '该版本没有适用于当前平台的安装包')
  }

  const asset = check.release.asset
  state = {
    phase: 'downloading',
    tag,
    received: 0,
    total: asset.archive.size,
    error: null,
    startedAt: Date.now(),
  }

  // 不 await：接口要尽快回包，进度走 status 轮询
  void runUpdate(tag, asset)
  return { tag }
}

/**
 * 下载完整性校验：清单里给了哪个字段就核哪个。
 *
 * 网页备用路径没有 digest（传 null），只靠大小 + 可执行文件头兜底。
 */
function verifyDownload(
  label: string,
  expectedSize: number | null,
  expectedDigest: string | null,
  actualSize: number,
  actualSha256: string,
): void {
  if (expectedSize !== null && actualSize !== expectedSize) {
    throw new Error(`${label}不完整：应为 ${expectedSize} 字节，实际 ${actualSize} 字节`)
  }
  if (expectedDigest && actualSha256.toLowerCase() !== expectedDigest.toLowerCase()) {
    throw new Error(`${label}校验失败（sha256 不匹配），已放弃替换`)
  }
}

/**
 * 打开安装包下载流，并核一次最终跳转地址是否可信。
 *
 * 镜像地址由部署者显式配置，跳转不做域名限制；直连路径必须落在 GitHub 域名内
 * （重定向可能落到别的域名）。
 */
async function openDownload(
  url: string,
  origin: string,
  mirror: string,
): Promise<{ res: Response; body: ReadableStream<Uint8Array> }> {
  let res: Response
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': `starm-panel/${APP_VERSION}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(`下载失败：${errorMessage(err)}`)
  }
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  if (!res.body) throw new Error('下载失败：响应为空')
  if (!mirror && !isTrustedAssetUrl(res.url || url, origin)) {
    throw new Error(UNTRUSTED_ASSET_MESSAGE)
  }
  return { res, body: res.body }
}

/**
 * 下载归档到内存，并校验归档自身的 size / sha256。
 *
 * 归档只有 25–35MB，整块读进内存后直接交给解包器（解出 60–84MB，峰值约 140MB）；
 * 更新是一次性操作，这点内存换掉「归档落盘再读回来」的一次写盘 + 读盘是划算的。
 */
async function downloadArchive(asset: DownloadAsset, mirror: string): Promise<Uint8Array> {
  setState({ phase: 'downloading', received: 0, total: asset.archive.size })
  const { res, body } = await openDownload(asset.archive.url, asset.origin, mirror)

  const contentLength = Number(res.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > 0) setState({ total: contentLength })

  const hasher = new Bun.CryptoHasher('sha256')
  const chunks: Uint8Array[] = []
  let received = 0
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    hasher.update(value)
    setState({ received })
  }

  setState({ phase: 'verifying' })
  verifyDownload('归档', asset.archive.size, asset.archive.digest, received, hasher.digest('hex'))
  return Buffer.concat(chunks)
}

/**
 * 解包并校验里面的可执行文件。
 *
 * 顺序：解包 → 文件名必须是清单里那个 → 解压后的 size / sha256（清单路径才有）。
 * 任何一步不对都在写盘之前停下来，目录里不会留下半成品。
 */
async function extractExecutable(asset: DownloadAsset, archiveBytes: Uint8Array): Promise<Uint8Array> {
  const file = await extractArchive(archiveBytes, asset.archive.kind)
  if (file.name !== asset.name) {
    throw new Error(`归档里的文件名不符：预期 ${asset.name}，实际 ${file.name}`)
  }
  verifyDownload(
    '可执行文件',
    asset.size,
    asset.digest,
    file.bytes.byteLength,
    new Bun.CryptoHasher('sha256').update(file.bytes).digest('hex'),
  )
  return file.bytes
}

async function runUpdate(tag: string, asset: DownloadAsset): Promise<void> {
  const target = process.execPath
  const dir = dirname(target)
  const ext = target.toLowerCase().endsWith('.exe') ? '.exe' : ''
  const tmp = join(dir, `.starm-panel-update-${Date.now()}${ext}`)
  const { update } = getConfig()

  try {
    const archiveBytes = await downloadArchive(asset, update.mirror)
    const executable = await extractExecutable(asset, archiveBytes)
    writeFileSync(tmp, executable)

    // 网页备用路径没有 digest，用文件头再确认一次「确实是当前平台的可执行程序」：
    // 至少挡住 HTML 错误页、代理返回的说明页或错误平台的包。
    assertExecutableFile(tmp)

    setState({ phase: 'installing' })
    installBinary(tmp, target)

    setState({ phase: 'restarting' })
    scheduleRestart()
  } catch (err) {
    // 临时文件一定要清掉：失败后目录里不该留下几十 MB 的半成品
    removeQuietly(tmp)
    setState({ phase: 'error', error: errorMessage(err) })
    console.error(`[update] 更新到 ${tag} 失败：`, err)
  }
}

/**
 * 检查下载文件的开头是否为当前平台的可执行格式。
 *
 * 纯文件读取；失败即抛错（由 runUpdate 统一清理临时文件并报错）。
 */
function assertExecutableFile(path: string): void {
  const fd = openSync(path, 'r')
  try {
    const head = new Uint8Array(4)
    const read = readSync(fd, head, 0, head.byteLength, 0)
    if (read < head.byteLength || !isPlatformExecutableHeader(head, process.platform)) {
      throw new Error('下载的文件不是当前平台的可执行程序（可能被代理或镜像替换），已放弃安装')
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * 用下载好的文件替换目标可执行文件（纯文件操作，便于单测）。
 *
 * 顺序：旧文件 → `<目标>.old`，临时文件 → 目标。第二条改名失败时回滚，
 * 保证不会出现「旧文件没了、新文件也没就位」的空窗。
 * 目标正在运行不影响改名（POSIX 与 Windows 都允许）。
 */
export function installBinary(tmpPath: string, targetPath: string): void {
  let mode = 0o755
  try {
    mode = statSync(targetPath).mode & 0o777
  } catch {
    // 目标不存在（极少见）时用默认权限
  }
  try {
    // Windows 上 chmod 只影响只读位，失败也无妨
    chmodSync(tmpPath, mode || 0o755)
  } catch {
    /* 忽略 */
  }

  const backup = `${targetPath}.old`
  // 上次更新可能留下 .old（Windows 上旧进程还没退干净时删不掉，下次启动再清）
  removeQuietly(backup)

  try {
    renameSync(targetPath, backup)
  } catch (err) {
    removeQuietly(tmpPath)
    throw new Error(
      `无法替换程序文件（${targetPath}）：${errorMessage(err)}。请检查运行用户对该目录的写权限。`,
    )
  }

  try {
    renameSync(tmpPath, targetPath)
  } catch (err) {
    // 回滚，避免面板目录里既没有原程序也没有新程序
    try {
      renameSync(backup, targetPath)
    } catch {
      /* 回滚也失败时只能把问题原样抛给用户 */
    }
    removeQuietly(tmpPath)
    throw new Error(`写入新版本失败：${errorMessage(err)}`)
  }
}

/**
 * 清理上次更新留下的临时文件与备份。
 *
 * 在监听端口成功之后调用（见 index.ts）：新版本能起来才说明它可用，
 * 此时删掉 `.old` 回滚点是安全的；起不来则 `.old` 还在，可手工恢复。
 * 开发模式不碰任何文件 —— 那里的 execPath 是 bun 本体。
 */
export function cleanupStaleUpdateFiles(): void {
  if (!isCompiledBinary()) return
  const target = process.execPath
  const dir = dirname(target)

  const backup = `${target}.old`
  if (existsSync(backup)) {
    try {
      unlinkSync(backup)
    } catch {
      // Windows 上旧进程可能还没退干净，留着下次启动再删
    }
  }

  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('.starm-panel-update-')) continue
      try {
        unlinkSync(join(dir, name))
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    // 目录不可读就算了，不影响面板运行
  }
}
