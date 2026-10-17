<script setup lang="ts">
/**
 * 硬件详情弹窗 —— 点击「系统状态」卡片打开。
 *
 * 内容按卡片类型分流，数据只读消费 monitor store 与 /api/system/info。
 *
 * GPU 是硬性验收点：
 *   1. 只渲染 `gpus[i].available` 里真实存在的指标（不同厂商暴露的差异极大）
 *   2. `available` 为空数组时（macOS / Apple Silicon 的常态）只显示静态信息
 *      + 一行「该平台不暴露 GPU 动态指标」，**不渲染任何图表元素**
 *   3. 本文件刻意不使用 Sparkline / 任何 `.spark-svg` 图表，因此该弹窗内
 *      图表类 DOM 数量恒为 0
 */
import { computed } from 'vue'
import { NModal } from 'naive-ui'
import { useMonitorStore } from '@/stores/monitor'
import { STAT_CARD_META, type StatCardRef } from '@/composables/useStatCards'
import { TEXT as T } from '@shared/text'
import type { GpuMetric, GpuSnapshot, GpuStaticInfo } from '@shared/types'
import {
  barLevel,
  clampPct,
  fmtBytes,
  fmtBytesPair,
  fmtDiskRate,
  fmtGhz,
  fmtMhz,
  fmtRate,
  fmtUptime,
  pct,
  ratioPct,
} from '@/utils/format'
import FaviconGlyph from './FaviconGlyph.vue'

const props = defineProps<{
  show: boolean
  /** 被点开的卡片；null = 还没点过任何卡片 */
  card: StatCardRef | null
}>()

const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const monitor = useMonitorStore()

const open = computed({
  get: () => props.show,
  set: (v: boolean) => emit('update:show', v),
})

const kind = computed(() => props.card?.kind ?? 'system')
const device = computed(() => props.card?.device ?? '')
const meta = computed(() => STAT_CARD_META[kind.value])

// ── 数据源 ───────────────────────────────────────────────────

const snap = computed(() => monitor.latest)
const stat = computed(() => monitor.staticInfo)

const cpu = computed(() => snap.value?.cpu ?? null)
const cpuTemp = computed(() => cpu.value?.temp ?? null)
const mem = computed(() => snap.value?.mem ?? null)
const sys = computed(() => snap.value?.system ?? null)

const diskInfo = computed(
  () => (snap.value?.disks ?? []).find((d) => d.mount === device.value) ?? null,
)
const statDisk = computed(
  () => (stat.value?.disks ?? []).find((d) => d.mount === device.value) ?? null,
)

/** 该卡对应的网卡；device 为空时（防御）回落到全部 */
const netIfaces = computed(() => {
  if (device.value) return (snap.value?.net ?? []).filter((n) => n.iface === device.value)
  return snap.value?.net ?? []
})
function netStatic(iface: string) {
  return stat.value?.net.find((n) => n.iface === iface) ?? null
}

/** CPU 负载 1/5/15 */
const loadText = computed(() => {
  const l = cpu.value?.load
  if (!l) return '—'
  return l.map((v) => v.toFixed(2)).join(' / ')
})

/** 内存分段：已用 / 缓存（= total - used - free）/ 空闲 */
const memSegments = computed(() => {
  const m = mem.value
  if (!m || m.total <= 0) return []
  const cached = Math.max(0, m.total - m.used - m.free)
  const segs = [
    { key: 'used', label: T.detail.used, bytes: m.used, cls: 'used' },
    ...(cached > 0
      ? [{ key: 'cached', label: T.detail.cached, bytes: cached, cls: 'cached' }]
      : []),
    { key: 'free', label: T.detail.free, bytes: m.free, cls: 'free' },
  ]
  return segs.map((s) => ({ ...s, ratio: (s.bytes / m.total) * 100 }))
})
const memCachedRatio = computed(
  () => memSegments.value.find((s) => s.key === 'cached')?.ratio ?? 0,
)

