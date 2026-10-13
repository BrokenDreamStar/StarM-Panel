<script setup lang="ts">
/**
 * 卡片图标渲染 —— 统一处理四种 iconType，并保证离线可用。
 *
 *   iconify  → 本地矢量图标（内置表 / 名称哈希几何字形），绝不访问公网
 *   asset    → iconValue 里的图片地址（dataURL 或 /api/assets/xxx）
 *             ⚠️ 自建服务可能没有这个接口，加载失败时回落到文字/矢量字形
 *   text     → 1-2 个字符（含 emoji），背景/前景色来自 iconColor / bgColor
 *   favicon  → iconValue 里的图片地址（后端 /api/favicon 抓取结果），
 *             同样带失败回落到矢量字形
 */
import { computed, ref, watch } from 'vue'
import type { Item } from '@shared/types'
import FaviconGlyph from './FaviconGlyph.vue'

const props = withDefaults(
  defineProps<{
    item: Pick<Item, 'title' | 'iconType' | 'iconValue' | 'iconColor' | 'bgColor'>
    /** 图标尺寸（px） */
    size?: number
    /** 文字图标的字号比例 */
    textScale?: number
  }>(),
  { size: 28, textScale: 0.44 },
)

/** 图片加载失败（离线 / 资源未实现）时降级 */
const imageFailed = ref(false)

watch(
  () => [props.item.iconType, props.item.iconValue] as const,
  () => {
    imageFailed.value = false
  },
)

const isImageIcon = computed(
  () => props.item.iconType === 'asset' || props.item.iconType === 'favicon',
)

const imageSrc = computed(() => props.item.iconValue ?? '')

const showImage = computed(
  () => isImageIcon.value && imageSrc.value !== '' && !imageFailed.value,
)

/** 文字图标：取前两个字符（emoji 用 Array.from 按码点切分） */
const text = computed(() => {
  const chars = Array.from(props.item.title.trim())
  return chars.slice(0, 1).join('') || '?'
})

/** 图标名回退顺序：iconValue → 卡片标题（保证几何字形有意义） */
const glyphName = computed(() => props.item.iconValue || props.item.title)

const showText = computed(() => props.item.iconType === 'text')

const boxStyle = computed(() => {
  const style: Record<string, string> = {
    width: `${props.size}px`,
    height: `${props.size}px`,
    // 圆角随尺寸走（50px → 12px，与 sun-panel 图标一致）
    borderRadius: `${Math.max(6, Math.round(props.size * 0.24))}px`,
  }
  if (showText.value) {
    style.background = props.item.bgColor || 'color-mix(in srgb, var(--accent) 18%, transparent)'
    style.color = props.item.iconColor || 'var(--accent)'
    style.fontSize = `${Math.round(props.size * props.textScale)}px`
  } else {
    style.color = props.item.iconColor || 'var(--accent)'
  }
  return style
})
</script>

<template>
  <span class="item-icon" :style="boxStyle">
    <img
      v-if="showImage"
      :src="imageSrc"
      :alt="item.title"
      class="img"
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      @error="imageFailed = true"
    />
    <span v-else-if="showText" class="text">{{ text }}</span>
    <FaviconGlyph v-else :name="glyphName" :size="Math.round(size * 0.82)" />
  </span>
</template>

<style scoped>
.item-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border-radius: var(--r-sm);
  overflow: hidden;
  line-height: 1;
  user-select: none;
}

.img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.text {
  font-weight: 600;
  font-family: var(--mono);
}
</style>
