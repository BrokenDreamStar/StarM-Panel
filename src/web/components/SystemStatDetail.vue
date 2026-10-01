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
import { useSettingsStore } from '@/stores/settings'
import { STAT_CARD_META, type StatCardRef } from '@/composables/useStatCards'
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
const settings = useSettingsStore()

const open = computed({
  get: () => props.show,
  set: (v: boolean) => emit('update:show', v),
})

const kind = computed(() => props.card?.kind ?? 'system')
const mount = computed(() => props.card?.mount ?? '')
const meta = computed(() => STAT_CARD_META[kind.value])

// ── 数据源 ───────────────────────────────────────────────────

const snap = computed(() => monitor.latest)
const stat = computed(() => monitor.staticInfo)

const cpu = computed(() => snap.value?.cpu ?? null)
const cpuTemp = computed(() => cpu.value?.temp ?? null)
const mem = computed(() => snap.value?.mem ?? null)
const sys = computed(() => snap.value?.system ?? null)

const diskInfo = computed(
  () => (snap.value?.disks ?? []).find((d) => d.mount === mount.value) ?? null,
)
const statDisk = computed(
  () => (stat.value?.disks ?? []).find((d) => d.mount === mount.value) ?? null,
)

const netIfaces = computed(() => monitor.netFiltered(settings.monitorNetIfaces))
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
    { key: 'used', label: '已用', bytes: m.used, cls: 'used' },
    ...(cached > 0 ? [{ key: 'cached', label: '缓存/缓冲', bytes: cached, cls: 'cached' }] : []),
    { key: 'free', label: '空闲', bytes: m.free, cls: 'free' },
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

const gpuViews = computed<GpuView[]>(() => {
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

const GPU_METRIC_LABELS: Record<GpuMetric, string> = {
  utilization: '使用率',
  memory: '显存',
  temperature: '温度',
  power: '功耗',
  fan: '风扇转速',
  clock: '频率',
}

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
    return `${fmtBytes(vram)}${gpu.stat?.vramDynamic ? '（与内存共享）' : ''}`
  }
  return '未知'
}

// ── 文案 ─────────────────────────────────────────────────────

const title = computed(() =>
  kind.value === 'disk' ? `磁盘 ${mount.value}` : `${meta.value.title}详情`,
)

const subtitle = computed(() => {
  switch (kind.value) {
    case 'cpu':
      return stat.value?.cpu.brand || '处理器'
    case 'memory':
      return '物理内存与交换分区'
    case 'disk':
      return diskInfo.value?.type || statDisk.value?.type || '磁盘使用情况'
    case 'network':
      return `${netIfaces.value.length} 个网卡`
    case 'gpu':
      return `${gpuViews.value.length} 个 GPU 设备`
    default:
      return stat.value
        ? `${stat.value.os.distro || stat.value.os.platform} · ${stat.value.os.hostname}`
        : '主机信息'
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
        { label: '型号', value: s?.brand || '—' },
        { label: '厂商', value: s?.manufacturer || '—' },
        { label: '核心', value: s ? `${s.physicalCores} 物理 / ${s.cores} 逻辑` : '—' },
        { label: '标称主频', value: s ? fmtGhz(s.speed) : '—' },
      ]
    }
    case 'memory': {
      return [
        // 说明：/api/system/info 目前没有内存字段，总量只能来自实时快照
        { label: '总内存（实时快照）', value: fmtBytes(mem.value?.total) },
        { label: '空闲', value: fmtBytes(mem.value?.free) },
        { label: '可用', value: fmtBytes(mem.value?.available) },
        { label: '交换分区', value: fmtBytesPair(mem.value?.swapUsed, mem.value?.swapTotal) },
      ]
    }
    case 'disk': {
      const d = diskInfo.value
      const s = statDisk.value
      const total = d?.total ?? s?.size ?? null
      return [
        { label: '挂载点', value: mount.value || '—' },
        { label: '文件系统', value: d?.type || s?.type || '—' },
        { label: '设备', value: d?.fs || s?.fs || '—' },
        { label: '总容量', value: fmtBytes(total) },
        { label: '已用', value: d ? fmtBytes(d.used) : '—' },
        { label: '可用', value: d ? fmtBytes(Math.max(0, d.total - d.used)) : '—' },
        { label: '读取速率', value: fmtDiskRate(d?.readBps) },
        { label: '写入速率', value: fmtDiskRate(d?.writeBps) },
      ]
    }
    case 'system': {
      const s = stat.value
      return [
        { label: '主机名', value: s?.os.hostname || '—' },
        { label: '发行版', value: s ? s.os.distro || s.os.platform : '—' },
        { label: '内核', value: s?.os.kernel || s?.os.release || '—' },
        { label: '架构', value: s?.os.arch || '—' },
        { label: '运行时长', value: fmtUptime(sys.value?.uptime) },
        { label: '进程数', value: sys.value ? String(sys.value.processes) : '—' },
        { label: '用户数', value: sys.value ? String(sys.value.users) : '—' },
        { label: 'CPU 型号', value: s?.cpu.brand || '—' },
        { label: '内存总量（实时快照）', value: fmtBytes(mem.value?.total) },
      ]
    }
    default:
      return []
  }
})

