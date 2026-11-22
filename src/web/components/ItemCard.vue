<script setup lang="ts">
/**
 * 桌面卡片。
 *
 * 视觉层次：图标 → 标题/副标题 → 右上角网络警告图标（来源 / 固定偏好）。
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
import { TEXT as T } from '@shared/text'
import type { Item } from '@shared/types'
import ItemIcon from './ItemIcon.vue'
import FaviconGlyph from './FaviconGlyph.vue'

/**
 * 卡片根节点手动承接透传属性（class / draggable / drag* 监听）。
 *
 * 模板有两个根节点（卡片本体 + 右键菜单的 NDropdown），Vue 不会自动把
 * 父组件传下来的属性挂到任何一个根节点上；不显式 v-bind="$attrs" 的话，
 * GroupSection 的 draggable 与拖拽事件会全部丢失，卡片无法拖拽排序。
 */
defineOptions({ inheritAttrs: false })

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
const unavailable = computed(() => resolved.value.url === null)

/** 侧别文案：内网 / 外网 */
function sideLabel(side: 'lan' | 'wan'): string {
  return side === 'lan' ? T.common.lan : T.common.wan
}

/**
 * 网络警告文案，可同时成立多条：
 *   - 卡片固定了内外网偏好
 *   - 首选一侧没配地址，实际用了另一侧
 *   - 两侧地址都没配
 */
const warnings = computed<string[]>(() => {
  const list: string[] = []
  const pref = props.item.networkPref
  if (pref !== 'auto') list.push(T.item.warningPinned(sideLabel(pref)))

  // 首选侧：卡片固定偏好优先，否则跟随全局生效模式
  const preferred = pref === 'auto' ? network.effectiveMode : pref
  const fallback = preferred === 'lan' ? 'wan' : 'lan'
  if (resolved.value.source === 'fallback') {
    list.push(T.item.warningFallback(sideLabel(preferred), sideLabel(fallback)))
  } else if (resolved.value.source === 'none') {
    list.push(T.item.warningMissing)
  }
  return list
})

/** 右上角网络警告图标，见设置 → 首页；编辑模式下让位给移除按钮 */
const showWarning = computed(
  () => settings.get('ui.showCardWarning') && warnings.value.length > 0 && !props.editing,
)

const openModeLabel = computed(() =>
  settings.openMode === 'self' ? T.item.openSelf : T.item.openNewTab,
)

const iconSize = computed(() => (props.size === 'sm' ? 36 : props.size === 'lg' ? 56 : 50))

const menuOptions: DropdownOption[] = [
  { label: T.item.edit, key: 'edit' },
  { label: T.item.copyLink, key: 'copy' },
  { label: T.item.openInNewWindow, key: 'open-new' },
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
    v-bind="$attrs"
    class="item-card"
    data-glass-card
    :class="[
      `size-${size}`,
      { dragging, unavailable, 'has-warning': showWarning, 'has-actions': editing },
    ]"
    role="link"
    tabindex="0"
    :aria-label="editing ? T.item.ariaEdit(item.title) : T.item.ariaOpen(item.title, openModeLabel)"
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
      <NTooltip v-if="showWarning" trigger="hover">
        <template #trigger>
          <FaviconGlyph name="alert" :size="14" class="warning" />
        </template>
        <span class="tip">{{ warnings.join('\n') }}</span>
      </NTooltip>

      <button
        v-if="editing"
        class="card-remove"
        type="button"
        :title="T.item.removeAria(item.title)"
        :aria-label="T.item.removeAria(item.title)"
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
  /* 固定高度：桌面与手机、所有尺寸档位都是同一个 70px，
     内容只在内部排布，不得把卡片撑高 */
  height: var(--card-h);
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

/* 档位只改内距、图标大小与字号；高度统一由 --card-h 固定 */
.size-sm {
  padding: 11px 12px;
  gap: 12px;
}

.size-lg {
  /* 70px 高、56px 图标：内容区 58px，图标居中后上下各约 7px，避免被 overflow 裁切 */
  padding: 6px 14px;
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

/* 警告图标悬浮在卡片右上角，不占正文宽度；正文为它预留右侧空间 */
.meta {
  position: absolute;
  top: 8px;
  right: 10px;
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
}

.has-warning .body {
  padding-right: 26px;
}

/* 编辑模式：给右上角的移除角标预留位置 */
.has-actions .body {
  padding-right: 30px;
}

/* 网络警告：来源与全局模式不一致或卡片固定了内外网偏好 */
.warning {
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
  /* 多条警告用 \n 拼接，逐行显示 */
  white-space: pre-line;
}

/*
 * 手机端：卡片宽度跟着两列网格走，高度仍然固定 70px。
 *
 * 列宽由视口决定（320px 的屏上两列各约 138px），高度不随列宽伸缩 ——
 * 所有断点、所有档位都是同一个 --card-h。固定高度容得下 36px 图标与两行文字。
 */
@media (max-width: 640px) {
  .size-sm,
  .size-md,
  .size-lg {
    width: 100%;
    height: var(--card-h);
  }

  .item-card {
    padding: 8px 12px;
  }

  /* 70px 高度下两行文字放得下，行高从继承的 1.62 收紧到 1.2 更贴合卡片 */
  .title {
    line-height: 1.2;
  }

  .subtitle {
    margin-top: 2px;
    line-height: 1.2;
  }
}
</style>
