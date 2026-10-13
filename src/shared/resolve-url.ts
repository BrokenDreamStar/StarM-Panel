/**
 * 内外网 URL 解析 —— 前后端共用的纯函数。
 *
 * 优先级：卡片级 network_pref  >  全局 mode
 * 全局 mode 只接收已落地的 'lan' | 'wan'：'auto' 由调用方按访问方式
 * （isLanHost）先解析成具体模式再传入。
 *
 * 设计约束：
 *   - 无副作用、无 IO、不依赖任何运行时 API
 *   - 永远返回「最佳可用 URL」：只有两个地址都为空时才返回 null
 *   - 每次模式切换会对全部卡片调用一次，必须保持 O(1)
 */
import type {
  Item,
  ResolveContext,
  ResolvedUrl,
  ResolveSource,
} from './types'

/** 构造解析结果的小工具 */
function pick(
  url: string | null,
  source: ResolveSource,
): ResolvedUrl {
  return url ? { url, source } : { url: null, source: 'none' }
}

/**
 * 在「首选地址」与「备选地址」之间做选择，并在首选不可用时标记为 fallback。
 */
function choose(
  preferred: string | null,
  fallback: string | null,
  preferredSource: ResolveSource,
): ResolvedUrl {
  if (preferred) return pick(preferred, preferredSource)
  if (fallback) return pick(fallback, 'fallback')
  return { url: null, source: 'none' }
}

export function resolveUrl(item: Item, ctx: ResolveContext): ResolvedUrl {
  const { lanUrl, wanUrl, networkPref } = item

  // ── 1. 卡片级强制 ──────────────────────────────────────────
  if (networkPref === 'lan') {
    return choose(lanUrl, wanUrl, 'lan')
  }
  if (networkPref === 'wan') {
    return choose(wanUrl, lanUrl, 'wan')
  }

  // ── 2. 全局模式 ────────────────────────────────────────────
  if (ctx.mode === 'lan') {
    return choose(lanUrl, wanUrl, 'lan')
  }
  return choose(wanUrl, lanUrl, 'wan')
}

/**
 * 判断主机名是否属于内网访问 —— auto 模式的落地依据：
 * 用 IP（或本机 localhost）访问面板视为内网，用域名访问视为外网。
 *
 * 规则：
 *   - localhost / *.localhost → 内网
 *   - IPv4 字面量（任意）→ 内网
 *   - IPv6 字面量（含 `::1` / `::`）→ 内网
 *   - 其余（域名、无法识别的主机名）→ 外网
 */
export function isLanHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  // 无法识别（空主机名等）→ 保守按外网，与原 auto 的降级方向一致
  if (host === '') return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number)
    return octets.every((n) => n <= 255)
  }

  // 域名不可能含冒号，含冒号即为 IPv6 字面量
  return host.includes(':')
}

/**
 * 源标记的可读文案，供卡片角标使用。
 */
export function describeSource(source: ResolveSource): string {
  switch (source) {
    case 'lan':
      return '内网'
    case 'wan':
      return '外网'
    case 'fallback':
      return '回退'
    case 'none':
      return '未配置'
  }
}
