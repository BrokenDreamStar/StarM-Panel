<script setup lang="ts">
/**
 * 「系统状态」分区 —— 一排硬件卡片 + 点击后的详情弹窗。
 *
 * 卡片清单由 `monitor.cards` 驱动（见 composables/useStatCards）。增删与排序
 * 都在首页完成，交互对齐 App 卡片：
 *   - 末尾「添加卡片」位弹出候选信息卡片，点一下即追加；
 *   - 每张卡片悬停时右上角浮出移除角标；
 *   - 拖拽卡片可调整顺序（按设备粒度，每张卡对应一台设备）。
 */
import { computed, ref } from 'vue'
import { NPopover } from 'naive-ui'
import { useSettingsStore } from '@/stores/settings'
import {
  useStatCards,
  cardDisplayName,
  type CardCandidate,
  type StatCardRef,
} from '@/composables/useStatCards'
import { useEditModeDismiss } from '@/composables/useEditModeDismiss'
import { useDeleteConfirm } from '@/composables/useDeleteConfirm'
import { TEXT as T } from '@shared/text'
import SystemStatCard from './SystemStatCard.vue'
import SystemStatDetail from './SystemStatDetail.vue'
import FaviconGlyph from './FaviconGlyph.vue'
import SectionEditToggle from './SectionEditToggle.vue'

const { cards, candidates, addCard, removeCard, moveCard } = useStatCards()
const { confirm } = useDeleteConfirm()
const settings = useSettingsStore()

/** 卡片尺寸与 App 卡片共用 ui.cardSize（见 GroupSection） */
const cardSize = computed(() => settings.cardSize)

/** 编辑模式：开启后卡片右上角才显示移除角标 */
const editMode = ref(false)

// 点击空白处退出编辑模式（卡片 / 添加位 / 浮层 / 详情弹窗上不退出）
useEditModeDismiss(
  editMode,
  '.section-head, .stat-card, .add-tile, .n-popover, .n-dropdown, .n-modal, .n-modal-mask, .n-modal-container, .n-tooltip',
)

const active = ref<StatCardRef | null>(null)
const showDetail = ref(false)

function open(card: StatCardRef): void {
  active.value = card
  showDetail.value = true
}

// ── 添加卡片 ─────────────────────────────────────────────────

const pickerOpen = ref(false)

function pick(candidate: CardCandidate): void {
  pickerOpen.value = false
  void addCard(candidate.kind, candidate.device)
}

/** 移除角标的 tooltip：按设备粒度，写清移除的是哪一台 */
function removeTitle(card: StatCardRef): string {
  return T.status.removeCardAria(cardDisplayName(card.kind, card.device))
}

/** 移除一张硬件卡片：先弹确认弹窗，取消则不写回设置 */
async function requestRemove(card: StatCardRef): Promise<void> {
  const ok = await confirm({
    title: T.status.removeCard,
    content: T.status.removeCardConfirm(cardDisplayName(card.kind, card.device)),
    positiveText: T.status.remove,
  })
  if (!ok) return
  void removeCard(card)
}

// ── 拖拽排序（按设备粒度；「自动」条目拖拽时物化成具体设备）────

const dragCard = ref<StatCardRef | null>(null)
const overId = ref<string | null>(null)

