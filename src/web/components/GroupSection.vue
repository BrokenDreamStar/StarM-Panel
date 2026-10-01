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
import { useSettingsStore } from '@/stores/settings'
import ItemCard from './ItemCard.vue'
import FaviconGlyph from './FaviconGlyph.vue'

const props = defineProps<{
  /** null = 未分组区段 */
  group: Group | null
  items: Item[]
}>()

const emit = defineEmits<{
  (e: 'edit', item: Item): void
  (e: 'create', groupId: number | null): void
}>()

const itemsStore = useItemsStore()
const settings = useSettingsStore()

const collapsed = ref(props.group?.collapsed ?? false)

const editing = ref(false)
const nameDraft = ref('')
const nameInput = ref<InstanceType<typeof NInput> | null>(null)

const isUngrouped = computed(() => props.group === null)
const title = computed(() => props.group?.name ?? '未分组')
const count = computed(() => props.items.length)

const groupMenu: DropdownOption[] = [
  { label: '重命名', key: 'rename' },
  { label: '在此分组新建卡片', key: 'create' },
  { type: 'divider', key: 'd' },
  { label: '删除分组（卡片保留）', key: 'delete' },
]

function toggle(): void {
  if (isUngrouped.value) return
  collapsed.value = !collapsed.value
  if (props.group) void itemsStore.toggleGroupCollapsed(props.group.id)
}

async function startRename(): Promise<void> {
  if (!props.group) return
  nameDraft.value = props.group.name
  editing.value = true
  await nextTick()
  nameInput.value?.focus()
}

async function commitRename(): Promise<void> {
  if (!props.group || !editing.value) return
  const name = nameDraft.value.trim()
  editing.value = false
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
      const ok = window.confirm(
        `删除分组「${props.group.name}」？组内 ${count.value} 张卡片会变为未分组，不会被删除。`,
      )
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

const cardSize = computed(() => settings.cardSize)
</script>

<template>
  <section class="group">
    <header class="group-head">
      <button
        class="group-toggle"
        type="button"
        :disabled="isUngrouped"
        :title="isUngrouped ? '未分组卡片不可折叠' : collapsed ? '展开' : '折叠'"
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
        v-if="editing"
        ref="nameInput"
        v-model:value="nameDraft"
        size="tiny"
        class="rename-input"
        @blur="commitRename"
        @keydown.enter="commitRename"
        @keydown.esc="editing = false"
      />
      <h2 v-else class="group-title" @dblclick="startRename">
        {{ title }}
        <span class="group-count mono">{{ count }}</span>
      </h2>

      <span class="spacer" />

      <NButton size="tiny" quaternary title="新建卡片" @click="emit('create', group?.id ?? null)">
        <FaviconGlyph name="plus" :size="13" />
      </NButton>

      <NDropdown
        v-if="!isUngrouped"
        trigger="click"
        :options="groupMenu"
        @select="onGroupMenu"
      >
        <NButton size="tiny" quaternary title="分组操作">
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
        :dragging="dragId === item.id"
        :class="{ 'drop-target': overId === item.id }"
        draggable="true"
        @dragstart="onDragStart(item, $event)"
        @dragover="onDragOver(item, $event)"
        @drop.prevent="onDrop(item)"
        @dragend="dragId = null; overId = null"
        @edit="emit('edit', item)"
      />
      <button class="add-tile" type="button" @click="emit('create', group?.id ?? null)">
        <span class="plus-circle"><FaviconGlyph name="plus" :size="15" /></span>
        <span>新建卡片</span>
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
  color: var(--text-2);
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
  color: var(--text);
  letter-spacing: -0.008em;
  cursor: default;
  display: flex;
  align-items: center;
  gap: 7px;
}

/* 计数不描边，只是一枚更淡的色块 */
.group-count {
  font-size: 11px;
  color: var(--text-3);
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
  gap: 12px;
}

.group-body.size-sm {
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
}

.group-body.size-md {
  grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
}

.group-body.size-lg {
  grid-template-columns: repeat(auto-fill, minmax(284px, 1fr));
}

/* 拖拽落点是功能提示，不是装饰线：保留但做得更柔 */
.drop-target {
  outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
  outline-offset: 2px;
}

/* 「新建卡片」位：静止时几乎不存在，只有一个 + 号；
   hover 才浮成一张卡片。去线之后靠这个对比表达可操作性。 */
.add-tile {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 68px;
  padding: 13px 15px;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: transform 0.16s ease, background 0.16s ease, color 0.16s ease,
    box-shadow 0.16s ease;
}

.add-tile:hover {
  transform: translateY(-1px);
  background: var(--card-bg-hi);
  backdrop-filter: var(--glass);
  -webkit-backdrop-filter: var(--glass);
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
</style>
