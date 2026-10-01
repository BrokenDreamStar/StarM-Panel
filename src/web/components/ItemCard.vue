<script setup lang="ts">
/**
 * 桌面卡片。
 *
 * 视觉层次：图标 → 标题/副标题 → 底部状态角标（来源 + 锁定偏好）。
 * 交互：左键按全局「打开方式」（ui.openMode）打开；右键或悬停「⋯」打开菜单
 * （编辑 / 复制链接 / 新窗口 / 删除）。
 */
import { computed, ref } from 'vue'
import { NDropdown, NTooltip } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import { useNetworkStore } from '@/stores/network'
import { useSettingsStore } from '@/stores/settings'
import { useItemActions } from '@/composables/useItemActions'
import type { Item } from '@shared/types'
import ItemIcon from './ItemIcon.vue'
import FaviconGlyph from './FaviconGlyph.vue'

const props = withDefaults(
  defineProps<{
    item: Item
    /** 与 ui.cardSize 设置对应 */
    size?: 'sm' | 'md' | 'lg'
    /** 拖拽中（降低不透明度） */
    dragging?: boolean
  }>(),
  { size: 'md' },
)

const emit = defineEmits<{
  (e: 'edit', item: Item): void
  (e: 'delete', item: Item): void
}>()

const network = useNetworkStore()
const settings = useSettingsStore()
const actions = useItemActions()

const resolved = computed(() => network.resolve(props.item))
const sourceLabel = computed(() => network.resolveSourceLabel(resolved.value.source))
const offMode = computed(() => network.isOffMode(props.item, resolved.value))
const locked = computed(() => props.item.networkPref !== 'auto')
const unavailable = computed(() => resolved.value.url === null)

const openModeLabel = computed(() =>
  settings.openMode === 'self' ? '当前窗口打开' : '新窗口打开',
)

/** 地址的主机部分，用于 tooltip 里显示「实际会打开什么」 */
const host = computed(() => {
  const url = resolved.value.url
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
})

const iconSize = computed(() => (props.size === 'sm' ? 22 : props.size === 'lg' ? 36 : 28))

const menuOptions: DropdownOption[] = [
  { label: '编辑', key: 'edit' },
  { label: '复制链接', key: 'copy' },
  { label: '在新窗口打开', key: 'open-new' },
  { type: 'divider', key: 'd1' },
  { label: '删除', key: 'delete' },
]

const menuVisible = ref(false)
const menuX = ref(0)
const menuY = ref(0)

function showMenu(event: MouseEvent): void {
  event.preventDefault()
  menuVisible.value = false
  menuX.value = event.clientX
  menuY.value = event.clientY
  // 下一帧再显示：Naive UI 依赖 x/y 的即时值计算定位
  requestAnimationFrame(() => {
    menuVisible.value = true
  })
}

function onClickOutside(): void {
  menuVisible.value = false
}

async function onSelect(key: string): Promise<void> {
  menuVisible.value = false
  switch (key) {
    case 'edit':
      emit('edit', props.item)
      break
    case 'copy':
      await actions.copyLink(props.item)
      break
    case 'open-new': {
      const url = resolved.value.url
      if (url) window.open(url, '_blank', 'noopener,noreferrer')
      break
    }
    case 'delete': {
      const ok = await actions.remove(props.item)
      if (ok) emit('delete', props.item)
      break
    }
  }
}

function activate(): void {
  actions.open(props.item)
}
</script>

