<script setup lang="ts">
/**
 * 分组区段 —— 标题（含折叠 / 重命名 / 删除）+ 卡片网格。
 *
 * 拖拽排序只做「同分组内换位」：跨分组移动请用卡片编辑器改「所属分组」，
 * 因为后端 /reorder 要求提交全量顺序，误拖时会一次性重排所有卡片。
 * 这里只提交本组内的顺序，避免意外。
 */
import { computed, ref, nextTick } from 'vue'
import { NButton, NDropdown, NInput, type DropdownOption } from 'naive-ui'
import type { Group, Item } from '@shared/types'
import { useItemsStore } from '@/stores/items'
import { useCardSize } from '@/composables/useCardSize'
import { TEXT as T } from '@shared/text'
import ItemCard from './ItemCard.vue'
import FaviconGlyph from './FaviconGlyph.vue'

const props = withDefaults(
  defineProps<{
    /** null = 未分组区段 */
    group: Group | null
    items: Item[]
    /** APP 区编辑模式：透传给卡片，控制移除角标 */
    editing?: boolean
    /**
     * 是否渲染区段标题行（折叠按钮 / 名称 / 计数 / 操作菜单）。
     * 面板里一个分组都没有时，唯一的「未分组」标题没有信息量，由首页置 false 收起。
     */
    showHeader?: boolean
  }>(),
  { showHeader: true },
)

const emit = defineEmits<{
  (e: 'edit', item: Item): void
  (e: 'create', groupId: number | null): void
}>()

const itemsStore = useItemsStore()

const collapsed = ref(props.group?.collapsed ?? false)

const renaming = ref(false)
const nameDraft = ref('')
const nameInput = ref<InstanceType<typeof NInput> | null>(null)

const isUngrouped = computed(() => props.group === null)
const title = computed(() => props.group?.name ?? T.common.ungrouped)
const count = computed(() => props.items.length)

const groupMenu: DropdownOption[] = [
  { label: T.group.rename, key: 'rename' },
  { label: T.group.createItem, key: 'create' },
  { type: 'divider', key: 'd' },
  { label: T.group.delete, key: 'delete' },
]

function toggle(): void {
  if (isUngrouped.value) return
  collapsed.value = !collapsed.value
  if (props.group) void itemsStore.toggleGroupCollapsed(props.group.id)
}

async function startRename(): Promise<void> {
  if (!props.group) return
  nameDraft.value = props.group.name
  renaming.value = true
  await nextTick()
  nameInput.value?.focus()
}

async function commitRename(): Promise<void> {
  if (!props.group || !renaming.value) return
  const name = nameDraft.value.trim()
  renaming.value = false
  if (name === '' || name === props.group.name) return
  try {
    await itemsStore.updateGroup(props.group.id, { name })
  } catch {
    // 错误已记录在 store.error，UI 会通过全局提示体现
  }
}

async function onGroupMenu(key: string): Promise<void> {
  if (!props.group) return
  switch (key) {
    case 'rename':
      await startRename()
      break
    case 'create':
      emit('create', props.group.id)
      break
    case 'delete': {
      const ok = window.confirm(T.group.deleteConfirm(props.group.name, count.value))
      if (ok) await itemsStore.removeGroup(props.group.id)
      break
    }
  }
}

// ── 拖拽换位（仅同分组）────────────────────────────────────

const dragId = ref<number | null>(null)
const overId = ref<number | null>(null)

