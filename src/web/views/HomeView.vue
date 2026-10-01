<script setup lang="ts">
/**
 * 桌面页（/）。
 *
 * 版式对齐 Sun-Panel 参考图（docs/reference/sun-panel-ui.webp）：
 *   右上角浮动控制组 → 居中英雄区（标题 + 时钟）→「系统状态」硬件卡片行
 *   →「APP」应用卡片区 → 底部 Powered By。
 *
 * 没有常驻顶栏、没有监控侧栏：硬件信息就是和 App 卡片并列的一排卡片，
 * 点击后弹出详情（见 components/SystemStatusSection.vue）。
 *
 * 搜索（浮动控制组里的输入框）匹配标题 / 副标题 / 解析后的地址，
 * 命中时自动展开折叠分组并隐藏「系统状态」区，让结果更聚焦。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { NButton, useMessage } from 'naive-ui'
import { useItemsStore } from '@/stores/items'
import { useSettingsStore } from '@/stores/settings'
import { useNetworkStore } from '@/stores/network'
import type { Group, Item } from '@shared/types'
import GroupSection from '@/components/GroupSection.vue'
import CardEditor from '@/components/CardEditor.vue'
import HeroHeader from '@/components/HeroHeader.vue'
import FloatingControls from '@/components/FloatingControls.vue'
import SystemStatusSection from '@/components/SystemStatusSection.vue'
import FaviconGlyph from '@/components/FaviconGlyph.vue'

const message = useMessage()
const itemsStore = useItemsStore()
const settings = useSettingsStore()
const network = useNetworkStore()

const { sortedGroups, enabledItems, hydrated, error } = storeToRefs(itemsStore)

const query = ref('')
const controls = ref<InstanceType<typeof FloatingControls> | null>(null)

// ── 编辑弹窗状态 ─────────────────────────────────────────────
const editorOpen = ref(false)
const editingItem = ref<Item | null>(null)
const presetGroupId = ref<number | null>(null)

function openCreate(groupId: number | null): void {
  editingItem.value = null
  presetGroupId.value = groupId
  editorOpen.value = true
}

function openEdit(item: Item): void {
  editingItem.value = item
  presetGroupId.value = item.groupId
  editorOpen.value = true
}

// ── 首页配置（来自设置）─────────────────────────────────────

const title = computed(() => settings.get('ui.title'))
const showClock = computed(() => settings.get('ui.showClock'))
const showMonitor = computed(() => settings.showMonitor)

// ── 搜索 ─────────────────────────────────────────────────────

function matches(item: Item): boolean {
  const q = query.value.trim().toLowerCase()
  if (q === '') return true
  if (item.title.toLowerCase().includes(q)) return true
  if ((item.subtitle ?? '').toLowerCase().includes(q)) return true
  const resolved = network.resolve(item)
  return (resolved.url ?? '').toLowerCase().includes(q)
}

const filteredItems = computed(() => enabledItems.value.filter(matches))
const searching = computed(() => query.value.trim() !== '')
const totalVisible = computed(() => filteredItems.value.length)

interface Section {
  group: Group | null
  items: Item[]
}

const sections = computed<Section[]>(() => {
  const result: Section[] = []
  for (const group of sortedGroups.value) {
    const list = filteredItems.value.filter((i) => i.groupId === group.id)
    if (searching.value && list.length === 0) continue
    result.push({ group, items: list })
  }
  const ungrouped = filteredItems.value.filter((i) => i.groupId === null)
  if (ungrouped.length > 0 || (!searching.value && result.length === 0)) {
    result.push({ group: null, items: ungrouped })
  }
  return result
})

/** 探测相关的提示：正常时不显示，避免在首页留一条常驻状态栏 */
const networkWarning = computed(() => {
  if (network.probeUnsupported) return '探测接口不可用，自动模式将保守使用外网地址'
  if (network.isAuto && network.probedCount === 0) {
    return '自动模式：探测结果尚未就绪，暂时按外网地址解析'
  }
  return ''
})

// ── 键盘快捷键 ───────────────────────────────────────────────