// ── GPU：按 available 动态渲染 ────────────────────────────────

interface GpuView {
  index: number
  vendor: string
  model: string
  /** 该设备真实可用的指标名；空数组 = 该平台不暴露动态指标 */
  available: GpuMetric[]
  snap: GpuSnapshot | null
  stat: GpuStaticInfo | null
}

const gpuViewsAll = computed<GpuView[]>(() => {
  const snaps = snap.value?.gpus ?? []
  const staticGpus = stat.value?.gpus ?? []
  if (snaps.length > 0) {
    return snaps.map((s) => ({
      index: s.index,
      vendor: s.vendor,
      model: s.model,
      available: s.available,
      snap: s,
      stat: staticGpus.find((g) => g.index === s.index) ?? null,
    }))
  }
  // 只有静态信息（首帧 / 未开启 GPU 采样）：available 视为空，绝不猜图表
  return staticGpus.map((g) => ({
    index: g.index,
    vendor: g.vendor,
    model: g.model,
    available: [] as GpuMetric[],
    snap: null,
    stat: g,
  }))
})

/** 该卡对应的 GPU（device = 设备序号）；device 为空时（防御）列出全部 */
const gpuViews = computed<GpuView[]>(() => {
  const list = gpuViewsAll.value
  if (!device.value) return list
  return list.filter((g) => String(g.index) === device.value)
})

/** 指标名直接取自文案表，键与 GpuMetric 一一对应 */
const GPU_METRIC_LABELS: Record<GpuMetric, string> = T.detail.gpuMetric

interface MetricRow {
  key: GpuMetric
  label: string
  value: string
  ratio: number | null
}

/** 只遍历 available —— 不在列表里的指标一律不出现 */
function gpuMetrics(gpu: GpuView): MetricRow[] {
  const s = gpu.snap
  if (!s) return []
  const out: MetricRow[] = []
  for (const key of gpu.available) {
    switch (key) {
      case 'utilization':
        if (s.utilization === null) break
        out.push({ key, label: GPU_METRIC_LABELS[key], value: pct(s.utilization), ratio: s.utilization })
        break
      case 'memory': {
        if (s.memoryUsed === null && s.memoryUtilization === null) break
        const value =
          s.memoryUsed !== null && s.memoryTotal !== null
            ? fmtBytesPair(s.memoryUsed, s.memoryTotal)
            : s.memoryUsed !== null
              ? fmtBytes(s.memoryUsed)
              : pct(s.memoryUtilization)
        out.push({ key, label: GPU_METRIC_LABELS[key], value, ratio: s.memoryUtilization })
        break
      }
      case 'temperature':
        if (s.temperature === null) break
        out.push({ key, label: GPU_METRIC_LABELS[key], value: `${s.temperature} °C`, ratio: null })
        break
      case 'power':
        if (s.powerDraw === null) break
        out.push({
          key,
          label: GPU_METRIC_LABELS[key],
          value: s.powerLimit !== null ? `${s.powerDraw} W / ${s.powerLimit} W` : `${s.powerDraw} W`,
          ratio: s.powerLimit ? (s.powerDraw / s.powerLimit) * 100 : null,
        })
        break
      case 'fan':
        if (s.fanSpeed === null) break
        out.push({ key, label: GPU_METRIC_LABELS[key], value: pct(s.fanSpeed, 0), ratio: s.fanSpeed })
        break
      case 'clock':
        if (s.clockCore === null && s.clockMemory === null) break
        out.push({
          key,
          label: GPU_METRIC_LABELS[key],
          value:
            s.clockCore !== null
              ? `${fmtMhz(s.clockCore)}${s.clockMemory !== null ? ` / ${fmtMhz(s.clockMemory)}` : ''}`
              : fmtMhz(s.clockMemory),
          ratio: null,
        })
        break
    }
  }
  return out
}

