<script setup lang="ts">
/**
 * 内外网一键切换 —— 三态分段控件。
 *
 * 状态点语义（每个按钮各自带点）：
 *   绿  = 该模式下当前可达（内网/自动读探测结果；外网视为可达）
 *   灰  = 探测到不可达（或探测被 SSRF 白名单拒绝）
 *   空心 = 尚未探测（后端探测未就绪 / 刚启动）
 *
 * 点击是**同步生效**的：store.setMode 先写 localStorage 再异步 PATCH，
 * 所以这里不需要 loading 态，切换手感是即时的。
 */
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useNetworkStore, MODE_HINT, MODE_LABEL } from '@/stores/network'
import type { NetworkMode } from '@shared/types'
import StatusDot from './StatusDot.vue'

const emit = defineEmits<{ (e: 'change', mode: NetworkMode): void }>()

const network = useNetworkStore()
const { mode, probing, probeUnsupported, probedCount } = storeToRefs(network)

const MODES: NetworkMode[] = ['lan', 'wan', 'auto']

/**
 * 每个按钮的状态点。
 * - 内网：读探测结果里 LAN 源可用数量 → 有任意可达即绿，否则若已探测则灰
 * - 外网：外网地址在任何网络环境下都假定可达 → 绿
 * - 自动：等同内网（自动模式是否走内网取决于同一份探测结果）
 */
function dotState(target: NetworkMode): boolean | undefined {
  if (target === 'wan') return true
  if (probeUnsupported.value) return undefined
  if (probedCount.value === 0) return undefined
  const entries = Object.values(network.probeStatus)
  const anyReachable = entries.some((e) => e.reachable === true)
  return anyReachable
}

const hints = computed(() =>
  MODES.map((m) => ({
    value: m,
    label: MODE_LABEL[m],
    hint: MODE_HINT[m],
    state: dotState(m),
  })),
)

function select(next: NetworkMode): void {
  if (next === mode.value) return
  network.setMode(next)
  emit('change', next)
}
</script>

<template>
  <div class="net-switch" role="radiogroup" aria-label="网络模式">
    <button
      v-for="m in hints"
      :key="m.value"
      class="seg"
      :class="{ active: mode === m.value }"
      role="radio"
      :aria-checked="mode === m.value"
      :title="`${m.hint}（Ctrl/Cmd + Shift + N 循环切换）`"
      :disabled="probing && m.value !== 'wan' && m.state === undefined"
      @click="select(m.value)"
    >
      <StatusDot :state="m.state" />
      <span>{{ m.label }}</span>
    </button>
  </div>
</template>

<style scoped>
/* 三态分段控件：外壳是一层比卡片更淡的色块，选中项用实色块点亮。
   没有任何边框线，段与段的区分全靠留白和色阶。 */
.net-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 0;
  border-radius: var(--r-sm);
  background: var(--field);
}

.seg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
  white-space: nowrap;
}

.seg:hover:not(:disabled) {
  color: var(--text);
  background: var(--hover);
}

.seg.active {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 3px 10px -3px color-mix(in srgb, var(--accent) 65%, transparent);
}

.seg.active:hover:not(:disabled) {
  color: #fff;
}

.seg:disabled {
  opacity: 0.42;
  cursor: progress;
}
</style>
