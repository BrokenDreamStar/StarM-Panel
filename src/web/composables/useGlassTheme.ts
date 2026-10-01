/**
 * 全局玻璃主题 —— 「UI 风格」设置的运行时。
 *
 * 液态玻璃模式下，把页面上所有卡片（[data-glass-card] 与 .card）从
 * var(--glass) 毛玻璃切到 SVG 位移折射，并按设置覆盖卡片底色透明度；
 * 切回毛玻璃时全部还原。卡片是 v-for 动态渲染的，用 MutationObserver
 * 跟进新增/移除，元素离页即释放对应滤镜。
 *
 * 位移折射是逐像素成本，卡片多时开销集中在滚动/动画帧 —— 参数（折射强度、
 * 色散）来自设置，但透镜带宽度等固定值保持克制，别在这里加花样。
 */
import { onBeforeUnmount, watch, watchEffect } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import {
  attachLiquidGlass,
  liquidGlassSupported,
  type LiquidGlassHandle,
} from './useLiquidGlass'

const CARD_SELECTOR = '[data-glass-card], .card'

export function useGlassTheme(): void {
  const settings = useSettingsStore()

  const handles = new Map<HTMLElement, LiquidGlassHandle>()
  let observer: MutationObserver | null = null

  function options() {
    return {
      scale: settings.glassScale,
      depth: 28,
      blur: 4,
      saturation: 1.15,
      chroma: settings.glassChroma,
      gamma: 1.6,
    }
  }

  function activate(el: HTMLElement): void {
    if (handles.has(el)) return
    handles.set(el, attachLiquidGlass(el, options))
  }

  function scan(root: ParentNode): void {
    if (root instanceof HTMLElement && root.matches(CARD_SELECTOR)) activate(root)
    root.querySelectorAll?.(CARD_SELECTOR).forEach((el) => activate(el as HTMLElement))
  }

  /** 元素随 v-for / 路由切换离页后，释放对应的滤镜与贴图缓存 */
  function sweepDetached(): void {
    for (const [el, handle] of handles) {
      if (!el.isConnected) {
        handle.detach()
        handles.delete(el)
      }
    }
  }

  function enable(): void {
    scan(document)
    observer = new MutationObserver((mutations) => {
      let structural = false
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n instanceof HTMLElement) {
            scan(n)
            structural = true
          }
        })
        if (m.removedNodes.length > 0) structural = true
      }
      if (structural) sweepDetached()
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  function disable(): void {
    observer?.disconnect()
    observer = null
    handles.forEach((handle) => handle.detach())
    handles.clear()
    // attach/detach 已负责清 inline 样式，这里兜底扫一遍防残留
    document
      .querySelectorAll<HTMLElement>(CARD_SELECTOR)
      .forEach((el) => el.style.removeProperty('backdrop-filter'))
  }

  watchEffect(() => {
    const liquid = settings.glassStyle === 'liquid' && liquidGlassSupported
    if (liquid) enable()
    else disable()

    // 底色不透明度覆盖：0（默认）= 跟随主题的 --card-bg
    const rootStyle = document.documentElement.style
    const opacity = settings.glassOpacity
    if (liquid && opacity > 0) {
      rootStyle.setProperty('--card-bg', `rgba(255, 255, 255, ${opacity / 100})`)
      rootStyle.setProperty('--card-bg-hi', `rgba(255, 255, 255, ${Math.min(1, opacity / 100 + 0.06)})`)
    } else {
      rootStyle.removeProperty('--card-bg')
      rootStyle.removeProperty('--card-bg-hi')
    }
  })

  // 折射参数变化只需重写滤镜链（贴图未变则直接复用缓存）
  watch([() => settings.glassScale, () => settings.glassChroma], () => {
    handles.forEach((handle) => handle.refresh())
  })

  onBeforeUnmount(() => disable())
}
