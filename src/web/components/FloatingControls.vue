<script setup lang="ts">
/**
 * 右上角浮动控制组 —— 三个等高控件：内外网切换、主题切换、设置。
 *
 * 一颗白玻璃胶囊：无边框、整体不做透明度与 hover 变化，材质始终与其它卡片一致。
 * hover 反馈只发生在三个按钮自身（图标按钮抬亮、主题开关转动太阳/月亮）。
 * 内部分组之间用留白隔开，不再画竖线。
 *
 * 两侧图标按钮默认透明，只在 hover / 键盘聚焦 / 按下时才浮出一层底色；
 * 这样静止时三颗控件都只有图标（开关是它自己的天空胶囊），反馈统一发生在交互时。
 *
 * 内外网切换是单颗图标按钮：图标显示当前模式（home=内网 / globe=外网），
 * 点击二态切换；开启「自动选择」时按钮按落地结果显示图标，点击则接管为手动。
 */
import { computed } from 'vue'
import { useNetworkStore } from '@/stores/network'
import FaviconGlyph from './FaviconGlyph.vue'
import ThemeSwitch from './ThemeSwitch.vue'

const emit = defineEmits<{ (e: 'open-settings'): void }>()

const network = useNetworkStore()

const netIcon = computed(() => (network.effectiveMode === 'lan' ? 'home' : 'globe'))

const netTitle = computed(() => {
  const lan = network.effectiveMode === 'lan'
  if (network.autoMode) {
    return `网络模式：自动（当前按${lan ? '内网' : '外网'}解析，点击改为手动切换）`
  }
  return lan ? '网络模式：内网（点击切换到外网）' : '网络模式：外网（点击切换到内网）'
})

const netLabel = computed(() =>
  network.effectiveMode === 'lan'
    ? '网络模式：内网，点击切换到外网'
    : '网络模式：外网，点击切换到内网',
)
</script>

<template>
  <div class="float-controls">
    <div class="group">
      <button
        class="ctl"
        type="button"
        :title="netTitle"
        :aria-label="netLabel"
        @click="network.toggleMode()"
      >
        <FaviconGlyph :name="netIcon" :size="18" />
      </button>

      <span class="gap" aria-hidden="true" />

      <ThemeSwitch />

      <span class="gap" aria-hidden="true" />

      <button
        class="ctl"
        type="button"
        title="设置"
        aria-label="打开设置"
        @click="emit('open-settings')"
      >
        <FaviconGlyph name="cog" :size="18" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.float-controls {
  position: fixed;
  top: 18px;
  right: 22px;
  z-index: 40;
}

.group {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 5px;
  border: 0;
  border-radius: var(--r-md);
  background: var(--card-bg);
  backdrop-filter: var(--glass);
  box-shadow: var(--shadow-2);
}

.ctl {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  font: inherit;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

/* hover / 键盘聚焦 / 按下时才显示底色，静止时完全透明 */
.ctl:hover,
.ctl:focus-visible {
  background: var(--field-hi);
  color: var(--text);
}

.ctl:active {
  background: var(--field);
}

/* 分组之间只留白，不画竖线 */
.gap {
  width: 8px;
  flex: none;
}

@media (max-width: 860px) {
  .float-controls {
    top: 12px;
    right: 12px;
  }
}
</style>
