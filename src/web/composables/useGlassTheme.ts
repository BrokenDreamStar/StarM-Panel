/**
 * 全局玻璃主题 —— 「UI 风格」设置的运行时。
 *
 * 三种风格对应 main.css 的 html[data-glass]：
 *   solid   扁平化（实色底，--glass: none）
 *   frost   毛玻璃（奶光渐变 + 磨砂雾面 + 散射内晕）
 *   liquid  液态玻璃（白色/烟色半透明底 + 高斯模糊 + specular 边缘光），
 *           卡片与浮层（设置弹窗、二级菜单）同一套材质 —— 就是「白色液态玻璃」。
 *
 * 这里只做三件事：写 html[data-glass] 挂钩、按当前风格写卡片透明度 --card-a、
 * frost 时写模糊半径 --blur。色相由 main.css 的 --card-rgb / --card-hi-rgb
 * 按主题与风格给出，透明度按 ui.*Transparency（每种风格独立）换算成 alpha。
 *
 * 说明：位移折射（backdrop-filter: url(#svg)）在 Chromium 走逐像素软件光栅，
 * 成本与玻璃面积成正比、还会盖住任何底色，已不再用于全局样式。折射引擎仍保留
 * 在 composables/useLiquidGlass.ts，供需要「实时折射」的独立玻璃组件按需调用。
 */
import { onBeforeUnmount, watchEffect } from 'vue'
import { useSettingsStore } from '@/stores/settings'

export function useGlassTheme(): void {
  const settings = useSettingsStore()

  watchEffect(() => {
    const root = document.documentElement

    // html[data-glass]：main.css 的风格挂钩。液态玻璃现在对所有内核都成立
    // （白底 + 模糊 + 边缘光，不依赖 SVG 滤镜），不再需要按内核回落到 frost。
    root.dataset.glass = settings.glassStyle

    // 卡片透明度（按风格独立：ui.*Transparency，store 的 cardTransparency 已
    // 按当前风格取好对应值）：这里只算 alpha 写一个 inline 变量，色相留给
    // main.css 的 --card-rgb（随主题 + 风格切换）。
    //
    // alpha = (100 - 透明度) / 100 —— 0 就是完全不透明，没有「0 = 跟随默认」的
    // 哨兵值；默认值直接写在 DEFAULT_SETTINGS 里，滑杆全程线性。
    const rootStyle = document.documentElement.style
    const transparency = Math.min(100, Math.max(0, settings.cardTransparency))
    rootStyle.setProperty('--card-a', String((100 - transparency) / 100))

    // 模糊半径：frost / liquid 各自一份（solid 的 --glass 是 none，用不到）。
    // 非这两种风格时撤掉 inline，回落到 :root 的 12px 兜底。
    if (settings.glassStyle === 'frost' || settings.glassStyle === 'liquid') {
      const blur = Math.min(48, Math.max(0, settings.cardBlur))
      rootStyle.setProperty('--blur', `${blur}px`)
    } else {
      rootStyle.removeProperty('--blur')
    }
  })

  onBeforeUnmount(() => {
    const root = document.documentElement
    delete root.dataset.glass
    root.style.removeProperty('--card-a')
    root.style.removeProperty('--blur')
  })
}
