<script setup lang="ts">
/**
 * 桌面页（/）。
 *
 * 版式对齐 Sun-Panel 参考图（docs/reference/sun-panel-ui.webp）：
 *   右上角浮动控制组 → 居中英雄区（标题 + 时钟）→「系统状态」硬件卡片行
 *   →「APP」应用卡片区 → 底部页脚（Powered By + Copyright）。
 *
 * 页脚用 flex 撑开（`.home` 纵向 flex + `.content` flex:1 + 页脚 margin-top:auto）：
 * 内容不足一屏时贴着视口底部，内容超出一屏时跟在卡片后面正常滚动。
 *
 * 没有常驻顶栏、没有监控侧栏：硬件信息就是和 App 卡片并列的一排卡片，
 * 点击后弹出详情（见 components/SystemStatusSection.vue）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useMessage } from 'naive-ui'
import { useItemsStore } from '@/stores/items'
import { useSettingsStore } from '@/stores/settings'
import { useNetworkStore } from '@/stores/network'
import { TEXT as T } from '@shared/text'
import { PROJECT_REPO_URL } from '@shared/links'
import type { Group, Item } from '@shared/types'
import GroupSection from '@/components/GroupSection.vue'
import CardEditor from '@/components/CardEditor.vue'
import HeroHeader from '@/components/HeroHeader.vue'
import FloatingControls from '@/components/FloatingControls.vue'
import SettingsModal from '@/components/SettingsModal.vue'
import SystemStatusSection from '@/components/SystemStatusSection.vue'
import SectionEditToggle from '@/components/SectionEditToggle.vue'
import { useEditModeDismiss } from '@/composables/useEditModeDismiss'

const message = useMessage()
const itemsStore = useItemsStore()
const settings = useSettingsStore()
const network = useNetworkStore()

const { sortedGroups, enabledItems, hydrated, error } = storeToRefs(itemsStore)

// ── 编辑弹窗状态 ─────────────────────────────────────────────
const editorOpen = ref(false)
const editingItem = ref<Item | null>(null)
const presetGroupId = ref<number | null>(null)

// ── 设置弹窗 ────────────────────────────────────────────────
const settingsOpen = ref(false)

// ── APP 区编辑模式（开启后卡片右上角才显示移除角标）──────────
const appEditMode = ref(false)

// 点击空白处退出编辑模式（卡片 / 新建位 / 分组头 / 弹窗上不退出）
useEditModeDismiss(
  appEditMode,
  '.section-head, .item-card, .add-tile, .group-head, .n-popover, .n-dropdown, .n-modal, .n-modal-mask, .n-modal-container, .n-tooltip',
)

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

interface Section {
  group: Group | null
  items: Item[]
}

const sections = computed<Section[]>(() => {
  const result: Section[] = []
  for (const group of sortedGroups.value) {
    result.push({ group, items: enabledItems.value.filter((i) => i.groupId === group.id) })
  }
  const ungrouped = enabledItems.value.filter((i) => i.groupId === null)
  if (ungrouped.length > 0 || result.length === 0) {
    result.push({ group: null, items: ungrouped })
  }
  return result
})

/**
 * 还没有任何分组时，「未分组」这个标题没有信息量（整块面板都是未分组），
 * 只在多个区段并存、需要靠标题区分时才有意义 —— 此时把区段头整个收起来。
 */
const showSectionHeaders = computed(() => sortedGroups.value.length > 0)

// ── 键盘快捷键 ───────────────────────────────────────────────

function onKeydown(event: KeyboardEvent): void {
  // Ctrl/Cmd + Shift + N：在内网 / 外网间切换（自动模式只能在设置弹窗里选）
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'n') {
    event.preventDefault()
    const next = network.toggleMode()
    message.info(T.home.networkModeSwitched(next === 'lan' ? T.common.lan : T.common.wan))
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
    <FloatingControls @open-settings="settingsOpen = true" />

    <main class="content">
      <HeroHeader :title="title" :show-clock="showClock" />

      <!-- 系统状态：与 App 卡片并列的一排硬件卡片 -->
      <SystemStatusSection v-if="showMonitor" />

      <section class="apps">
        <header class="section-head">
          <h2 class="section-title">{{ T.home.appsSection }}</h2>
          <SectionEditToggle :active="appEditMode" @toggle="appEditMode = !appEditMode" />
        </header>

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
            :editing="appEditMode"
            :show-header="showSectionHeaders"
            @edit="openEdit"
            @create="openCreate"
          />
        </template>
      </section>

      <footer class="powered">
        <!-- 品牌名链到项目仓库：新标签打开，不打断面板上的操作 -->
        <p class="powered-line">
          {{ T.home.footerPowered }}
          <a
            class="powered-brand"
            :href="PROJECT_REPO_URL"
            target="_blank"
            rel="noopener noreferrer"
          >{{ T.home.footerBrand }}</a>
        </p>
        <p class="powered-line">{{ T.home.footerCopyright }}</p>
      </footer>
    </main>

    <CardEditor
      v-model:show="editorOpen"
      :item="editingItem"
      :groups="sortedGroups"
      :initial-group-id="presetGroupId"
      @saved="editingItem = null"
    />

    <SettingsModal v-model:show="settingsOpen" />
  </div>
</template>

<style scoped>
/* 滚动容器同时是纵向 flex 容器：内容区 flex:1 撑满一屏，
   页脚再用 margin-top:auto 顶到底部（内容不足时也不悬在半空）。 */
.home {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.content {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 32px 44px;
}

.apps {
  margin-top: var(--sp-1);
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

.skeleton-grid {
  display: grid;
  gap: 18px;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
}

/* 骨架屏也是卡片形状：无边框，只有一层淡色块在流光 */
.skeleton {
  height: 70px;
  border: 0;
  border-radius: var(--r-xl);
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

.powered {
  /* 自动外边距吃掉剩余空间：内容不足一屏时把页脚压到容器底部 */
  margin-top: auto;
  padding: var(--sp-7) 0 var(--sp-2);
  text-align: center;
  font-size: 12px;
  letter-spacing: 0.05em;
  color: var(--wp-text-3);
  /* 参考图里这行很淡，但 0.72 在浅色下对比度只有 3.0:1，抬到 0.9 保证可读 */
  opacity: 0.9;
}

.powered-line {
  margin: 0;
  line-height: 1.7;
}

/* 页脚品牌链接：平时与两行文字同色同字重（页脚很淡，不该抢视线），
   只靠细下划线和悬停 / 键盘聚焦时的强调色表明「这里可以点」。 */
.powered-brand {
  margin-left: 0.35em;
  color: inherit;
  text-decoration: none;
  border-bottom: 1px solid color-mix(in srgb, currentColor 40%, transparent);
  transition:
    color 0.15s ease,
    border-color 0.15s ease;
}

.powered-brand:hover,
.powered-brand:focus-visible {
  color: var(--accent);
  border-bottom-color: currentColor;
}

/* 手机端：32px 的两侧留白会把 390px 的屏挤到只剩 326px（一行放不下两张卡片），
   收成 16px；骨架屏与真卡片同一套列宽，加载完成时列数不跳变。 */
@media (max-width: 640px) {
  .content {
    padding: 0 16px 32px;
  }

  .skeleton-grid {
    gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(min(150px, calc(50% - 6px)), 1fr));
  }
}
</style>
