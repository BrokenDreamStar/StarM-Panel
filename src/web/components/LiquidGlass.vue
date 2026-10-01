<script setup lang="ts">
/**
 * Liquid Glass 玻璃容器 —— SVG 位移滤镜实现的「液态玻璃」边缘折射。
 *
 * 折射/贴图/兼容性逻辑都在 composables/useLiquidGlass.ts，本组件只是
 * 「自带圆角与 rim light 的玻璃壳」：定位、尺寸交给外部 class。
 *
 * 兼容性：仅 Chromium 有折射；其他内核自然回落到下方 CSS var(--glass) 毛玻璃。
 *
 * 用法：圆角默认 var(--r-md)，可用 `--lg-radius` 覆盖（胶囊/圆形也能正确成镜）；
 * 底色默认 var(--card-bg)，可用 `--lg-tint` 覆盖。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { attachLiquidGlass, type LiquidGlassHandle } from '@/composables/useLiquidGlass'

interface Props {
  /** 折射强度：feDisplacementMap 的 scale，边缘最大位移 = scale / 2 px */
  scale?: number
  /** 边缘透镜带宽度（px） */
  depth?: number
  /** 折射后的高斯模糊半径 */
  blur?: number
  /** 饱和度增益：液态玻璃比背景略艳 */
  saturation?: number
  /** RGB 三通道位移分离（边缘色散） */
  chroma?: boolean
  /** 透镜衰减指数：越大边缘折射越「薄而硬」，贴近 Apple 的做法 */
  gamma?: number
}

const props = withDefaults(defineProps<Props>(), {
  scale: 64,
  depth: 28,
  blur: 4,
  saturation: 1.15,
  chroma: true,
  gamma: 1.6,
})

const root = ref<HTMLElement | null>(null)
let handle: LiquidGlassHandle | null = null

onMounted(() => {
  if (!root.value) return
  handle = attachLiquidGlass(root.value, () => ({
    scale: props.scale,
    depth: props.depth,
    blur: props.blur,
    saturation: props.saturation,
    chroma: props.chroma,
    gamma: props.gamma,
  }))
})

watch(
  () => [props.scale, props.depth, props.blur, props.saturation, props.chroma, props.gamma],
  () => handle?.refresh(),
)

onBeforeUnmount(() => {
  handle?.detach()
  handle = null
})
</script>

<template>
  <div ref="root" class="liquid-glass">
    <slot />
  </div>
</template>

<style scoped>
.liquid-glass {
  position: relative;
  border-radius: var(--lg-radius, var(--r-md));
  background: var(--lg-tint, var(--card-bg));
  box-shadow: var(--shadow-2);
  /* 非 Chromium 的降级路径：SVG 滤镜仅在 Chromium 下经 JS 启用 */
  backdrop-filter: var(--glass);
  -webkit-backdrop-filter: var(--glass);
}

/* 边缘高光：液态玻璃的 rim light，纯 CSS、不走滤镜 */
.liquid-glass::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  box-shadow:
    inset 1.2px 1.2px 1px -1px rgba(255, 255, 255, 0.5),
    inset -1px -1px 1px -1px rgba(255, 255, 255, 0.26),
    inset 0 0 14px rgba(255, 255, 255, 0.05);
}
</style>
