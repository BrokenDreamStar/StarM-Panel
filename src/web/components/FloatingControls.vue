<script setup lang="ts">
/**
 * 右上角浮动控制组 —— 顶部常驻大工具栏的替代品。
 *
 * 一颗白玻璃胶囊：无边框，默认 68% 不透明度，hover / 键盘聚焦时才完全明显，
 * 视觉上不抢英雄区的注意力。内部分组之间用留白隔开，不再画竖线。
 *
 * 收纳：搜索（点击展开输入框）、内外网切换（复用 NetworkSwitch）、主题切换、设置。
 * 搜索框焦点由父组件的 `/` 快捷键通过 defineExpose 的 openSearch 触发。
 */
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NInput } from 'naive-ui'
import { useNetworkStore } from '@/stores/network'
import FaviconGlyph from './FaviconGlyph.vue'
import NetworkSwitch from './NetworkSwitch.vue'
import ThemeSwitch from './ThemeSwitch.vue'

const props = defineProps<{ query: string }>()
const emit = defineEmits<{ (e: 'update:query', value: string): void }>()

const router = useRouter()
const network = useNetworkStore()

const searchOpen = ref(false)
const searchInput = ref<InstanceType<typeof NInput> | null>(null)

async function openSearch(): Promise<void> {
  searchOpen.value = true
  await nextTick()
  searchInput.value?.focus()
}

function closeSearch(): void {
  searchOpen.value = false
}

/** 失焦时只在没有输入内容的情况下收起，避免把用户刚打的字藏起来 */
function onSearchBlur(): void {
  if (props.query.trim() === '') searchOpen.value = false
}

function onQuery(value: string): void {
  emit('update:query', value)
}

const netTitle = computed(() => {
  switch (network.mode) {
    case 'lan':
      return '内网优先'
    case 'wan':
      return '外网优先'
    default:
      return '自动探测'
  }
})

defineExpose({ openSearch })
</script>

<template>
  <div class="float-controls">
    <div class="group">
      <NInput
        v-if="searchOpen"
        ref="searchInput"
        class="search-input"
        size="small"
        :value="query"
        clearable
        placeholder="搜索卡片…"
        @update:value="onQuery"
        @blur="onSearchBlur"
        @keydown.esc="closeSearch"
      >
        <template #prefix>
          <FaviconGlyph name="search" :size="13" class="dim" />
        </template>
      </NInput>
      <button
        v-else
        class="ctl"
        type="button"
        title="搜索卡片（按 / 聚焦）"
        aria-label="搜索卡片"
        @click="openSearch"
      >
        <FaviconGlyph name="search" :size="16" />
      </button>

      <span class="gap" aria-hidden="true" />

      <NetworkSwitch />

      <span class="gap" aria-hidden="true" />

      <ThemeSwitch />

      <button
        class="ctl"
        type="button"
        :title="`设置（网络模式：${netTitle}）`"
        aria-label="打开设置"
        @click="router.push('/settings')"
      >
        <FaviconGlyph name="cog" :size="16" />
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
  -webkit-backdrop-filter: var(--glass);
  box-shadow: var(--shadow-2);
  opacity: 0.68;
  transition: opacity 0.18s ease, background 0.18s ease;
}

.group:hover,
.group:focus-within {
  opacity: 1;
  background: var(--card-bg-hi);
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

.ctl:hover {
  background: var(--hover);
  color: var(--text);
}

/* 分组之间只留白，不画竖线 */
.gap {
  width: 8px;
  flex: none;
}

.search-input {
  width: 200px;
}

@media (max-width: 860px) {
  .float-controls {
    top: 12px;
    right: 12px;
  }

  .search-input {
    width: 132px;
  }
}
</style>