function gpuVram(gpu: GpuView): string {
  const total = gpu.snap?.memoryTotal
  if (typeof total === 'number') return fmtBytes(total)
  const vram = gpu.stat?.vram
  if (typeof vram === 'number') {
    return gpu.stat?.vramDynamic ? T.detail.sharedWithMemory(fmtBytes(vram)) : fmtBytes(vram)
  }
  // Apple Silicon：有已用、无上限，显式说明是共享内存
  const used = gpu.snap?.memoryUsed
  if (typeof used === 'number') return T.detail.usedSharedWithMemory(fmtBytes(used))
  return T.common.unknown
}

// ── 文案 ─────────────────────────────────────────────────────

const title = computed(() =>
  kind.value === 'disk'
    ? T.detail.diskTitle(device.value)
    : T.detail.detailTitle(meta.value.title),
)

const subtitle = computed(() => {
  switch (kind.value) {
    case 'cpu':
      return stat.value?.cpu.brand || T.detail.processor
    case 'memory':
      return T.detail.memorySwap
    case 'disk':
      return diskInfo.value?.type || statDisk.value?.type || T.detail.diskUsage
    case 'network':
      return device.value || T.detail.netifaceCount(netIfaces.value.length)
    case 'gpu':
      return gpuViews.value[0]?.model || T.detail.gpuCount(gpuViews.value.length)
    default:
      return stat.value
        ? `${stat.value.os.distro || stat.value.os.platform} · ${stat.value.os.hostname}`
        : T.detail.hostInfo
  }
})

interface InfoRow {
  label: string
  value: string
}

const infoRows = computed<InfoRow[]>(() => {
  switch (kind.value) {
    case 'cpu': {
      const s = stat.value?.cpu
      return [
        { label: T.detail.kv.model, value: s?.brand || '—' },
        { label: T.detail.kv.manufacturer, value: s?.manufacturer || '—' },
        {
          label: T.detail.kv.coresThreads,
          value: s ? T.detail.kv.coresThreadsValue(s.physicalCores, s.cores) : '—',
        },
        { label: T.detail.kv.speed, value: s ? fmtGhz(s.speed) : '—' },
      ]
    }
    case 'memory': {
      return [
        // 说明：/api/system/info 目前没有内存字段，总量只能来自实时采样数据
        { label: T.detail.kv.totalMemory, value: fmtBytes(mem.value?.total) },
        { label: T.detail.kv.free, value: fmtBytes(mem.value?.free) },
        { label: T.detail.kv.available, value: fmtBytes(mem.value?.available) },
        { label: T.detail.swap, value: fmtBytesPair(mem.value?.swapUsed, mem.value?.swapTotal) },
      ]
    }
    case 'disk': {
      const d = diskInfo.value
      const s = statDisk.value
      const total = d?.total ?? s?.size ?? null
      return [
        { label: T.detail.kv.mount, value: device.value || '—' },
        { label: T.detail.kv.fileSystem, value: d?.type || s?.type || '—' },
        { label: T.detail.kv.device, value: d?.fs || s?.fs || '—' },
        { label: T.detail.kv.totalCapacity, value: fmtBytes(total) },
        { label: T.detail.kv.used, value: d ? fmtBytes(d.used) : '—' },
        { label: T.detail.kv.available, value: d ? fmtBytes(Math.max(0, d.total - d.used)) : '—' },
        { label: T.detail.kv.readRate, value: fmtDiskRate(d?.readBps) },
        { label: T.detail.kv.writeRate, value: fmtDiskRate(d?.writeBps) },
      ]
    }
    case 'system': {
      const s = stat.value
      return [
        { label: T.detail.kv.hostname, value: s?.os.hostname || '—' },
        { label: T.detail.kv.distro, value: s ? s.os.distro || s.os.platform : '—' },
        { label: T.detail.kv.kernel, value: s?.os.kernel || s?.os.release || '—' },
        { label: T.detail.kv.arch, value: s?.os.arch || '—' },
        { label: T.detail.kv.uptime, value: fmtUptime(sys.value?.uptime) },
        { label: T.detail.kv.processes, value: sys.value ? String(sys.value.processes) : '—' },
        { label: T.detail.kv.users, value: sys.value ? String(sys.value.users) : '—' },
        { label: T.detail.kv.cpuModel, value: s?.cpu.brand || '—' },
        { label: T.detail.kv.memoryTotal, value: fmtBytes(mem.value?.total) },
      ]
    }
    default:
      return []
  }
})

