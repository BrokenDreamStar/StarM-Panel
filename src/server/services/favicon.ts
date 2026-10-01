/**
 * favicon 抓取与缓存。
 *
 * 与内网探测的白名单策略不同：探测只允许私有网段，而 favicon 抓取的
 * 目标通常是**公网**站点（卡片的外网地址）。因此这里用的是另一套限制：
 *   - 允许公网与内网（用户可能给内网设备配图标）
 *   - **拒绝链路本地地址**（169.254.0.0/16 等云元数据端点，SSRF 的经典目标）
 *   - 5 秒超时、512KB 上限、仅接受图片类型
 *
 * 残留风险：先解析域名后由 fetch 再解析一次，两者之间存在 DNS rebinding
 * 的时间窗。对单用户自托管面板这个风险可接受，但若面板暴露在公网需注意。
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { assets } from '../db/schema'
import { HttpError } from '../middleware/error'
import { storeAsset } from './assets'
import type { Asset } from '@shared/types'

const FETCH_TIMEOUT_MS = 5000
const MAX_BYTES = 512 * 1024
const UA = 'Mozilla/5.0 (compatible; StarM-Panel/0.1; +favicon-fetcher)'

/** 云元数据 / 链路本地地址 —— SSRF 的经典目标，一律拒绝 */
function isLinkLocal(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number]
    return a === 169 && b === 254
  }
  if (v === 6) {
    const lower = ip.toLowerCase()
    if (/^fe[89ab]/.test(lower)) return true
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isLinkLocal(mapped[1]!)
  }
  return false
}

async function assertFetchable(target: URL): Promise<void> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new HttpError(400, 'BAD_SCHEME', '只支持 http/https 地址')
  }
  const host = target.hostname.replace(/^\[|\]$/g, '')
  if (host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw new HttpError(400, 'BLOCKED_HOST', '该主机名不被允许')
  }
  if (isIP(host)) {
    if (isLinkLocal(host)) {
      throw new HttpError(400, 'BLOCKED_HOST', '链路本地地址不被允许')
    }
    return
  }
  try {
    const { address } = await lookup(host)
    if (isLinkLocal(address)) {
      throw new HttpError(400, 'BLOCKED_HOST', '链路本地地址不被允许')
    }
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(400, 'DNS_FAILED', `无法解析主机名：${host}`)
  }
}

async function fetchWithLimit(url: string): Promise<Response> {
  return fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,image/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  })
}

/** 从 HTML 中提取候选图标地址，按优先级排序 */
function extractIconUrls(html: string, base: URL): string[] {
  const out: Array<{ href: string; score: number }> = []
  const linkRe = /<link\b[^>]*>/gi

  for (const tag of html.match(linkRe) ?? []) {
    const rel = tag.match(/\brel\s*=\s*["']?([^"'>]+)/i)?.[1]?.toLowerCase() ?? ''
    if (!rel.includes('icon')) continue

    const href = tag.match(/\bhref\s*=\s*["']?([^"'>\s]+)/i)?.[1]
    if (!href) continue

    // 优先 apple-touch-icon（通常分辨率更高），其次 shortcut icon，最后普通 icon
    let score = 1
    if (rel.includes('apple-touch')) score = 3
    else if (rel.includes('shortcut')) score = 2

    try {
      out.push({ href: new URL(href, base).toString(), score })
    } catch {
      /* 忽略非法 href */
    }
  }

  return out.sort((a, b) => b.score - a.score).map((x) => x.href)
}

/**
 * 抓取指定站点的 favicon 并存入 assets 表。
 * 命中缓存（同一 host 已抓过）时直接返回，不重复请求。
 */
export async function fetchFavicon(rawUrl: string): Promise<Asset> {
  let pageUrl: URL
  try {
    pageUrl = new URL(rawUrl)
  } catch {
    throw new HttpError(400, 'BAD_URL', '不是合法的地址')
  }

  await assertFetchable(pageUrl)

  // 先在已存的 favicon 里按 host 找缓存（name 字段记录了来源 host）
  const cached = db
    .select()
    .from(assets)
    .where(eq(assets.kind, 'favicon'))
    .all()
    .find((a) => a.name === pageUrl.host)

  if (cached) {
    return {
      id: cached.id,
      kind: 'favicon',
      name: cached.name,
      mime: cached.mime,
      size: cached.size,
      createdAt: cached.createdAt,
    }
  }

  const candidates: string[] = []

  // 1. 解析页面里的 <link rel="icon">
  try {
    const res = await fetchWithLimit(pageUrl.toString())
    if (res.ok) {
      const type = res.headers.get('content-type') ?? ''
      if (type.includes('text/html')) {
        const html = (await res.text()).slice(0, 512 * 1024)
        candidates.push(...extractIconUrls(html, pageUrl))
      }
    }
  } catch {
    /* 页面抓不到就直接试 /favicon.ico */
  }

  // 2. 兜底
  candidates.push(new URL('/favicon.ico', pageUrl).toString())

  for (const candidate of candidates) {
    try {
      const target = new URL(candidate)
      await assertFetchable(target)

      const res = await fetchWithLimit(candidate)
      if (!res.ok) continue

      const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
      if (!mime.startsWith('image/')) continue

      const buf = await res.arrayBuffer()
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) continue

      // 以 host 作为 name，便于上面的缓存查找
      return storeAsset(new Uint8Array(buf), 'favicon', pageUrl.host, mime)
    } catch {
      /* 试下一个候选 */
    }
  }

  throw new HttpError(
    404,
    'FAVICON_NOT_FOUND',
    `未能从 ${pageUrl.host} 抓取到 favicon，请手动上传图标`,
  )
}
