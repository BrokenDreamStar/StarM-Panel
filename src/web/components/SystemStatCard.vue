<script setup lang="ts">
/**
 * 紧凑硬件卡片 —— 「系统状态」区的一格。
 *
 * 版式对齐 Sun-Panel 参考图：左侧图标 + 上排「标签 …… 数值」+ 下排一条细进度条。
 * 数据只读消费 monitor store；本组件不做任何请求。
 *
 * 进度条配色由 barLevel 决定（>=75% 警告、>=90% 危险）。
 * 没有「比例」语义的卡片（system / 无可比指标的 GPU）**不画空进度条**，
 * 靠统一的 min-height 保持整排高度一致。
 */
import { computed } from 'vue'
import { useMonitorStore } from '@/stores/monitor'
import { useSettingsStore } from '@/stores/settings'
import type { MonitorCardKind } from '@/api/settings'
import {
  barLevel,
  clampPct,
  fmtBytes,
  fmtBytesPair,
  fmtRate,
  fmtUptime,
  pct,
  ratioPct,
} from '@/utils/format'
import { STAT_CARD_META } from '@/composables/useStatCards'
import FaviconGlyph from './FaviconGlyph.vue'

const props = defineProps<{
  kind: MonitorCardKind
  /** 仅 disk 卡：该卡对应的挂载点 */
  mount?: string
}>()

const emit = defineEmits<{ (e: 'open'): void }>()

const monitor = useMonitorStore()
const settings = useSettingsStore()

const meta = computed(() => STAT_CARD_META[props.kind])
const snap = computed(() => monitor.latest)

const disk = computed(() =>
  props.kind === 'disk' && props.mount
    ? ((snap.value?.disks ?? []).find((d) => d.mount === props.mount) ?? null)
    : null,
)
const diskStatic = computed(() =>
  props.kind === 'disk' && props.mount
    ? ((monitor.staticInfo?.disks ?? []).find((d) => d.mount === props.mount) ?? null)
    : null,
)

const netIfaces = computed(() => monitor.netFiltered(settings.monitorNetIfaces))
const totalRx = computed(() => netIfaces.value.reduce((sum, n) => sum + n.rxBps, 0))
const totalTx = computed(() => netIfaces.value.reduce((sum, n) => sum + n.txBps, 0))
const netFlow = computed(() => totalRx.value + totalTx.value)
const rxShare = computed(() =>
  netFlow.value > 0 ? (totalRx.value / netFlow.value) * 100 : 0,
)
const txShare = computed(() =>
  netFlow.value > 0 ? (totalTx.value / netFlow.value) * 100 : 0,
)

// ── GPU：只有一个设备时它的指标就是这张卡的值 ──────────────────

const gpuSnap = computed(() => snap.value?.gpus[0] ?? null)
const gpuStatic = computed(() => monitor.staticInfo?.gpus[0] ?? null)
const gpuCount = computed(
  () => snap.value?.gpus.length ?? monitor.staticInfo?.gpus.length ?? 0,
)

const gpuRatio = computed<number | null>(() => {
  const g = gpuSnap.value
  if (!g) return null
  if (g.available.includes('utilization') && g.utilization !== null) return g.utilization
  if (g.available.includes('memory') && g.memoryUtilization !== null) return g.memoryUtilization
  return null
})

const gpuValue = computed(() => {
  const g = gpuSnap.value
  if (g) {
    if (g.available.includes('utilization') && g.utilization !== null) return pct(g.utilization)
    if (g.available.includes('memory')) {
      if (g.memoryUsed !== null && g.memoryTotal !== null) {
        return fmtBytesPair(g.memoryUsed, g.memoryTotal)
      }
      if (g.memoryUtilization !== null) return pct(g.memoryUtilization)
    }
  }
  // available 为空（macOS / Apple Silicon 的常态）：静态信息就是全部可用信息
  return gpuStatic.value?.model ?? '静态信息'
})

// ── 卡片文案 ─────────────────────────────────────────────────