/** CPU 最近采样的横向条形历史（用 div 而非 SVG，避免图表元素混入） */
const cpuHistory = computed(() => monitor.trendCpu.slice(-40))

// ── 整句文案：原文由插值/换行切开，这里合成一条后整体插值 ──────────

/** CPU 负载 chip */
const loadChipText = computed(() => `${T.detail.loadPrefix}${loadText.value}`)

/** CPU 实时频率 chip */
const liveSpeedText = computed(() => `${T.detail.live} ${fmtGhz(cpu.value?.speed)}`)

/** 系统块的「实时采样时间」整句（zh-CN 是 locale 标识，不是文案） */
const sampleTimeText = computed(() => {
  const time = snap.value
    ? new Date(snap.value.ts).toLocaleTimeString('zh-CN', { hour12: false })
    : '—'
  return `${T.detail.sampleTime} ${time}`
})
</script>

<template>
  <NModal
    v-model:show="open"
    preset="card"
    size="small"
    :bordered="false"
    :style="{ width: '580px', maxWidth: '94vw' }"
  >
    <template #header>
      <div class="detail-head">
        <span class="detail-icon"><FaviconGlyph :name="meta.icon" :size="17" /></span>
        <span class="detail-titles">
          <strong>{{ title }}</strong>
          <span v-if="subtitle" class="detail-sub dim">{{ subtitle }}</span>
        </span>
      </div>
    </template>

    <div class="detail-body">
      <p v-if="!snap && !stat" class="dim">{{ T.detail.loading }}</p>

      <!-- ── CPU ────────────────────────────────────────────── -->
      <template v-else-if="kind === 'cpu'">
        <div class="metric">
          <div class="metric-row">
            <span class="metric-label">{{ T.detail.cpuTotal }}</span>
            <span class="metric-value mono">{{ pct(cpu?.usage) }}</span>
          </div>
          <div class="track lg">
            <i
              class="fill"
              :class="barLevel(cpu?.usage)"
              :style="{ width: `${clampPct(cpu?.usage)}%` }"
            />
          </div>
        </div>

        <div class="chips">
          <span class="chip mono">{{ loadChipText }}</span>
          <!-- temp 为 null 时整项不显示（而不是显示一个假温度） -->
          <span v-if="cpuTemp !== null" class="chip mono">
            {{ T.detail.gpuMetric.temperature }} {{ cpuTemp }} °C
          </span>
          <span v-if="cpu?.speed !== null && cpu?.speed !== undefined" class="chip mono">
            {{ liveSpeedText }}
          </span>
          <span class="chip mono">{{ T.detail.cores(cpu?.perCore.length ?? 0) }}</span>
        </div>

        <template v-if="(cpu?.perCore.length ?? 0) > 0">
          <h4 class="sub-title">{{ T.detail.perCore }}</h4>
          <div class="cores">
            <div v-for="(core, i) in cpu?.perCore ?? []" :key="i" class="core">
              <span class="core-name mono">#{{ i }}</span>
              <span class="track core-track">
                <i
                  class="fill"
                  :class="barLevel(core)"
                  :style="{ width: `${clampPct(core)}%` }"
                />
              </span>
              <span class="core-val mono">{{ core.toFixed(0) }}%</span>
            </div>
          </div>
        </template>

        <template v-if="cpuHistory.length > 1">
          <h4 class="sub-title">{{ T.detail.recentSamples(cpuHistory.length) }}</h4>
          <div class="history">
            <span
              v-for="(v, i) in cpuHistory"
              :key="i"
              class="hist-col"
              :class="barLevel(v)"
              :style="{ height: `${Math.max(6, clampPct(v))}%` }"
              :title="`${v.toFixed(1)}%`"
            />
          </div>
        </template>

        <h4 class="sub-title">{{ T.statCard.staticInfo }}</h4>
        <div class="kv-grid">
          <div v-for="row in infoRows" :key="row.label" class="kv">
            <span class="dim">{{ row.label }}</span>
            <span class="mono">{{ row.value }}</span>
          </div>
        </div>
      </template>

      <!-- ── 内存 ───────────────────────────────────────────── -->
      <template v-else-if="kind === 'memory'">
        <div class="metric">
          <div class="metric-row">
            <span class="metric-label">{{ T.detail.usedOfTotal }}</span>
            <span class="metric-value mono">{{ pct(monitor.memPercent) }}</span>
          </div>
          <div class="segbar">
            <i class="seg used" :style="{ width: `${clampPct(monitor.memPercent)}%` }" />
            <i
              v-if="memCachedRatio > 0"
              class="seg cached"
              :style="{ width: `${clampPct(memCachedRatio)}%` }"
            />
          </div>
          <div class="legend">
            <span v-for="seg in memSegments" :key="seg.key" class="legend-item">
              <i class="legend-dot" :class="seg.cls" />
              <span class="dim">{{ seg.label }}</span>
              <span class="mono">{{ fmtBytes(seg.bytes) }}</span>
            </span>
          </div>
          <p class="mono sub-line">
            {{ fmtBytesPair(mem?.used, mem?.total) }}
          </p>
        </div>

        <template v-if="(mem?.swapTotal ?? 0) > 0">
          <h4 class="sub-title">{{ T.detail.swap }}</h4>
          <div class="metric">
            <div class="metric-row">
              <span class="metric-label">{{ fmtBytesPair(mem?.swapUsed, mem?.swapTotal) }}</span>
              <span class="metric-value mono sm">{{ pct(monitor.swapPercent) }}</span>
            </div>
            <div class="track">
              <i
                class="fill"
                :class="barLevel(monitor.swapPercent)"
                :style="{ width: `${clampPct(monitor.swapPercent)}%` }"
              />
            </div>
          </div>
        </template>

        <h4 class="sub-title">{{ T.statCard.staticInfo }}</h4>
        <div class="kv-grid">
          <div v-for="row in infoRows" :key="row.label" class="kv">
            <span class="dim">{{ row.label }}</span>
            <span class="mono">{{ row.value }}</span>
          </div>
        </div>
      </template>

      <!-- ── 磁盘（每个挂载点一张卡，各自详情）─────────────── -->
      <template v-else-if="kind === 'disk'">
        <div class="metric">
          <div class="metric-row">
            <span class="metric-label">{{ device }}</span>
            <span class="metric-value mono">
              {{ diskInfo ? pct(ratioPct(diskInfo.used, diskInfo.total)) : '—' }}
            </span>
          </div>
          <div class="track lg">
            <i
              class="fill"
              :class="barLevel(ratioPct(diskInfo?.used, diskInfo?.total))"
              :style="{ width: `${clampPct(ratioPct(diskInfo?.used, diskInfo?.total))}%` }"
            />
          </div>
          <p class="mono sub-line">
            {{ diskInfo ? fmtBytesPair(diskInfo.used, diskInfo.total) : T.detail.waiting }}
          </p>
        </div>

        <h4 class="sub-title">{{ T.detail.capacityDevices }}</h4>
        <div class="kv-grid">
          <div v-for="row in infoRows" :key="row.label" class="kv">
            <span class="dim">{{ row.label }}</span>
            <span class="mono">{{ row.value }}</span>
          </div>
        </div>
      </template>

      <!-- ── 网络 ───────────────────────────────────────────── -->
      <template v-else-if="kind === 'network'">
        <p v-if="netIfaces.length === 0" class="dim">{{ T.detail.noNetifaces }}</p>
        <div v-for="n in netIfaces" :key="n.iface" class="iface">
          <div class="metric-row">
            <span class="iface-name mono">{{ n.iface }}</span>
            <span class="mono dim">{{ netStatic(n.iface)?.ip4 || T.detail.noIp }}</span>
          </div>
          <div class="kv-grid">
            <div class="kv">
              <span class="dim">{{ T.detail.down }}</span>
              <span class="mono">{{ fmtRate(n.rxBps) }}</span>
            </div>
            <div class="kv">
              <span class="dim">{{ T.detail.up }}</span>
              <span class="mono">{{ fmtRate(n.txBps) }}</span>
            </div>
            <div class="kv">
              <span class="dim">{{ T.detail.bytesReceived }}</span>
              <span class="mono">{{ fmtBytes(n.rxTotal) }}</span>
            </div>
            <div class="kv">
              <span class="dim">{{ T.detail.bytesSent }}</span>
              <span class="mono">{{ fmtBytes(n.txTotal) }}</span>
            </div>
            <div v-if="netStatic(n.iface)?.mac" class="kv">
              <span class="dim">{{ T.detail.mac }}</span>
              <span class="mono">{{ netStatic(n.iface)?.mac }}</span>
            </div>
            <div v-if="netStatic(n.iface)?.speed" class="kv">
              <span class="dim">{{ T.detail.linkSpeed }}</span>
              <span class="mono">{{ netStatic(n.iface)?.speed }} Mbit/s</span>
            </div>
          </div>
        </div>
      </template>

      <!-- ── GPU ────────────────────────────────────────────── -->
      <template v-else-if="kind === 'gpu'">
        <p v-if="gpuViews.length === 0" class="dim">{{ T.detail.noGpu }}</p>

        <div v-for="gpu in gpuViews" :key="gpu.index" class="gpu">
          <div class="metric-row">
            <span class="gpu-name">{{ gpu.model }}</span>
            <span class="mono dim">#{{ gpu.index }} · {{ gpu.vendor }}</span>
          </div>

          <!-- available 为空：只有静态信息，一行明确说明，绝不渲染空图表 -->
          <template v-if="gpu.available.length === 0">
            <p class="gpu-note">{{ T.detail.gpuNoMetrics }}</p>
            <div class="kv-grid">
              <div class="kv">
                <span class="dim">{{ T.detail.model }}</span>
                <span class="mono">{{ gpu.model }}</span>
              </div>
              <div class="kv">
                <span class="dim">{{ T.detail.manufacturer }}</span>
                <span class="mono">{{ gpu.stat?.vendor || gpu.vendor }}</span>
              </div>
              <div class="kv">
                <span class="dim">{{ T.detail.vram }}</span>
                <span class="mono">{{ gpuVram(gpu) }}</span>
              </div>
              <div class="kv">
                <span class="dim">{{ T.detail.driver }}</span>
                <span class="mono">{{ gpu.stat?.driverVersion || T.common.unknown }}</span>
              </div>
              <div class="kv">
                <span class="dim">{{ T.detail.bus }}</span>
                <span class="mono">{{ gpu.stat?.bus || T.common.unknown }}</span>
              </div>
            </div>
            <p class="dim tiny">{{ T.detail.gpuNote }}</p>
          </template>

          <!-- 有指标：只渲染 available 里列出的 -->
          <template v-else>
            <div v-for="m in gpuMetrics(gpu)" :key="m.key" class="metric">
              <div class="metric-row">
                <span class="metric-label">{{ m.label }}</span>
                <span class="metric-value mono sm">{{ m.value }}</span>
              </div>
              <div v-if="m.ratio !== null" class="track">
                <i
                  class="fill"
                  :class="barLevel(m.ratio)"
                  :style="{ width: `${clampPct(m.ratio)}%` }"
                />
              </div>
            </div>
          </template>
        </div>
      </template>

      <!-- ── 系统 ───────────────────────────────────────────── -->
      <template v-else>
        <div class="metric">
          <div class="metric-row">
            <span class="metric-label">{{ T.detail.runtime }}</span>
            <span class="metric-value mono">{{ fmtUptime(sys?.uptime) }}</span>
          </div>
        </div>

        <h4 class="sub-title">{{ T.detail.hostInfo }}</h4>
        <div class="kv-grid">
          <div v-for="row in infoRows" :key="row.label" class="kv">
            <span class="dim">{{ row.label }}</span>
            <span class="mono">{{ row.value }}</span>
          </div>
        </div>

        <p class="dim tiny">{{ sampleTimeText }}</p>
      </template>
    </div>
  </NModal>
