<script setup lang="ts">
/**
 * 桌面卡片。
 *
 * 视觉层次：图标 → 标题/副标题 → 底部状态角标（来源 + 锁定偏好）。
 * 交互：左键按全局「打开方式」（ui.openMode）打开；右键打开管理菜单
 * （编辑 / 复制链接 / 新窗口）。删除只在编辑模式的移除角标与卡片编辑器里提供。
 * 进入分区编辑模式（editing）后，右上角才显示移除角标，且点击卡片改为打开编辑器。
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
    /** 编辑模式：卡片右上角显示移除角标，点击卡片改为打开编辑器 */
    editing?: boolean
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

const iconSize = computed(() => (props.size === 'sm' ? 36 : props.size === 'lg' ? 56 : 50))

const menuOptions: DropdownOption[] = [
  { label: '编辑', key: 'edit' },
  { label: '复制链接', key: 'copy' },
  { label: '在新窗口打开', key: 'open-new' },
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
  }
}

/** 删除卡片（编辑模式的移除角标用；右键菜单里不再提供删除） */
async function removeCard(): Promise<void> {
  const ok = await actions.remove(props.item)
  if (ok) emit('delete', props.item)
}

function activate(): void {
  // 编辑模式下卡片不再跳转，改为打开编辑器，避免误触打开链接
  if (props.editing) {
    emit('edit', props.item)
    return
  }
  actions.open(props.item)
}
</script>

<template>
  <div
    class="item-card"
    data-glass-card
    :class="[
      `size-${size}`,
      { dragging, unavailable, 'has-badge': offMode && !editing, 'has-actions': editing },
    ]"
    role="link"
    tabindex="0"
    :aria-label="editing ? `${item.title}（点击编辑）` : `${item.title}（${openModeLabel}）`"
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
      <NTooltip v-if="offMode && !editing" trigger="hover">
        <template #trigger>
          <span class="badge" :class="`badge-${resolved.source}`">
            {{ sourceLabel }}
          </span>
        </template>
        <span class="tip">
          实际使用「{{ sourceLabel }}」地址
          <template v-if="host">（{{ host }}）</template>
          <br />
          与当前全局模式不一致时才显示此角标
        </span>
      </NTooltip>

      <NTooltip v-if="locked && !editing" trigger="hover">
        <template #trigger>
          <FaviconGlyph name="lock" :size="12" class="lock" />
        </template>
        <span class="tip">
          该卡片固定使用{{ item.networkPref === 'lan' ? '内网' : '外网' }}地址，
          不随全局模式切换
        </span>
      </NTooltip>

      <button
        v-if="editing"
        class="card-remove"
        type="button"
        :title="`移除「${item.title}」`"
        :aria-label="`移除「${item.title}」`"
        @click.stop="removeCard"
      >
        <FaviconGlyph name="close" :size="13" />
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
   hover 只做「玻璃变实 + 投影变柔」的高亮，不做位移，也不换成描边高亮。 */
.item-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  /* 固定高度：内容（标题 + 副标题）不得再改变卡片高度，
     超出部分裁掉；紧凑档通过隐藏副标题来适配 */
  height: 70px;
  overflow: hidden;
  border: 0;
  border-radius: var(--r-xl);
  background: var(--card-bg);
  /* 显式取色：不依赖 Naive UI 注入到 body 的文字色，
     否则运行时切换主题的一瞬间卡片文字会沿用上一个主题的颜色 */
  color: var(--text);
  backdrop-filter: var(--glass);
  box-shadow: var(--shadow-1);
  cursor: pointer;
  outline: none;
  transition: background 0.16s ease, box-shadow 0.16s ease;
}

.item-card:hover {
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
  height: 58px;
  padding: 11px 12px;
  gap: 12px;
}

.size-lg {
  height: 86px;
  padding: 15px 14px;
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

/* 紧凑档不显示副标题：卡片高度固定，多一行会把内容撑出卡片 */
.size-sm .subtitle {
  display: none;
}

/* 角标悬浮在卡片右上角，不占正文宽度；
   「正常」态只在悬停时浮现（与 tooltip 约定一致：与全局模式不一致才常显），
   回退态常显，正文为其预留右侧空间。 */
.meta {
  position: absolute;
  top: 8px;
  right: 10px;
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
}

.has-badge .body {
  padding-right: 44px;
}

/* 编辑模式：给右上角的移除角标预留位置 */
.has-actions .body {
  padding-right: 30px;
}

/* 状态角标：纯色块，无边框；只在「与全局模式不一致」时常显 */
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

/* 编辑模式的移除角标 */
.card-remove {
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
  transition: background 0.14s ease, color 0.14s ease;
}

.card-remove:hover,
.card-remove:focus-visible {
  background: color-mix(in srgb, var(--err) 16%, transparent);
  color: var(--err);
}

.tip {
  font-size: 12px;
  line-height: 1.5;
}
</style>