function onDragStart(item: Item, event: DragEvent): void {
  dragId.value = item.id
  event.dataTransfer?.setData('text/plain', String(item.id))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(item: Item, event: DragEvent): void {
  if (dragId.value === null || dragId.value === item.id) return
  event.preventDefault()
  overId.value = item.id
}

async function onDrop(target: Item): Promise<void> {
  const sourceId = dragId.value
  overId.value = null
  dragId.value = null
  if (sourceId === null || sourceId === target.id) return

  const source = props.items.find((i) => i.id === sourceId)
  if (!source) return

  const ordered = [...props.items]
  const from = ordered.findIndex((i) => i.id === sourceId)
  const to = ordered.findIndex((i) => i.id === target.id)
  if (from < 0 || to < 0) return

  const [moved] = ordered.splice(from, 1)
  if (!moved) return
  ordered.splice(to, 0, moved)

  // 重排后按 10 递增写回 sort
  const order = ordered.map((item, index) => ({
    id: item.id,
    groupId: item.groupId,
    sort: (index + 1) * 10,
  }))

  try {
    await itemsStore.reorderItems(order)
  } catch {
    // 失败时 store 里保留原顺序（服务端未变）
  }
}

/** 手机上一律紧凑档（见 useCardSize），桌面按设置 */
const cardSize = useCardSize()
</script>

<template>
  <section class="group">
    <header v-if="showHeader" class="group-head">
      <button
        class="group-toggle"
        type="button"
        :disabled="isUngrouped"
        :title="
          isUngrouped
            ? T.group.cannotCollapse
            : collapsed
              ? T.group.expand
              : T.group.collapse
        "
        @click="toggle"
      >
        <FaviconGlyph
          :name="collapsed ? 'plus' : 'check'"
          :size="11"
          class="chev"
          :class="{ collapsed }"
        />
      </button>

      <NInput
        v-if="renaming"
        ref="nameInput"
        v-model:value="nameDraft"
        size="tiny"
        class="rename-input"
        @blur="commitRename"
        @keydown.enter="commitRename"
        @keydown.esc="renaming = false"
      />
      <h2 v-else class="group-title" @dblclick="startRename">
        {{ title }}
        <span class="group-count mono">{{ count }}</span>
      </h2>

      <span class="spacer" />

      <NButton
        v-if="editing || count === 0"
        size="tiny"
        quaternary
        :title="T.group.newItem"
        @click="emit('create', group?.id ?? null)"
      >
        <FaviconGlyph name="plus" :size="13" />
      </NButton>

      <NDropdown
        v-if="!isUngrouped"
        trigger="click"
        :options="groupMenu"
        @select="onGroupMenu"
      >
        <NButton size="tiny" quaternary :title="T.group.menuAria">
          <FaviconGlyph name="settings" :size="13" />
        </NButton>
      </NDropdown>
    </header>

    <div v-if="!collapsed" class="group-body" :class="`size-${cardSize}`">
      <ItemCard
        v-for="item in items"
        :key="item.id"
        :item="item"
        :size="cardSize"
        :editing="editing"
        :dragging="dragId === item.id"
        :class="{ 'drop-target': overId === item.id }"
        draggable="true"
        @dragstart="onDragStart(item, $event)"
        @dragover="onDragOver(item, $event)"
        @drop.prevent="onDrop(item)"
        @dragend="dragId = null; overId = null"
        @edit="emit('edit', item)"
      />
      <button
        v-if="editing || count === 0"
        class="add-tile"
        type="button"
        @click="emit('create', group?.id ?? null)"
      >
        <span class="plus-circle"><FaviconGlyph name="plus" :size="15" /></span>
        <span>{{ T.group.newItem }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.group {
  margin-bottom: var(--sp-6);
}

.group-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}

.group-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--wp-text-2);
  cursor: pointer;
}

.group-toggle:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.group-toggle:disabled {
  opacity: 0.28;
  cursor: default;
}

.chev {
  transition: transform 0.16s ease;
}

.chev.collapsed {
  transform: rotate(-90deg);
}

.group-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--wp-text);
  letter-spacing: -0.008em;
  cursor: default;
  display: flex;
  align-items: center;
  gap: 7px;
}

/* 计数不描边，只是一枚更淡的色块 */
.group-count {
  font-size: 11px;
  color: var(--wp-text-3);
  padding: 1px 6px;
  border-radius: var(--r-xs);
  background: var(--surface-2);
}

.rename-input {
  width: 220px;
}

.spacer {
  flex: 1;
}

.group-body {
  display: grid;
  gap: 18px;
}

.group-body.size-sm {
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
}

.group-body.size-md {
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
}

.group-body.size-lg {
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
}

/* 拖拽落点是功能提示，不是装饰线：保留但做得更柔 */
.drop-target {
  outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
  outline-offset: 2px;
}

/* 「新建卡片」位：与普通卡片同款玻璃底、同款投影，
   hover 同 ItemCard 一样只高亮不位移，只是内容是一枚 + 号。 */
.add-tile {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 70px;
  padding: 13px 15px;
  border: 0;
  border-radius: var(--r-xl);
  background: var(--card-bg);
  backdrop-filter: var(--glass);
  box-shadow: var(--shadow-1);
  color: var(--text-3);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
}

/* 与 ItemCard 的三档固定高度对齐 */
.group-body.size-sm .add-tile {
  height: 58px;
  padding: 11px 12px;
}

.group-body.size-lg .add-tile {
  height: 86px;
  padding: 15px 14px;
}

.add-tile:hover {
  background: var(--card-bg-hi);
  box-shadow: var(--shadow-2);
  color: var(--text);
}

.plus-circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: var(--r-sm);
  color: var(--text-2);
  background: var(--field-hi);
  transition: color 0.16s ease, background 0.16s ease;
}

.add-tile:hover .plus-circle {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}

/*
 * 手机端：一行最少两张卡片。
 *
 * 三档的 minmax 在窄屏（320–430px）都会退化成单列，卡片因此又长又空。
 * 这里把列宽取下限写成「档位宽度与半屏（减半个间距）中的较小者」：
 * 宽度够时照常按 auto-fill 多排，不够时也至少排两列 —— 390px 的屏上
 * 是两张 173px 的卡片，320px 的屏上是两张 ~138px 的卡片（标题按省略号收）。
 * 间距同步收一档，给卡片留出文字宽度。
 */
@media (max-width: 640px) {
  .group-body.size-sm,
  .group-body.size-md,
  .group-body.size-lg {
    gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(min(150px, calc(50% - 6px)), 1fr));
  }

  /* 「新建卡片」位跟卡片同比例、同高度下限，同一行里不能一高一矮 */
  .group-body.size-sm .add-tile,
  .group-body.size-md .add-tile,
  .group-body.size-lg .add-tile {
    width: 100%;
    height: auto;
    aspect-ratio: 3 / 1;
    min-height: 52px;
    padding: 8px 12px;
  }
}
</style>