</template>

<style scoped>
.detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.detail-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: var(--r-sm);
  color: #fff;
  background: linear-gradient(
    135deg,
    var(--accent),
    color-mix(in srgb, var(--accent) 45%, #22d3ee)
  );
}

.detail-titles {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.detail-titles strong {
  font-size: 14px;
}

.detail-sub {
  font-size: 11px;
  font-weight: 400;
}

.detail-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  max-height: min(66vh, 620px);
  overflow-y: auto;
  padding-right: 4px;
  font-size: 13px;
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.metric-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.metric-label {
  font-size: 12px;
  color: var(--text-2);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.metric-value {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.metric-value.sm {
  font-size: 13px;
}

.sub-line {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
}

.track {
  display: block;
  height: 6px;
  border-radius: var(--r-xs);
  background: var(--track);
  overflow: hidden;
}

.track.lg {
  height: 8px;
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

/* 内存分段条：已用 / 缓存叠在轨道上，剩余部分即空闲 */
.segbar {
  display: flex;
  height: 8px;
  border-radius: var(--r-xs);
  background: var(--track);
  overflow: hidden;
}

.seg {
  display: block;
  height: 100%;
}

.seg.used {
  background: var(--accent);
}

.seg.cached {
  background: var(--warn);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 2px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--text-2);
}

.legend-dot.used {
  background: var(--accent);
}

.legend-dot.cached {
  background: var(--warn);
}

/* 空闲段不描边，用一档灰表示「轨道本身」 */
.legend-dot.free {
  background: var(--track);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  font-size: 11px;
  padding: 3px 8px;
  border: 0;
  border-radius: var(--r-xs);
  color: var(--text-2);
  background: var(--surface-2);
}

.sub-title {
  margin: 2px 0 0;
  font-size: 12px;
}

.cores {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 6px 16px;
}

.core {
  display: flex;
  align-items: center;
  gap: 7px;
}

.core-name {
  font-size: 10px;
  color: var(--text-2);
  width: 24px;
  flex: none;
}

.core-track {
  flex: 1;
  height: 5px;
}

.core-val {
  font-size: 10px;
  color: var(--text-2);
  width: 30px;
  text-align: right;
  flex: none;
}

.history {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 44px;
  padding: 2px 0;
}

.hist-col {
  flex: 1;
  min-width: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--accent);
  transition: height 0.3s ease;
}

.hist-col.warn {
  background: var(--warn);
}

.hist-col.err {
  background: var(--err);
}

.kv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px 20px;
}

/* 键值行之间不画下划线：靠行距成组，label 淡、值实 */
.kv {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
}

/* 网卡 / GPU 各自一块：用一层色块代替分割线来分组 */
.iface,
.gpu {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: var(--sp-3) var(--sp-4);
  border: 0;
  border-radius: var(--r-sm);
  background: var(--surface-2);
}

.iface-name {
  font-size: 14px;
  font-weight: 600;
}

.gpu-name {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gpu-note {
  margin: 0;
  font-size: 13px;
  color: var(--warn);
}

.tiny {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
}
</style>
