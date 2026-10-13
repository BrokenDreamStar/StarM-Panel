<script setup lang="ts">
/**
 * 分区标题右侧的「编辑」开关。
 *
 * 平时完全隐藏（只有悬停标题行、键盘聚焦或已进入编辑时才浮现），
 * 点击切换编辑模式；进入编辑模式后卡片才显示移除角标等管理操作。
 * 触屏没有 hover，`hover: none` 下常显，避免无法进入编辑模式。
 */
import FaviconGlyph from './FaviconGlyph.vue'

defineProps<{ active: boolean }>()

const emit = defineEmits<{ (e: 'toggle'): void }>()
</script>

<template>
  <button
    class="section-edit"
    type="button"
    :class="{ active }"
    :title="active ? '完成编辑' : '编辑卡片'"
    :aria-label="active ? '完成编辑' : '编辑卡片'"
    :aria-pressed="active"
    @click="emit('toggle')"
  >
    <FaviconGlyph :name="active ? 'check' : 'pencil'" :size="13" />
  </button>
</template>

<style scoped>
.section-edit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--wp-text-2);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.14s ease, background 0.14s ease, color 0.14s ease;
}

/*
 * 显示条件里必须包含 .section-edit:hover：
 * 只靠祖先 .section-head:hover 时，指针一旦落在按钮自身，浏览器在
 * pointer-events 翻转的瞬间会抖动祖先的 :hover，使 opacity 过渡反复重启动，
 * 图标看起来“指向就消失”。按钮始终可命中，指向它本身即可保持显示。
 */
:where(.section-head:hover) .section-edit,
.section-head:focus-within .section-edit,
.section-edit:hover,
.section-edit:focus-visible,
.section-edit.active {
  opacity: 1;
}

.section-edit:hover,
.section-edit:focus-visible,
.section-edit.active {
  /* 标题行直接坐在壁纸上，必须用壁纸文字色而不是卡片文字色：
     浅色主题 + 深色壁纸时 var(--text) 是近黑色，图标一悬停就“消失”。 */
  color: var(--wp-text);
  background: color-mix(in srgb, var(--wp-text) 14%, transparent);
}

@media (hover: none) {
  .section-edit {
    opacity: 1;
  }
}
</style>
