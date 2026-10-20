/**
 * 卡片尺寸的「生效档位」。
 *
 * 设置里的 `ui.cardSize` 是桌面密度的选择（桌面一行排三四个都放得下）。
 * 手机上（≤640px）一行至少排两张卡片，单张只剩 ~140–200px：中 / 大档的
 * 50 / 56px 图标加上左右留白，会把标题挤到只剩几十像素；硬件卡片的
 * 「标签 + 数值」横排也会被截断。
 *
 * 所以手机上一律降到紧凑档 —— 卡片组件自己的 `size-sm` 分支本来就是为窄列
 * 设计的（36px 图标、标签与数值上下堆叠；桌面上它还隐藏副标题，手机上因为卡片
 * 高度由 3:1 比例撑开，副标题单独放行，见 ItemCard.vue）。断点与各组件样式里的
 * ≤640px 媒体查询保持一致（见 GroupSection / SystemStatusSection / HomeView）。
 */
import { computed, ref, type ComputedRef } from 'vue'
import { useSettingsStore } from '@/stores/settings'

export type CardSize = 'sm' | 'md' | 'lg'

/** 与各组件样式里的移动端断点一致 */
const MOBILE_QUERY = '(max-width: 640px)'

/**
 * 媒体查询只订阅一次，两个卡片区（App 卡片 / 系统状态）共用一份。
 * 惰性初始化：模块被引入时还不一定有 window（测试环境），用的时候再订阅。
 */
const isMobile = ref(false)
let subscribed = false

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  const mql = window.matchMedia(MOBILE_QUERY)
  isMobile.value = mql.matches
  mql.addEventListener('change', (event) => {
    isMobile.value = event.matches
  })
}

/** 生效的卡片尺寸：手机上是 `sm`，其余按用户设置 */
export function useCardSize(): ComputedRef<CardSize> {
  subscribe()
  const settings = useSettingsStore()
  return computed<CardSize>(() => (isMobile.value ? 'sm' : settings.cardSize))
}