<template>
  <div
    class="item-card"
    data-glass-card
    :class="[`size-${size}`, { dragging, unavailable }]"
    role="link"
    tabindex="0"
    :aria-label="`${item.title}（${openModeLabel}）`"
    @click="activate"
    @keydown.enter.prevent="activate"
    @keydown.space.prevent="activate"
    @contextmenu="showMenu"
  >
    <ItemIcon :item="item" :size="iconSize" />

    <div class="body">
      <div class="title" :title="item.title">{{ item.title }}</div>
      <div v-if="item.subtitle" class="subtitle" :title="item.subtitle">
        {{ item.subtitle }}
      </div>
    </div>

    <div class="meta">
      <NTooltip trigger="hover" :disabled="!offMode">
        <template #trigger>
          <span v-if="offMode" class="badge" :class="`badge-${resolved.source}`">
            {{ sourceLabel }}
          </span>
          <span v-else class="badge badge-ok">{{ sourceLabel }}</span>
        </template>
        <span class="tip">
          实际使用「{{ sourceLabel }}」地址
          <template v-if="host">（{{ host }}）</template>
          <br />
          与当前全局模式不一致时才显示此角标
        </span>
      </NTooltip>

      <NTooltip v-if="locked" trigger="hover">
        <template #trigger>
          <FaviconGlyph name="lock" :size="12" class="lock" />
        </template>
        <span class="tip">
          该卡片固定使用{{ item.networkPref === 'lan' ? '内网' : '外网' }}地址，
          不随全局模式切换
        </span>
      </NTooltip>

      <button
        class="more"
        type="button"
        title="更多操作"
        aria-label="更多操作"
        @click.stop="showMenu"
      >
        <FaviconGlyph name="settings" :size="13" />
      </button>
    </div>
  </div>

  <NDropdown
    placement="bottom-start"
    trigger="manual"
    :x="menuX"
    :y="menuY"
    :options="menuOptions"
    :show="menuVisible"
    :on-clickoutside="onClickOutside"
    @select="onSelect"
  />
</template>

<style scoped>
/* 白玻璃卡片：没有边框，静止时只有最轻的一层投影；
   hover 靠「玻璃变实 + 抬 1px + 投影变柔」来回应，不换成描边高亮。 */
.item-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 13px 15px;
  min-height: 68px;
  border: 0;
  border-radius: var(--r-md);
  background: var(--card-bg);
  /* 显式取色：不依赖 Naive UI 注入到 body 的文字色，
     否则运行时切换主题的一瞬间卡片文字会沿用上一个主题的颜色 */
  color: var(--text);
  backdrop-filter: var(--glass);
  -webkit-backdrop-filter: var(--glass);
  box-shadow: var(--shadow-1);
  cursor: pointer;
  outline: none;
  transition: transform 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
}

.item-card:hover {
  transform: translateY(-1px);
  background: var(--card-bg-hi);
  box-shadow: var(--shadow-2);
}

.item-card:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 34%, transparent), var(--shadow-2);
}

.item-card.dragging {
  opacity: 0.4;
}

.item-card.unavailable {
  opacity: 0.55;
}

.size-sm {
  min-height: 56px;
  padding: 9px 12px;
  gap: 10px;
}

.size-lg {
  min-height: 82px;
  padding: 17px 19px;
  gap: 15px;
}

.body {
  min-width: 0;
  flex: 1;
}

.title {
  font-weight: 550;
  font-size: 14px;
  letter-spacing: -0.005em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.size-lg .title {
  font-size: 15px;
}

.subtitle {
  color: var(--text-2);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.meta {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
}

/* 状态角标：纯色块，无边框 */
.badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--r-xs);
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-2);
  background: var(--surface-2);
}

.badge-ok {
  opacity: 0.5;
}

.badge-fallback {
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 16%, transparent);
}

.badge-none {
  color: var(--err);
  background: color-mix(in srgb, var(--err) 16%, transparent);
}

.badge-lan,
.badge-wan {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}

.lock {
  color: var(--warn);
  opacity: 0.9;
}

.more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.14s ease, background 0.14s ease, color 0.14s ease;
}

.item-card:hover .more,
.item-card:focus-within .more {
  opacity: 1;
}

.more:hover {
  background: var(--hover);
  color: var(--text);
}

.tip {
  font-size: 12px;
  line-height: 1.5;
}
</style>