function onKeydown(event: KeyboardEvent): void {
  // Ctrl/Cmd + Shift + N：循环切换内外网
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'n') {
    event.preventDefault()
    const next = network.cycleMode()
    message.info(`网络模式：${next === 'lan' ? '内网' : next === 'wan' ? '外网' : '自动'}`)
    return
  }
  // "/" 展开并聚焦浮动控制组里的搜索框（不在输入框里时）
  const target = event.target as HTMLElement | null
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable === true
  if (!typing && event.key === '/') {
    event.preventDefault()
    void controls.value?.openSearch()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="home">
    <FloatingControls ref="controls" v-model:query="query" />

    <main class="content">
      <HeroHeader :title="title" :show-clock="showClock" />

      <!-- 系统状态：与 App 卡片并列的一排硬件卡片；搜索时让位给结果 -->
      <SystemStatusSection v-if="showMonitor && !searching" />

      <section class="apps">
        <h2 class="section-title">APP</h2>

        <p v-if="searching" class="search-line dim">
          搜索「{{ query }}」命中 {{ totalVisible }} 张卡片
          <button class="link-btn" type="button" @click="query = ''">清除搜索</button>
        </p>

        <p v-if="error" class="err-line">{{ error }}</p>

        <div v-if="!hydrated && !enabledItems.length" class="skeleton-grid">
          <div v-for="n in 8" :key="n" class="skeleton" />
        </div>

        <template v-else>
          <GroupSection
            v-for="section in sections"
            :key="section.group?.id ?? 'ungrouped'"
            :group="section.group"
            :items="section.items"
            @edit="openEdit"
            @create="openCreate"
          />

          <div v-if="searching && totalVisible === 0" class="empty card">
            <FaviconGlyph name="search" :size="20" />
            <p>没有匹配「{{ query }}」的卡片</p>
            <NButton size="tiny" @click="query = ''">清除搜索</NButton>
          </div>

          <div v-if="!searching && enabledItems.length === 0" class="empty card">
            <FaviconGlyph name="plus" :size="20" />
            <p>还没有卡片。点击下方「新建卡片」开始。</p>
            <NButton size="tiny" type="primary" @click="openCreate(null)">新建卡片</NButton>
          </div>
        </template>
      </section>

      <p v-if="networkWarning" class="warn-line">
        <i class="dot warn" />
        {{ networkWarning }}
      </p>

      <footer class="powered">Powered By StarM Panel</footer>
    </main>

    <CardEditor
      v-model:show="editorOpen"
      :item="editingItem"
      :groups="sortedGroups"
      :initial-group-id="presetGroupId"
      @saved="editingItem = null"
    />
  </div>
</template>

<style scoped>
.home {
  position: relative;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.content {
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 32px 44px;
}

.apps {
  margin-top: var(--sp-1);
}

.search-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 var(--sp-4);
  font-size: 12px;
}

.link-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* 错误条：纯色块，无描边 */
.err-line {
  margin: 0 0 var(--sp-4);
  padding: var(--sp-2) var(--sp-3);
  border: 0;
  border-radius: var(--r-sm);
  font-size: 12px;
  color: var(--err);
  background: color-mix(in srgb, var(--err) 14%, transparent);
}

.warn-line {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: var(--sp-6) 0 0;
  font-size: 12px;
  color: var(--text-2);
}

.skeleton-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
}

/* 骨架屏也是卡片形状：无边框，只有一层淡色块在流光 */
.skeleton {
  height: 68px;
  border: 0;
  border-radius: var(--r-md);
  background: linear-gradient(
    90deg,
    var(--field) 25%,
    var(--field-hi) 37%,
    var(--field) 63%
  );
  background-size: 400% 100%;
  animation: shimmer 1.4s ease infinite;
}

@keyframes shimmer {
  0% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0 50%;
  }
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-7) var(--sp-5);
  color: var(--text-2);
}

.empty p {
  margin: 0;
}

.powered {
  margin-top: var(--sp-7);
  padding: var(--sp-4) 0 var(--sp-2);
  text-align: center;
  font-size: 12px;
  letter-spacing: 0.05em;
  color: var(--text-3);
  /* 参考图里这行很淡，但 0.72 在浅色下对比度只有 3.0:1，抬到 0.9 保证可读 */
  opacity: 0.9;
  text-shadow: var(--hero-glow);
}
</style>