const label = computed(() => {
  if (props.kind === 'disk') return props.mount ?? '/'
  if (props.kind === 'gpu' && gpuCount.value > 1) return `${meta.value.label} ×${gpuCount.value}`
  return meta.value.label
})

const value = computed<string>(() => {
  switch (props.kind) {
    case 'cpu':
      return pct(snap.value?.cpu.usage)
    case 'memory':
      return fmtBytesPair(snap.value?.mem.used, snap.value?.mem.total)
    case 'disk': {
      if (disk.value) return fmtBytesPair(disk.value.used, disk.value.total)
      // 只有静态信息：容量可信，占用未知
      if (diskStatic.value) return `—/${fmtBytes(diskStatic.value.size)}`
      return '—'
    }
    case 'network':
      return `↓ ${fmtRate(totalRx.value)} ↑ ${fmtRate(totalTx.value)}`
    case 'gpu':
      return gpuValue.value
    case 'system':
      return fmtUptime(snap.value?.system.uptime)
    default:
      return '—'
  }
})

const ratio = computed<number | null>(() => {
  switch (props.kind) {
    case 'cpu':
      return snap.value?.cpu.usage ?? null
    case 'memory':
      return snap.value?.mem.total ? monitor.memPercent : null
    case 'disk':
      return disk.value ? ratioPct(disk.value.used, disk.value.total) : null
    case 'gpu':
      return gpuRatio.value
    default:
      return null
  }
})
</script>

<template>
  <button
    class="stat-card"
    data-glass-card
    type="button"
    :aria-label="`${meta.title}：${label} ${value}`"
    :title="`查看${meta.title}详情`"
    @click="emit('open')"
  >
    <span class="stat-icon"><FaviconGlyph :name="meta.icon" :size="18" /></span>

    <span class="stat-body">
      <span class="stat-row">
        <span class="stat-label">{{ label }}</span>
        <span class="stat-value mono" :class="{ compact: kind === 'network' }">{{ value }}</span>
      </span>

      <!-- 网络没有「占用率」语义：用下行/上行占比的分段条代替 -->
      <span v-if="kind === 'network'" class="track track-split">
        <i class="fill-rx" :style="{ width: `${rxShare}%` }" />
        <i class="fill-tx" :style="{ width: `${txShare}%` }" />
      </span>
      <span v-else-if="ratio !== null" class="track">
        <i class="fill" :class="barLevel(ratio)" :style="{ width: `${clampPct(ratio)}%` }" />
      </span>
    </span>
  </button>
</template>

<style scoped>
/* 与 App 卡片同一张白玻璃，区别只在内容密度：数值靠右、下面一条 4px 轨道 */
.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 68px;
  padding: 12px 15px;
  font: inherit;
  text-align: left;
  color: var(--text);
  border: 0;
  border-radius: var(--r-md);
  background: var(--card-bg);
  backdrop-filter: var(--glass);
  -webkit-backdrop-filter: var(--glass);
  box-shadow: var(--shadow-1);
  cursor: pointer;
  transition: transform 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
}

.stat-card:hover {
  transform: translateY(-1px);
  background: var(--card-bg-hi);
  box-shadow: var(--shadow-2);
}

.stat-card:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 34%, transparent), var(--shadow-2);
}

.stat-icon {
  display: inline-flex;
  flex: none;
  color: var(--text-2);
  opacity: 0.9;
}

.stat-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.stat-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-2);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stat-value {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.stat-value.compact {
  font-size: 12.5px;
  font-weight: 550;
}

.track {
  display: block;
  height: 4px;
  border-radius: var(--r-xs);
  background: var(--track);
  overflow: hidden;
}

.track-split {
  display: flex;
}

.fill {
  display: block;
  height: 100%;
  border-radius: var(--r-xs);
  background: var(--accent);
  transition: width 0.3s ease;
}

.fill.warn {
  background: var(--warn);
}

.fill.err {
  background: var(--err);
}

.fill-rx,
.fill-tx {
  display: block;
  height: 100%;
  transition: width 0.3s ease;
}

.fill-rx {
  background: var(--ok);
}

.fill-tx {
  background: var(--warn);
}
</style>