function onDragStart(card: StatCardRef, event: DragEvent): void {
  dragCard.value = card
  event.dataTransfer?.setData('text/plain', card.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(card: StatCardRef, event: DragEvent): void {
  if (!dragCard.value || dragCard.value.id === card.id) return
  event.preventDefault()
  overId.value = card.id
}

function onDrop(card: StatCardRef): void {
  const source = dragCard.value
  overId.value = null
  dragCard.value = null
  if (!source || source.id === card.id) return
  void moveCard(source, card)
}
</script>

<template>
  <section class="status-section">
    <header class="section-head">
      <h2 class="section-title">{{ T.status.title }}</h2>
      <SectionEditToggle :active="editMode" @toggle="editMode = !editMode" />
    </header>

    <div class="stat-grid" :class="`size-${cardSize}`">
      <SystemStatCard
        v-for="card in cards"
        :key="card.id"
        :kind="card.kind"
        :device="card.device"
        :size="cardSize"
        :remove-title="removeTitle(card)"
        :editing="editMode"
        draggable="true"
        :class="{ dragging: dragCard?.id === card.id, 'drop-target': overId === card.id }"
        @open="open(card)"
        @remove="requestRemove(card)"
        @dragstart="onDragStart(card, $event)"
        @dragover="onDragOver(card, $event)"
        @drop.prevent="onDrop(card)"
        @dragend="dragCard = null; overId = null"
      />

      <!-- 添加卡片：与 App 卡片的「新建卡片」位同款；仅编辑模式或暂无卡片时出现 -->
      <NPopover
        v-if="editMode || cards.length === 0"
        v-model:show="pickerOpen"
        trigger="click"
        placement="bottom-start"
        :disabled="candidates.length === 0"
      >
        <template #trigger>
          <button
            class="add-tile"
            type="button"
            :disabled="candidates.length === 0"
            :title="candidates.length === 0 ? T.status.allAdded : T.status.addButton"
          >
            <span class="plus-circle"><FaviconGlyph name="plus" :size="15" /></span>
            <span>{{ T.status.addButton }}</span>
          </button>
        </template>

        <div class="picker">
          <p class="picker-title dim">{{ T.status.addButton }}</p>
          <button
            v-for="candidate in candidates"
            :key="candidate.id"
            class="picker-item"
            type="button"
            @click="pick(candidate)"
          >
            <span class="picker-icon"><FaviconGlyph :name="candidate.icon" :size="16" /></span>
            <span class="picker-text">
              <span class="picker-name">{{ candidate.name }}</span>
              <span class="picker-hint dim">{{ candidate.hint }}</span>
            </span>
          </button>
        </div>
      </NPopover>
    </div>

    <p v-if="cards.length === 0" class="section-hint dim">
      {{ T.status.empty }}
    </p>

    <SystemStatDetail v-model:show="showDetail" :card="active" />
  </section>
</template>

<style scoped>
.status-section {
  margin-bottom: var(--sp-7);
}

/* 标题行：标题 + 隐藏的编辑开关。
   用 inline-flex 让悬停热区只覆盖标题与图标本身，而不是整行空白。 */
.section-head {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: var(--sp-4);
}

.section-head .section-title {
  margin: 0;
}

.stat-grid {
  display: grid;
  gap: 18px;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
}

/* 三档尺寸与 App 卡片区（GroupSection 的 .group-body）保持一致 */
.stat-grid.size-sm {
  /* 紧凑档硬件卡片比 App 卡片略宽（160 vs 150）：
     数值（如 161.9/228.3 GB）比标题更需要横向空间 */
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
}

.stat-grid.size-md {
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
}

.stat-grid.size-lg {
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
}

.section-hint {
  margin: 12px 0 0;
  font-size: 12px;
}

/* 拖拽落点是功能提示，不是装饰线：保留但做得更柔（同 App 卡片） */
.drop-target {
  outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
  outline-offset: 2px;
}

.dragging {
  opacity: 0.55;
}

/* 「添加卡片」位：与硬件卡片同款玻璃底、同款投影，内容是一枚 + 号 */
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

/* 「添加卡片」位跟随卡片尺寸，与硬件卡片等高 */
.stat-grid.size-sm .add-tile {
  height: 58px;
  padding: 10px 12px;
}

.stat-grid.size-lg .add-tile {
  height: 86px;
  padding: 15px 15px;
}

.add-tile:hover:not(:disabled) {
  background: var(--card-bg-hi);
  box-shadow: var(--shadow-2);
  color: var(--text);
}

.add-tile:disabled {
  cursor: default;
  opacity: 0.6;
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

.add-tile:hover:not(:disabled) .plus-circle {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}

/* ── 添加卡片浮层 ─────────────────────────────────────────── */

.picker {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 220px;
  padding: 4px;
}

.picker-title {
  margin: 2px 6px 6px;
  font-size: 11px;
  letter-spacing: 0.08em;
}

.picker-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.14s ease;
}

.picker-item:hover:not(:disabled) {
  background: var(--field-hi);
}

.picker-item:disabled {
  cursor: default;
  opacity: 0.5;
}

.picker-icon {
  display: inline-flex;
  flex: none;
  color: var(--text-2);
}

.picker-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.picker-name {
  font-size: 13px;
}

.picker-hint {
  font-size: 11px;
}
</style>