/** CPU 最近采样的横向条形历史（用 div 而非 SVG，避免图表元素混入） */
const cpuHistory = computed(() => monitor.trendCpu.slice(-40))
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
      <p v-if="!snap && !stat" class="dim">正在读取系统数据…</p>

      <!-- ── CPU ────────────────────────────────────────────── -->
      <template v-else-if="kind === 'cpu'">
        <div class="metric">
          <div class="metric-row">
            <span class="metric-label">总使用率</span>
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
          <span class="chip mono">负载 1/5/15：{{ loadText }}</span>
          <!-- temp 为 null 时整项不显示（而不是显示一个假温度） -->
          <span v-if="cpuTemp !== null" class="chip mono">温度 {{ cpuTemp }} °C</span>
          <span v-if="cpu?.speed !== null && cpu?.speed !== undefined" class="chip mono">
            实时 {{ fmtGhz(cpu.speed) }}
          </span>
          <span class="chip mono">{{ cpu?.perCore.length ?? 0 }} 核心</span>
        </div>

        <template v-if="(cpu?.perCore.length ?? 0) > 0">
          <h4 class="sub-title">每核心使用率</h4>
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
          <h4 class="sub-title">最近 {{ cpuHistory.length }} 次采样</h4>
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

        <h4 class="sub-title">静态信息</h4>
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
            <span class="metric-label">已用 / 总量</span>
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
          <h4 class="sub-title">交换分区</h4>
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

        <h4 class="sub-title">静态信息</h4>
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
            <span class="metric-label">{{ mount }}</span>
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
            {{ diskInfo ? fmtBytesPair(diskInfo.used, diskInfo.total) : '等待采样…' }}
          </p>
        </div>

        <h4 class="sub-title">容量与设备</h4>
        <div class="kv-grid">
          <div v-for="row in infoRows" :key="row.label" class="kv">
            <span class="dim">{{ row.label }}</span>
            <span class="mono">{{ row.value }}</span>
          </div>
        </div>

        <p class="dim tiny">
          读写速率来自 /proc/diskstats 的累计计数差分；macOS / Windows 不提供该数据源，
          因此恒显示「—」而不是 0 B/s。
        </p>
      </template>

      <!-- ── 网络 ───────────────────────────────────────────── -->
      <template v-else-if="kind === 'network'">
        <p v-if="netIfaces.length === 0" class="dim">没有可显示的网卡（检查 monitor.netIfaces 设置）。</p>
        <div v-for="n in netIfaces" :key="n.iface" class="iface">
          <div class="metric-row">
            <span class="iface-name mono">{{ n.iface }}</span>
            <span class="mono dim">{{ netStatic(n.iface)?.ip4 || '无 IP' }}</span>
          </div>
          <div class="kv-grid">
            <div class="kv">
              <span class="dim">下行</span>
              <span class="mono">{{ fmtRate(n.rxBps) }}</span>
            </div>
            <div class="kv">
              <span class="dim">上行</span>
              <span class="mono">{{ fmtRate(n.txBps) }}</span>
            </div>
            <div class="kv">
              <span class="dim">累计接收</span>
              <span class="mono">{{ fmtBytes(n.rxTotal) }}</span>
            </div>
            <div class="kv">
              <span class="dim">累计发送</span>
              <span class="mono">{{ fmtBytes(n.txTotal) }}</span>
            </div>
            <div v-if="netStatic(n.iface)?.mac" class="kv">
              <span class="dim">MAC</span>
              <span class="mono">{{ netStatic(n.iface)?.mac }}</span>
            </div>
            <div v-if="netStatic(n.iface)?.speed" class="kv">
              <span class="dim">链路速率</span>
              <span class="mono">{{ netStatic(n.iface)?.speed }} Mbit/s</span>
            </div>
          </div>
        </div>
      </template>

      <!-- ── GPU ────────────────────────────────────────────── -->
      <template v-else-if="kind === 'gpu'">
        <p v-if="gpuViews.length === 0" class="dim">未检测到 GPU 设备。</p>

        <div v-for="gpu in gpuViews" :key="gpu.index" class="gpu">
          <div class="metric-row">
            <span class="gpu-name">{{ gpu.model }}</span>
            <span class="mono dim">#{{ gpu.index }} · {{ gpu.vendor }}</span>
          </div>

          <!-- available 为空：只有静态信息，一行明确说明，绝不渲染空图表 -->
          <template v-if="gpu.available.length === 0">
            <p class="gpu-note">该平台不暴露 GPU 动态指标</p>
            <div class="kv-grid">
              <div class="kv">
                <span class="dim">型号</span>
                <span class="mono">{{ gpu.model }}</span>
              </div>
              <div class="kv">
                <span class="dim">厂商</span>
                <span class="mono">{{ gpu.stat?.vendor || gpu.vendor }}</span>
              </div>
              <div class="kv">
                <span class="dim">显存</span>
                <span class="mono">{{ gpuVram(gpu) }}</span>
              </div>
              <div class="kv">
                <span class="dim">驱动</span>
                <span class="mono">{{ gpu.stat?.driverVersion || '未知' }}</span>
              </div>
              <div class="kv">
                <span class="dim">总线</span>
                <span class="mono">{{ gpu.stat?.bus || '未知' }}</span>
              </div>
            </div>
            <p class="dim tiny">
              Windows / Linux + 独显环境下会显示使用率、温度、功耗等指标；
              macOS 的 Apple Silicon 不提供这些数据。
            </p>
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
            <span class="metric-label">运行时长</span>
            <span class="metric-value mono">{{ fmtUptime(sys?.uptime) }}</span>
          </div>
        </div>

        <h4 class="sub-title">主机信息</h4>
        <div class="kv-grid">
          <div v-for="row in infoRows" :key="row.label" class="kv">
            <span class="dim">{{ row.label }}</span>
            <span class="mono">{{ row.value }}</span>
          </div>
        </div>

        <p class="dim tiny">
          实时采样时间 {{ snap ? new Date(snap.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—' }}
        </p>
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
