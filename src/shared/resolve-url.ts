/**
 * 内外网 URL 解析 —— 前后端共用的纯函数。
 *
 * 优先级：卡片级 network_pref  >  全局 mode  >  探测结果（仅 auto 时）
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
  if (ctx.mode === 'wan') {
    return choose(wanUrl, lanUrl, 'wan')
  }

  // ── 3. 全局 auto：用探测结果决定 ───────────────────────────
  // 探测未知（undefined）时保守选外网：外网地址通常在任何网络下都可达，
  // 而内网地址在外网环境下会直接连接失败。
  if (ctx.lanReachable === true) {
    return choose(lanUrl, wanUrl, 'lan')
  }
  return choose(wanUrl, lanUrl, 'wan')
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
