/**
 * Liquid Glass 引擎 —— 位移贴图生成 + 每元素 SVG 滤镜管理。
 *
 * 贴图按「圆角矩形 SDF 外法线 × 透镜衰减曲线」在 Canvas 上逐像素生成，
 * 经 feImage + feDisplacementMap 让浏览器实时折射真实背景（非快照，
 * 玻璃后面滚动的数据/动画折射始终正确）。贴图按 尺寸×圆角×depth×gamma
 * 缓存，scale/blur/色散等参数变化只重写滤镜链，不重算贴图。
 *
 * 兼容性：backdrop-filter 引用 SVG 滤镜目前只有 Chromium 支持。
 * 其他内核不做任何 JS 干预，调用方的 CSS var(--glass) 普通毛玻璃即为降级；
 * 刻意不让 Safari/Firefox 碰 url()（Safari 会解析成功但渲染成空，连降级一起丢）。
 */

export interface LiquidGlassOptions {
  /** 折射强度：feDisplacementMap 的 scale，边缘最大位移 = scale / 2 px */
  scale: number
  /** 边缘透镜带宽度（px） */
  depth: number
  /** 折射后的高斯模糊半径 */
  blur: number
  /** 饱和度增益：液态玻璃比背景略艳 */
  saturation: number
  /** RGB 三通道位移分离（边缘色散）；三份位移开销，大面积慎开 */
  chroma: boolean
  /** 透镜衰减指数：越大边缘折射越「薄而硬」，贴近 Apple 的做法 */
  gamma: number
}

export const liquidGlassSupported =
  typeof window !== 'undefined' &&
  !!(window as { chrome?: unknown }).chrome &&
  /Chrom/.test(navigator.userAgent)

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 全页共享一个 defs 容器；引用计数归零时摘除 */
let defs: SVGSVGElement | null = null
let liveHandles = 0
let seq = 0

function ensureDefs(): void {
  if (defs) return
  defs = document.createElementNS(SVG_NS, 'svg')
  defs.setAttribute('width', '0')
  defs.setAttribute('height', '0')
  defs.style.position = 'absolute'
  document.body.appendChild(defs)
}

/** 位移贴图缓存：同尺寸/圆角/参数的玻璃面（如一排同规格卡片）共用一张贴图，
 *  避免重复光栅与 PNG 编码 */
const mapCache = new Map<string, string>()

/** 贴图长边上限（px）：SDF 是平滑场，降采样后由 feImage 拉伸回元素尺寸，
 *  肉眼无差别，但 canvas 生成 / PNG 编码 / 纹理内存都明显下降 */
const MAP_MAX = 512

/** 位移贴图：R = x 偏移、G = y 偏移，128 为无偏移；SDF 梯度天然是单位外法线 */
function buildMap(w: number, h: number, radius: number, opts: LiquidGlassOptions): string {
  const cacheKey = `${w}x${h}x${radius}x${opts.depth}x${opts.gamma}`
  const cached = mapCache.get(cacheKey)
  if (cached) return cached
  // 等比降采样：q 同时作用于 w/h/radius/band，拉伸回元素尺寸后几何不变
  const q = Math.min(1, MAP_MAX / Math.max(w, h))
  const mw = Math.max(1, Math.round(w * q))
  const mh = Math.max(1, Math.round(h * q))
  const canvas = document.createElement('canvas')
  canvas.width = mw
  canvas.height = mh
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const img = ctx.createImageData(mw, mh)
  const data = img.data
  const R = Math.min(radius * q, mw / 2, mh / 2)
  const sdf = (x: number, y: number): number => {
    const qx = Math.abs(x - mw / 2) - (mw / 2 - R)
    const qy = Math.abs(y - mh / 2) - (mh / 2 - R)
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R
  }
  // 透镜带宽度与 demo 一致：折射只发生在玻璃棱边的一圈，带宽即圆角半径
  // （并受 depth 封顶）。若改按短边比例取，小卡片会整张都落在折带里、
  // 内部跟着一起弯，和 demo 的观感对不上。
  const band = Math.max(1, Math.min(opts.depth * q, R))
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const i = (y * mw + x) * 4
      const sd = sdf(x + 0.5, y + 0.5)
      if (sd >= -0.5) {
        data[i] = 128
        data[i + 1] = 128
        data[i + 2] = 0
        data[i + 3] = 255
        continue
      }
      const t = Math.min(1, -sd / band)
      const m = Math.pow(1 - t, opts.gamma)
      const nx = (sdf(x + 1.5, y + 0.5) - sdf(x - 0.5, y + 0.5)) / 2
      const ny = (sdf(x + 0.5, y + 1.5) - sdf(x + 0.5, y - 0.5)) / 2
      data[i] = Math.round(128 + nx * m * 127)
      data[i + 1] = Math.round(128 + ny * m * 127)
      data[i + 2] = 0
      data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const href = canvas.toDataURL()
  mapCache.set(cacheKey, href)
  return href
}

/**
 * 滤镜图元序列（不含 <filter> 外壳）。外壳元素由 attachLiquidGlass 创建并持有 id，
 * innerHTML 替换的就是这段内容 —— 千万不要再包一层 <filter>：嵌套 filter 里的
 * 图元会被整个忽略，滤镜变成空操作（位移静默失效，肉眼只能看到普通透底）。
 */
