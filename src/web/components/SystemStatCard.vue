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

const props = withDefaults(
  defineProps<{
    kind: MonitorCardKind
    /** 该卡对应的设备：disk=挂载点 / network=网卡名 / gpu=设备序号；整机类为空 */
    device?: string
    /** 与 ui.cardSize 设置对应，和 App 卡片共用同一套尺寸 */
    size?: 'sm' | 'md' | 'lg'
    /** 移除按钮的 tooltip 文案 */
    removeTitle?: string
    /** 编辑模式：为 true 时才渲染右上角移除角标 */
    editing?: boolean
  }>(),
  { size: 'md' },
)

/** 图标随卡片尺寸缩放，和 ItemCard 的图标尺寸策略一致 */
const iconSize = computed(() => (props.size === 'sm' ? 14 : props.size === 'lg' ? 20 : 18))

const emit = defineEmits<{ (e: 'open'): void; (e: 'remove'): void }>()

/** 只在卡片自身聚焦时响应回车/空格，避免移除按钮上的按键冒泡触发详情 */
function onActivate(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return
  event.preventDefault()
  emit('open')
}

const monitor = useMonitorStore()

const meta = computed(() => STAT_CARD_META[props.kind])
const snap = computed(() => monitor.latest)

const disk = computed(() =>
  props.kind === 'disk' && props.device
    ? ((snap.value?.disks ?? []).find((d) => d.mount === props.device) ?? null)
    : null,
)
const diskStatic = computed(() =>
  props.kind === 'disk' && props.device
    ? ((monitor.staticInfo?.disks ?? []).find((d) => d.mount === props.device) ?? null)
    : null,
)

/** 该卡对应的网卡（一张卡一台设备） */
const netIface = computed(() =>
  props.kind === 'network' && props.device
    ? ((snap.value?.net ?? []).find((n) => n.iface === props.device) ?? null)
    : null,
)
const netFlow = computed(() =>
  netIface.value ? netIface.value.rxBps + netIface.value.txBps : 0,
)
const rxShare = computed(() =>
  netFlow.value > 0 ? ((netIface.value?.rxBps ?? 0) / netFlow.value) * 100 : 0,
)
const txShare = computed(() =>
  netFlow.value > 0 ? ((netIface.value?.txBps ?? 0) / netFlow.value) * 100 : 0,
)

/** 上下行单位相同时只写一个（"↓34.2 ↑72.2 KB/s"），窄卡片里放得下 */
const netValue = computed<string>(() => {
  const n = netIface.value
  if (!n) return '—'
  const rx = fmtRate(n.rxBps)
  const tx = fmtRate(n.txBps)
  const [rn, ru] = rx.split(' ')
  const [tn, tu] = tx.split(' ')
  if (rn && tn && ru && ru === tu) return `↓${rn} ↑${tn} ${ru}`
  return `↓ ${rx} ↑ ${tx}`
})

// ── GPU：这张卡对应一台设备 ─────────────────────────────────

const gpuSnap = computed(() => {
  const list = snap.value?.gpus ?? []
  if (props.device === undefined) return list[0] ?? null
  return list.find((g) => String(g.index) === props.device) ?? null
})
const gpuStatic = computed(() => {
  const list = monitor.staticInfo?.gpus ?? []
  if (props.device === undefined) return list[0] ?? null
  return list.find((g) => String(g.index) === props.device) ?? null
})

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
      // Apple Silicon：显存与内存共享，没有固定上限，只能显示已用
      if (g.memoryUsed !== null) return fmtBytes(g.memoryUsed)
      if (g.memoryUtilization !== null) return pct(g.memoryUtilization)
    }
  }
  // available 为空（macOS / Apple Silicon 的常态）：静态信息就是全部可用信息
  return gpuStatic.value?.model ?? '静态信息'
})

// ── 卡片文案 ─────────────────────────────────────────────────

const label = computed(() => {
  switch (props.kind) {
    case 'disk':
      return props.device ?? '/'
    case 'network':
      return props.device ?? meta.value.label
    case 'gpu':
      return props.device === undefined ? meta.value.label : `GPU #${props.device}`
    default:
      return meta.value.label
  }
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
      return netValue.value
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
  <div
    class="stat-card"
    :class="`size-${size}`"
    data-glass-card
    role="button"
    tabindex="0"
    :aria-label="`${meta.title}：${label} ${value}`"
    :title="`查看${meta.title}详情`"
    @click="emit('open')"
    @keydown.enter="onActivate"
    @keydown.space="onActivate"
  >
    <button
      v-if="editing"
      class="stat-remove"
      type="button"
      :title="removeTitle ?? '移除卡片'"
      aria-label="移除卡片"
      @click.stop="emit('remove')"
    >
      <FaviconGlyph name="close" :size="12" />
    </button>

    <span class="stat-icon"><FaviconGlyph :name="meta.icon" :size="iconSize" /></span>

    <span class="stat-body">
      <span class="stat-row">
        <span class="stat-label">{{ label }}</span>
        <span class="stat-value mono" :class="{ compact: kind === 'network' }">
          {{ kind === 'network' ? netValue : value }}
        </span>
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
  </div>
</template>

<style scoped>
/* 与 App 卡片同一张白玻璃，区别只在内容密度：数值靠右、下面一条 4px 轨道 */
.stat-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 70px;
  padding: 12px 13px;
  font: inherit;
  text-align: left;
  color: var(--text);
  border: 0;
  border-radius: var(--r-xl);
  background: var(--card-bg);
  backdrop-filter: var(--glass);
  box-shadow: var(--shadow-1);
  cursor: pointer;
  transition: background 0.16s ease, box-shadow 0.16s ease;
}

/* hover 只高亮不位移：与 App 卡片保持一致，避免卡片在鼠标下跳动 */
.stat-card:hover {
  background: var(--card-bg-hi);
  box-shadow: var(--shadow-2);
}

.stat-card:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 34%, transparent), var(--shadow-2);
}

/* 紧凑档：列宽被压到 150px，横向放不下「标签 + 数值」，
   改成上面标签、下面数值的堆叠版式，数值独占整行宽度，不再被截断 */
.size-sm {
  height: 58px;
  padding: 8px 11px;
  gap: 6px;
}

.size-sm .stat-body {
  gap: 5px;
}

.size-sm .stat-row {
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 0;
}

.size-sm .stat-label {
  font-size: 11px;
  line-height: 1.25;
}

.size-sm .stat-value {
  max-width: 100%;
  font-size: 13px;
  line-height: 1.25;
}

.size-sm .stat-value.compact {
  font-size: 11px;
}

.size-lg {
  height: 86px;
  padding: 15px 15px;
  gap: 12px;
}

.size-lg .stat-value {
  font-size: 15px;
}

/* 移除角标：仅在编辑模式渲染，悬出卡片右上角，避免压住数值 */
.stat-remove {
  position: absolute;
  top: -7px;
  right: -7px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-2);
  box-shadow: var(--shadow-2);
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

.stat-remove:hover,
.stat-remove:focus-visible {
  background: var(--err);
  color: #fff;
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
  gap: 8px;
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
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stat-value.compact {
  font-size: 12px;
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
