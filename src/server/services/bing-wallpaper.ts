/**
 * Bing 每日壁纸。
 *
 * 之前前端直接引用第三方服务 `https://bing.img.run/1920x1080.php`，该域名
 * 目前 DNS 已失效（CNAME 链无 A 记录），导致壁纸空白。第三方中转本身就不可
 * 控，这里改为由面板服务端调用 Bing **官方**接口：
 *
 *   1. GET https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=...
 *   2. 从返回的 images[0].url 拼出当天图片地址并下载
 *
 * 服务端代理还顺带解决两件事：
 *   - 浏览器所在网络访问不到 bing.com 时，只要面板能出网即可
 *   - 图片按天缓存，同一天内不会反复请求上游
 */
import { HttpError } from '../middleware/error'

const API_ORIGIN = 'https://www.bing.com'
const FETCH_TIMEOUT_MS = 8000
const MAX_BYTES = 12 * 1024 * 1024
const UA =
  'Mozilla/5.0 (compatible; StarM-Panel/0.1; +bing-wallpaper)'

export interface BingWallpaper {
  bytes: Uint8Array
  mime: string
  /** 当天日期（YYYYMMDD），用于缓存与调试 */
  date: string
  /** 版权说明，例如“查图加河，…（© …）” */
  copyright: string
  /** 图片原始地址 */
  source: string
}

interface ArchiveImage {
  startdate?: string
  url?: string
  urlbase?: string
  copyright?: string
}

interface ArchiveResponse {
  images?: ArchiveImage[]
}

interface CacheEntry {
  key: string
  value: BingWallpaper
  /** 缓存过期时间戳；过期后仍可作为上游失败时的兜底 */
  expiresAt: number
}

let cache: CacheEntry | null = null

function normalizeMkt(mkt?: string): string {
  const value = (mkt ?? 'zh-CN').trim()
  return /^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/.test(value) ? value : 'zh-CN'
}

async function fetchJson(url: string): Promise<ArchiveResponse> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new HttpError(502, 'BING_API_FAILED', `Bing 接口返回 ${res.status}`)
  }
  return (await res.json()) as ArchiveResponse
}

async function downloadImage(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'image/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new HttpError(502, 'BING_IMAGE_FAILED', `Bing 图片返回 ${res.status}`)
  }

  const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim()
  if (!mime.startsWith('image/')) {
    throw new HttpError(502, 'BING_IMAGE_FAILED', `Bing 返回了非图片类型：${mime}`)
  }

  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > MAX_BYTES) {
    throw new HttpError(502, 'BING_IMAGE_TOO_LARGE', 'Bing 图片超出体积上限')
  }

  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
    throw new HttpError(502, 'BING_IMAGE_TOO_LARGE', 'Bing 图片为空或超出体积上限')
  }
  return { bytes: buf, mime }
}

/**
 * 获取 Bing 每日壁纸（带当天缓存）。
 *
 * @param mkt 市场代码，如 zh-CN / en-US，非法值回退到 zh-CN
 */
export async function getBingWallpaper(mkt?: string): Promise<BingWallpaper> {
  const market = normalizeMkt(mkt)
  const key = `${market}:${new Date().toISOString().slice(0, 10)}`

  if (cache && cache.key === key && Date.now() < cache.expiresAt) {
    return cache.value
  }

  try {
    const api = new URL('/HPImageArchive.aspx', API_ORIGIN)
    api.searchParams.set('format', 'js')
    api.searchParams.set('idx', '0')
    api.searchParams.set('n', '1')
    api.searchParams.set('mkt', market)

    const archive = await fetchJson(api.toString())
    const image = archive.images?.[0]
    if (!image?.url) {
      throw new HttpError(502, 'BING_API_FAILED', 'Bing 接口未返回图片地址')
    }

    const source = new URL(image.url, API_ORIGIN).toString()
    const { bytes, mime } = await downloadImage(source)

    const value: BingWallpaper = {
      bytes,
      mime,
      date: image.startdate ?? key.slice(-10).replace(/-/g, ''),
      copyright: image.copyright ?? '',
      source,
    }

    // 6 小时后允许刷新；Bing 每天更新一次，这里给上游留出容错。
    cache = { key, value, expiresAt: Date.now() + 6 * 60 * 60 * 1000 }
    return value
  } catch (err) {
    // 上游失败时退回上一次缓存（即便已过期），总比壁纸空白强
    if (cache) return cache.value
    throw err
  }
}