function filterMarkup(w: number, h: number, href: string, opts: LiquidGlassOptions): string {
  const map = `<feImage href="${href}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>`
  const displace = (s: number, res: string) =>
    `<feDisplacementMap in="SourceGraphic" in2="map" scale="${s}" xChannelSelector="R" yChannelSelector="G" result="${res}"/>`
  const chromaMatrix = (r: number, g: number, b: number) => `${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0`
  const chain = opts.chroma
    ? // 色散分离 ±14%，与 demo 一致（R/G/B 三通道位移量分别 0.86 / 1 / 1.14 倍）
      displace(opts.scale * 0.86, 'dR') +
      displace(opts.scale, 'dG') +
      displace(opts.scale * 1.14, 'dB') +
      `<feColorMatrix in="dR" type="matrix" values="${chromaMatrix(1, 0, 0)}" result="cR"/>` +
      `<feColorMatrix in="dG" type="matrix" values="${chromaMatrix(0, 1, 0)}" result="cG"/>` +
      `<feColorMatrix in="dB" type="matrix" values="${chromaMatrix(0, 0, 1)}" result="cB"/>` +
      '<feBlend in="cR" in2="cG" mode="screen" result="cRG"/>' +
      '<feBlend in="cRG" in2="cB" mode="screen" result="rgb"/>' +
      `<feGaussianBlur in="rgb" stdDeviation="${opts.blur}" result="soft"/>`
    : displace(opts.scale, 'displaced') +
      `<feGaussianBlur in="displaced" stdDeviation="${opts.blur}" result="soft"/>`
  // 链尾与 demo 相同：仅做饱和度增益，不再额外提亮（提亮会把玻璃洗成奶白，
  // 与 demo 的清透观感不一致）
  return map + chain + `<feColorMatrix in="soft" type="saturate" values="${opts.saturation}"/>`
}

export interface LiquidGlassHandle {
  /** 重新读取尺寸与参数，必要时重建贴图 / 滤镜 */
  refresh(): void
  /** 摘除滤镜并清理共享资源 */
  detach(): void
}

/**
 * 给单个元素挂上液态玻璃折射。getOptions 在每次 refresh 时调用，
 * 调用方用闭包把响应式参数桥接进来。不支持的内核返回空操作句柄。
 */
export function attachLiquidGlass(
  el: HTMLElement,
  getOptions: () => LiquidGlassOptions,
): LiquidGlassHandle {
  if (!liquidGlassSupported) return { refresh() {}, detach() {} }

  const filterId = `liquid-glass-${++seq}`
  let filter: SVGFilterElement | null = null
  let mapHref = ''
  let mapKey = ''
  let observer: ResizeObserver | null = null
  let detached = false

  function refresh(): void {
    if (detached) return
    // 用 offsetWidth/Height 而不是 getBoundingClientRect：后者会把
    // transform 一起算进去，而弹窗进出场用的正是 scale() 动画 ——
    // 贴着动画首帧量到的尺寸（如 scale(.5)）会生成一张错误的位移贴图，
    // 且 transform 变化不触发 ResizeObserver，错就一直错到底。
    const w = Math.round(el.offsetWidth)
    const h = Math.round(el.offsetHeight)
    if (w < 2 || h < 2) return
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
    const opts = getOptions()
    ensureDefs()
    if (!filter) {
      filter = document.createElementNS(SVG_NS, 'filter')
      filter.setAttribute('id', filterId)
      defs!.appendChild(filter)
    }
    // 滤镜区域必须盖住位移的取样范围：边缘像素会采到元素外最多
    // scale/2（色散 0.53×scale）的背景，区域不够时采到的是钳位像素、
    // 边缘拉出涂抹感。demo 固定 -25%/150% 是因为它的卡 240px 高而
    // 位移只有 36px；小卡片余量远不够，必须按 scale 自适应
    const margin = (opts.chroma ? opts.scale * 0.57 : opts.scale * 0.5) + 2
    const mx = Math.ceil((margin / w) * 100)
    const my = Math.ceil((margin / h) * 100)
    filter.setAttribute('x', `-${mx}%`)
    filter.setAttribute('y', `-${my}%`)
    filter.setAttribute('width', `${100 + mx * 2}%`)
    filter.setAttribute('height', `${100 + my * 2}%`)
    filter.setAttribute('color-interpolation-filters', 'sRGB')
    const key = `${w}x${h}x${radius}x${opts.depth}x${opts.gamma}`
    if (key !== mapKey) {
      mapKey = key
      mapHref = buildMap(w, h, radius, opts)
    }
    filter.innerHTML = filterMarkup(w, h, mapHref, opts)
    el.style.backdropFilter = `url(#${filterId})`
  }

  observer = new ResizeObserver(() => refresh())
  observer.observe(el)
  // RO 回调只在渲染帧派发 —— 页面处于后台/隐藏时初次回调永远不来，
  // 滤镜会整个缺席；attach 时先同步挂一次，后续尺寸变化仍由 RO 跟进。
  refresh()
  liveHandles++

  return {
    refresh,
    detach() {
      detached = true
      observer?.disconnect()
      observer = null
      filter?.remove()
      filter = null
      el.style.backdropFilter = ''
      liveHandles--
      if (liveHandles <= 0 && defs) {
        defs.remove()
        defs = null
        liveHandles = 0
      }
    },
  }
}
