<script setup lang="ts">
/**
 * 设置页（/settings）。
 *
 * 骨架：左侧固定分类导航 + 右侧单栏内容。一次只看一类设置，
 * 面板内一律「标签在左、控件在右、说明在标签下」，分组之间只靠留白分开，
 * 不画任何分割线（设计语言见 styles/main.css 顶部说明）。
 *
 * 所有改动都通过 settings.patch() 写回 PATCH /api/settings —— 乐观更新：
 * 本地立即生效，失败只提示不回滚（离线也能先改主题 / 网络模式）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import {
  NAlert,
  NButton,
  NCheckbox,
  NColorPicker,
  NInput,
  NInputNumber,
  NSelect,
  NSlider,
  NSwitch,
  useMessage,
} from 'naive-ui'
import { useSettingsStore } from '@/stores/settings'
import { useItemsStore } from '@/stores/items'
import { useNetworkStore } from '@/stores/network'
import { useMonitorStore } from '@/stores/monitor'
import { api } from '@/api/client'
import {
  MONITOR_CARD_KINDS,
  readMonitorCards,
  type MonitorCardKind,
} from '@/api/settings'
import FaviconGlyph from '@/components/FaviconGlyph.vue'

const router = useRouter()
const message = useMessage()
const settings = useSettingsStore()
const itemsStore = useItemsStore()
const network = useNetworkStore()
const monitor = useMonitorStore()

const { saving, failedKeys, error } = storeToRefs(settings)

/** 保存状态提示 */
const lastSaved = ref<string | null>(null)

async function save(patch: Record<string, unknown>, label: string, quiet = false): Promise<void> {
  const ok = await settings.patch(patch)
  if (ok) {
    lastSaved.value = label
    if (!quiet) message.success(`${label} 已保存`)
  } else {
    message.error(`${label} 保存到服务端失败（已保留本地改动）`)
  }
}

// ── 导航 ─────────────────────────────────────────────────────

type SectionKey = 'appearance' | 'home' | 'network' | 'monitor' | 'about'

const SECTIONS: Array<{ key: SectionKey; label: string; icon: string; desc: string }> = [
  { key: 'appearance', label: '外观', icon: 'image', desc: '主题、主题色、毛玻璃与壁纸' },
  { key: 'home', label: '首页', icon: 'home', desc: '标题、时钟、卡片尺寸与硬件分区' },
  { key: 'network', label: '网络', icon: 'wifi', desc: '内外网模式与连通性探测' },
  { key: 'monitor', label: '监控', icon: 'cpu', desc: '采集哪些指标、多久采一次' },
  { key: 'about', label: '关于', icon: 'server', desc: '版本与运行环境' },
]

const active = ref<SectionKey>('appearance')
const activeSection = computed(() => SECTIONS.find((s) => s.key === active.value) ?? SECTIONS[0])

function select(key: SectionKey): void {
  active.value = key
  // 换面板后把右栏滚回顶部，否则长面板的滚动位置会跟到下一个面板
  void bodyRef.value?.scrollTo({ top: 0 })
}

const bodyRef = ref<HTMLElement | null>(null)

// ── 外观 ─────────────────────────────────────────────────────

const themeOptions = [
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
  { label: '跟随系统', value: 'system' },
]

const wallpaperOptions = [
  { label: '无壁纸（纯色底）', value: 'none' },
  { label: '纯色', value: 'solid' },
  { label: '渐变（默认，离线可用）', value: 'gradient' },
  { label: '自定义图片', value: 'asset' },
  { label: 'Bing 每日图（需要外网）', value: 'bing' },
]

const cardSizeOptions = [
  { label: '紧凑', value: 'sm' },
  { label: '标准', value: 'md' },
  { label: '宽松', value: 'lg' },
]

/** 全局打开方式：所有卡片共用一个值（原先是卡片级字段，已取消） */
const openModeOptions = [
  { label: '新窗口', value: 'newTab' },
  { label: '当前窗口', value: 'self' },
]

const glassStyleOptions = [
  { label: '毛玻璃（默认）', value: 'frost' },
  { label: '液态玻璃', value: 'liquid' },
]

/** 壁纸文件中转：不落库，仅把可访问地址写进 wallpaper.value */
const wallpaperUrl = computed({
  get: () => (typeof settings.wallpaperValue === 'string' ? settings.wallpaperValue : ''),
  set: (v: string) => void save({ 'wallpaper.value': v || null }, '壁纸'),
})

const wallpaperUploading = ref(false)

async function onWallpaperFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    message.error('请选择图片文件')
    return
  }
  wallpaperUploading.value = true
  try {
    const asset = await api.assets.upload(file, 'wallpaper')
    await save({ 'wallpaper.type': 'asset', 'wallpaper.value': asset.url }, '壁纸')
  } catch (e) {
    message.error(
      `壁纸上传失败：${e instanceof Error ? e.message : '未知错误'}（也可直接填写图片 URL）`,
    )
  } finally {
    wallpaperUploading.value = false
  }
}

// ── 首页标题 / 时钟 ──────────────────────────────────────────

/** 标题输入用本地草稿，只在失焦或回车时 PATCH，避免每敲一个字发一次请求 */
const titleDraft = ref(settings.get('ui.title'))

watch(
  () => settings.get('ui.title'),
  (v) => {
    if (v !== titleDraft.value) titleDraft.value = v
  },
)

function commitTitle(): void {
  const next = titleDraft.value.trim()
  if (next === settings.get('ui.title')) return
  void save({ 'ui.title': next }, '首页标题')
}

// ── 系统状态卡片（勾选 + 排序）───────────────────────────────

const CARD_LABELS: Record<MonitorCardKind, string> = {
  cpu: 'CPU 使用率',
  memory: '内存',
  disk: '磁盘（按挂载点展开）',
  network: '网络',
  gpu: 'GPU',
  system: '系统信息',
}

/** 已选卡片，顺序即首页展示顺序 */
const selectedCards = computed<MonitorCardKind[]>(() => readMonitorCards(settings.raw))

/** 未选中的卡片 */
const hiddenCards = computed(() =>
  MONITOR_CARD_KINDS.filter((k) => !selectedCards.value.includes(k)),
)

function toggleCard(kind: MonitorCardKind, on: boolean): void {
  const current = selectedCards.value
  if (on === current.includes(kind)) return
  const next = on ? [...current, kind] : current.filter((k) => k !== kind)
  void save({ 'monitor.cards': next }, '系统状态卡片')
}

function moveCard(index: number, delta: number): void {
  const next = [...selectedCards.value]
  const target = index + delta
  if (target < 0 || target >= next.length) return
  const [moved] = next.splice(index, 1)
  if (!moved) return
  next.splice(target, 0, moved)
  // 排序不弹 toast，否则连点几次会刷屏
  void save({ 'monitor.cards': next }, '系统状态卡片顺序', true)
}

/** 白名单候选项：动态快照 + 静态信息取并集，首帧就有可选项 */
const diskOptions = computed(() => {
  const mounts = [
    ...(monitor.latest?.disks ?? []).map((d) => d.mount),
    ...(monitor.staticInfo?.disks ?? []).map((d) => d.mount),
  ]
  return [...new Set(mounts)].map((m) => ({ label: m, value: m }))
})

const ifaceOptions = computed(() => {
  const ifaces = [
    ...(monitor.latest?.net ?? []).map((n) => n.iface),
    ...(monitor.staticInfo?.net ?? []).map((n) => n.iface),
  ]
  return [...new Set(ifaces)].map((i) => ({ label: i, value: i }))
})

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

// ── 网络 ─────────────────────────────────────────────────────

const modeOptions = [
  { label: '内网', value: 'lan' },
  { label: '外网', value: 'wan' },
  { label: '自动', value: 'auto' },
]

const probeIntervalOptions = [
  { label: '10 秒', value: 10_000 },
  { label: '30 秒（默认）', value: 30_000 },
  { label: '1 分钟', value: 60_000 },
  { label: '5 分钟', value: 300_000 },
]

const monitorIntervalOptions = [
  { label: '500 ms', value: 500 },
  { label: '1 秒（默认）', value: 1000 },
  { label: '2 秒', value: 2000 },
  { label: '5 秒', value: 5000 },
  { label: '10 秒', value: 10_000 },
]

/** 网络模式切换同时走 store（双写 localStorage + PATCH） */
function setNetworkMode(value: string): void {
  if (value === 'lan' || value === 'wan' || value === 'auto') {
    network.setMode(value)
    message.success(`默认网络模式：${modeOptions.find((m) => m.value === value)?.label}`)
  }
}

const probeSummary = computed(() => {
  const entries = Object.values(network.probeStatus)
  if (entries.length === 0) return '暂无探测结果'
  const reachable = entries.filter((e) => e.reachable === true).length
  return `${entries.length} 张卡片已探测，其中 ${reachable} 张内网可达`
})

// ── 采集能力 ─────────────────────────────────────────────────

const capabilities = computed(() => [
  { k: 'CPU 温度', v: monitor.staticInfo?.capabilities.cpuTemp },
  { k: 'GPU 动态', v: monitor.staticInfo?.capabilities.gpuDynamic },
  { k: '磁盘 IO', v: monitor.staticInfo?.capabilities.disksIo },
  { k: '网络速率', v: monitor.staticInfo?.capabilities.netStats },
])

// ── 关于 ─────────────────────────────────────────────────────

const platform = ref<{ os: string; arch: string; hostname: string } | null>(null)
const health = ref<{ version: string; schemaVersion?: number; uptime: number } | null>(null)

onMounted(async () => {
  try {
    const payload = await api.bootstrap()
    platform.value = payload.platform
  } catch {
    platform.value = null
  }
  try {
    const h = await api.health()
    health.value = { version: h.version, uptime: h.uptime }
  } catch {
    health.value = null
  }
  await monitor.loadStaticInfo()
})
</script>

<template>
  <div class="settings">
    <aside class="rail" data-glass-card>
      <button class="back" type="button" @click="router.push('/')">
        <span class="back-arrow" aria-hidden="true">←</span>
        返回桌面
      </button>

      <h1 class="rail-title">设置</h1>

      <nav class="nav" aria-label="设置分类">
        <button
          v-for="s in SECTIONS"
          :key="s.key"
          class="nav-item"
          :class="{ active: active === s.key }"
          type="button"
          :aria-current="active === s.key ? 'page' : undefined"
          @click="select(s.key)"
        >
          <FaviconGlyph :name="s.icon" :size="15" />
          <span>{{ s.label }}</span>
        </button>
      </nav>

      <div class="rail-foot">
        <span v-if="saving" class="status"><i class="dot warn" />保存中…</span>
        <span v-else-if="failedKeys.size > 0" class="status status-err">
          <i class="dot err" />{{ failedKeys.size }} 项未同步
        </span>
        <span v-else-if="lastSaved" class="status"><i class="dot ok" />已保存</span>
        <span v-else class="status dim">改动即时生效</span>
      </div>
    </aside>

    <main ref="bodyRef" class="body">
      <p v-if="error" class="note-err">{{ error }}</p>

      <Transition name="panel" mode="out-in">
        <section :key="active" class="panel">
          <header class="panel-head">
            <h2>{{ activeSection.label }}</h2>
            <p class="dim">{{ activeSection.desc }}</p>
          </header>

          <!-- ── 外观 ─────────────────────────────────────── -->
          <template v-if="active === 'appearance'">
            <div class="row">
              <div class="row-label">
                <span class="label">主题模式</span>
                <span class="hint dim">浅色与深色都使用同一套白玻璃卡片，只是明暗反转。</span>
              </div>
              <div class="row-control">
                <NSelect
                  :value="settings.themeMode"
                  :options="themeOptions"
                  size="small"
                  :consistent-menu-width="false"
                  @update:value="(v: string) => save({ 'theme.mode': v }, '主题模式')"
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">主题色</span>
                <span class="hint mono dim">{{ settings.accent }}</span>
              </div>
              <div class="row-control">
                <NColorPicker
                  :value="settings.accent"
                  size="small"
                  :show-alpha="false"
                  :swatches="[
                    '#6366f1',
                    '#0ea5e9',
                    '#10b981',
                    '#f59e0b',
                    '#ef4444',
                    '#a855f7',
                    '#ec4899',
                  ]"
                  @update:value="(v: string) => save({ 'theme.accent': v }, '主题色')"
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">毛玻璃模糊度</span>
                <span class="hint dim">卡片背后壁纸的模糊半径，调到 0 即关闭模糊。</span>
              </div>
              <div class="row-control">
                <div class="slider">
                  <NSlider
                    :value="settings.blur"
                    :min="0"
                    :max="30"
                    :step="1"
                    @update:value="(v: number) => save({ 'theme.blur': v }, '模糊度')"
                  />
                  <span class="slider-value mono">{{ settings.blur }}px</span>
                </div>
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">UI 风格</span>
                <span class="hint dim">
                  液态玻璃带真实的边缘折射（Apple Liquid Glass 风格），作用于所有卡片。
                  仅 Chromium 内核完整生效，其他浏览器自动回落为毛玻璃。
                </span>
              </div>
              <div class="row-control">
                <NSelect
                  :value="settings.glassStyle"
                  :options="glassStyleOptions"
                  size="small"
                  :consistent-menu-width="false"
                  @update:value="(v: string) => save({ 'ui.glassStyle': v }, 'UI 风格')"
                />
              </div>
            </div>

            <template v-if="settings.glassStyle === 'liquid'">
              <div class="row">
                <div class="row-label">
                  <span class="label">卡片不透明度</span>
                  <span class="hint dim">0 = 跟随主题默认（深色约 8%，浅色约 62%）。</span>
                </div>
                <div class="row-control">
                  <div class="slider">
                    <NSlider
                      :value="settings.glassOpacity"
                      :min="0"
                      :max="95"
                      :step="1"
                      @update:value="(v: number) => save({ 'ui.glassOpacity': v }, '卡片不透明度', true)"
                    />
                    <span class="slider-value mono">
                      {{ settings.glassOpacity === 0 ? '跟随' : `${settings.glassOpacity}%` }}
                    </span>
                  </div>
                </div>
              </div>

              <div class="row">
                <div class="row-label">
                  <span class="label">折射强度</span>
                  <span class="hint dim">卡片边缘把背景「掰弯」的程度，边缘最大位移为该值的一半。</span>
                </div>
                <div class="row-control">
                  <div class="slider">
                    <NSlider
                      :value="settings.glassScale"
                      :min="0"
                      :max="120"
                      :step="4"
                      @update:value="(v: number) => save({ 'ui.glassScale': v }, '折射强度', true)"
                    />
                    <span class="slider-value mono">{{ settings.glassScale }}</span>
                  </div>
                </div>
              </div>

              <div class="row">
                <div class="row-label">
                  <span class="label">边缘色散</span>
                  <span class="hint dim">
                    折射时 RGB 三通道分离，是液态玻璃的标志性观感；逐像素三份开销，卡顿时关闭。
                  </span>
                </div>
                <div class="row-control row-control--start">
                  <NSwitch
                    :value="settings.glassChroma"
                    size="small"
                    @update:value="(v: boolean) => save({ 'ui.glassChroma': v }, '边缘色散', true)"
                  />
                </div>
              </div>

              <NAlert type="warning" :bordered="false" class="span-all">
                液态玻璃是逐像素折射，卡片很多或设备较旧时滚动可能掉帧 —— 可调低折射强度或关闭色散。
              </NAlert>
            </template>

            <div class="row">
              <div class="row-label">
                <span class="label">壁纸类型</span>
                <span class="hint dim">渐变与纯色完全离线可用。</span>
              </div>
              <div class="row-control">
                <NSelect
                  :value="settings.wallpaperType"
                  :options="wallpaperOptions"
                  size="small"
                  :consistent-menu-width="false"
                  @update:value="(v: string) => save({ 'wallpaper.type': v }, '壁纸类型')"
                />
              </div>
            </div>

            <div v-if="settings.wallpaperType === 'solid'" class="row">
              <div class="row-label">
                <span class="label">壁纸颜色</span>
              </div>
              <div class="row-control">
                <NColorPicker
                  :value="
                    typeof settings.wallpaperValue === 'string'
                      ? settings.wallpaperValue
                      : '#0b0f17'
                  "
                  size="small"
                  :show-alpha="false"
                  @update:value="(v: string) => save({ 'wallpaper.value': v }, '壁纸颜色')"
                />
              </div>
            </div>

            <template v-if="settings.wallpaperType === 'asset'">
              <div class="row">
                <div class="row-label">
                  <span class="label">图片地址</span>
                </div>
                <div class="row-control">
                  <NInput
                    v-model:value="wallpaperUrl"
                    size="small"
                    placeholder="/api/assets/xxxx 或 https://…/bg.jpg"
                  />
                </div>
              </div>
              <div class="row">
                <div class="row-label">
                  <span class="label">或上传本地图片</span>
                  <span class="hint dim">上传成功后会自动把「壁纸类型」切到自定义图片。</span>
                </div>
                <div class="row-control">
                  <label class="file">
                    <input type="file" accept="image/*" @change="onWallpaperFile" />
                    <span>{{ wallpaperUploading ? '上传中…' : '选择图片' }}</span>
                  </label>
                </div>
              </div>
            </template>

            <NAlert
              v-if="settings.wallpaperType === 'bing'"
              type="warning"
              :bordered="false"
              class="span-all"
            >
              Bing 每日图需要访问外网；纯内网部署请改用「渐变」或「自定义图片」。
            </NAlert>
          </template>

          <!-- ── 首页 ─────────────────────────────────────── -->
          <template v-else-if="active === 'home'">
            <div class="row">
              <div class="row-label">
                <span class="label">首页标题</span>
                <span class="hint dim">失焦或回车后保存。</span>
              </div>
              <div class="row-control">
                <NInput
                  v-model:value="titleDraft"
                  size="small"
                  placeholder="留空显示 StarM Panel"
                  @blur="commitTitle"
                  @keydown.enter="commitTitle"
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">首页显示时钟</span>
                <span class="hint dim">
                  时钟显示在标题右侧（大号 HH:MM 与日期），关闭后只保留标题。
                </span>
              </div>
              <div class="row-control row-control--start">
                <NSwitch
                  :value="settings.get('ui.showClock')"
                  size="small"
                  @update:value="(v: boolean) => save({ 'ui.showClock': v }, '首页时钟')"
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">卡片尺寸</span>
                <span class="hint dim">决定应用卡片的最小宽度与内距。</span>
              </div>
              <div class="row-control">
                <NSelect
                  :value="settings.cardSize"
                  :options="cardSizeOptions"
                  size="small"
                  :consistent-menu-width="false"
                  @update:value="(v: string) => save({ 'ui.cardSize': v }, '卡片尺寸')"
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">打开方式</span>
                <span class="hint dim">
                  所有卡片统一按这个方式打开。卡片右键菜单里的「在新窗口打开」是单次覆盖，不受此项影响。
                </span>
              </div>
              <div class="row-control">
                <NSelect
                  :value="settings.openMode"
                  :options="openModeOptions"
                  size="small"
                  :consistent-menu-width="false"
                  @update:value="(v: string) => save({ 'ui.openMode': v }, '打开方式')"
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">首页「系统状态」分区</span>
                <span class="hint dim">
                  关闭后首页不再渲染硬件卡片（SSE 数据流继续工作，本页仍可查看采集能力）。
                </span>
              </div>
              <div class="row-control row-control--start">
                <NSwitch
                  :value="settings.showMonitor"
                  size="small"
                  @update:value="(v: boolean) => save({ 'ui.showMonitor': v }, '系统状态分区')"
                />
              </div>
            </div>
          </template>

          <!-- ── 网络 ─────────────────────────────────────── -->
          <template v-else-if="active === 'network'">
            <div class="row">
              <div class="row-label">
                <span class="label">默认网络模式</span>
                <span class="hint dim">
                  切换会双写：先更新浏览器 localStorage（立即生效、离线可用），再异步写回服务端。
                  服务端写入失败不会回滚本地选择。
                </span>
              </div>
              <div class="row-control">
                <NSelect
                  :value="network.mode"
                  :options="modeOptions"
                  size="small"
                  :consistent-menu-width="false"
                  @update:value="setNetworkMode"
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">启用自动探测</span>
                <span class="hint dim">由后端定期探测各卡片内网地址是否可达。</span>
              </div>
              <div class="row-control row-control--start">
                <NSwitch
                  :value="settings.get('network.autoProbe')"
                  size="small"
                  @update:value="(v: boolean) => save({ 'network.autoProbe': v }, '自动探测')"
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">探测周期</span>
              </div>
              <div class="row-control">
                <NSelect
                  :value="settings.get('network.probeInterval')"
                  :options="probeIntervalOptions"
                  size="small"
                  :consistent-menu-width="false"
                  @update:value="
                    (v: number) => save({ 'network.probeInterval': v }, '探测周期')
                  "
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">探测超时</span>
                <span class="hint dim">毫秒。超过这个时间即判定该地址不可达。</span>
              </div>
              <div class="row-control">
                <NInputNumber
                  :value="settings.get('network.probeTimeout')"
                  size="small"
                  :min="100"
                  :max="10_000"
                  :step="100"
                  @update:value="
                    (v: number | null) => v !== null && save({ 'network.probeTimeout': v }, '探测超时')
                  "
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">探测结果</span>
                <span v-if="network.persistError" class="hint dim">
                  上次模式写入服务端失败：{{ network.persistError }}
                </span>
              </div>
              <div class="row-control row-control--text">
                <span class="dim">{{
                  network.probeUnsupported ? '探测接口不可用' : probeSummary
                }}</span>
                <NButton size="tiny" tertiary :loading="network.probing" @click="network.refreshProbe(true)">
                  立即重新探测
                </NButton>
              </div>
            </div>
          </template>

          <!-- ── 监控 ─────────────────────────────────────── -->
          <template v-else-if="active === 'monitor'">
            <div class="row row--stack">
              <div class="row-label">
                <span class="label">系统状态卡片</span>
                <span class="hint dim">
                  勾选决定首页显示哪些卡片，顺序即展示顺序。「磁盘」会按挂载点展开成多张卡片；
                  没有任何 GPU 设备时 GPU 卡片自动跳过。
                </span>
              </div>

              <div class="picker">
                <div v-for="(kind, i) in selectedCards" :key="kind" class="pick">
                  <NCheckbox
                    :checked="true"
                    @update:checked="(v: boolean) => toggleCard(kind, v)"
                  />
                  <span class="pick-label">{{ CARD_LABELS[kind] }}</span>
                  <span class="spacer" />
                  <button
                    class="pick-btn"
                    type="button"
                    title="上移"
                    :disabled="i === 0"
                    @click="moveCard(i, -1)"
                  >
                    ↑
                  </button>
                  <button
                    class="pick-btn"
                    type="button"
                    title="下移"
                    :disabled="i === selectedCards.length - 1"
                    @click="moveCard(i, 1)"
                  >
                    ↓
                  </button>
                </div>
                <p v-if="selectedCards.length === 0" class="hint dim">尚未选择任何卡片。</p>

                <template v-if="hiddenCards.length > 0">
                  <p class="picker-divider dim">未显示</p>
                  <div v-for="kind in hiddenCards" :key="kind" class="pick pick--off">
                    <NCheckbox
                      :checked="false"
                      @update:checked="(v: boolean) => toggleCard(kind, v)"
                    />
                    <span class="pick-label dim">{{ CARD_LABELS[kind] }}</span>
                  </div>
                </template>
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">磁盘白名单</span>
                <span class="hint dim">留空 = 显示全部挂载点。</span>
              </div>
              <div class="row-control">
                <NSelect
                  multiple
                  :value="settings.monitorDisks"
                  :options="diskOptions"
                  size="small"
                  placeholder="全部挂载点"
                  @update:value="
                    (v: unknown) => save({ 'monitor.disks': asStringArray(v) }, '磁盘白名单')
                  "
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">网卡白名单</span>
                <span class="hint dim">留空 = 显示全部网卡。</span>
              </div>
              <div class="row-control">
                <NSelect
                  multiple
                  :value="settings.monitorNetIfaces"
                  :options="ifaceOptions"
                  size="small"
                  placeholder="全部网卡"
                  @update:value="
                    (v: unknown) =>
                      save({ 'monitor.netIfaces': asStringArray(v) }, '网卡白名单')
                  "
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">采样间隔</span>
                <span class="hint dim">改动需要重启后端进程才会生效（采集循环在服务端启动时读取配置）。</span>
              </div>
              <div class="row-control">
                <NSelect
                  :value="settings.monitorInterval"
                  :options="monitorIntervalOptions"
                  size="small"
                  :consistent-menu-width="false"
                  @update:value="(v: number) => save({ 'monitor.interval': v }, '采样间隔')"
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">后台采样间隔</span>
                <span class="hint dim">页面不可见时改用这个更省的节奏。</span>
              </div>
              <div class="row-control">
                <NSelect
                  :value="settings.get('monitor.hiddenInterval')"
                  :options="monitorIntervalOptions"
                  size="small"
                  :consistent-menu-width="false"
                  @update:value="
                    (v: number) => save({ 'monitor.hiddenInterval': v }, '后台采样间隔')
                  "
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">GPU 采样</span>
              </div>
              <div class="row-control row-control--start">
                <NSwitch
                  :value="settings.monitorGpuEnabled"
                  size="small"
                  @update:value="(v: boolean) => save({ 'monitor.gpuEnabled': v }, 'GPU 采样')"
                />
              </div>
            </div>

            <div class="row">
              <div class="row-label">
                <span class="label">采集能力</span>
                <span class="hint dim">当前平台能拿到哪些数据源，不可用的项会显示「—」。</span>
              </div>
              <div class="row-control row-control--wrap">
                <span
                  v-for="cap in capabilities"
                  :key="cap.k"
                  class="chip"
                  :class="{ on: cap.v }"
                >
                  {{ cap.k }}：{{ cap.v ? '可用' : '不可用' }}
                </span>
              </div>
            </div>
          </template>

          <!-- ── 关于 ─────────────────────────────────────── -->
          <template v-else>
            <div class="about">
              <span class="kv-label">版本</span>
              <span class="kv-value mono">{{ health?.version ?? itemsStore.version ?? '0.1.0' }}</span>

              <span class="kv-label">运行时长</span>
              <span class="kv-value mono">{{ health ? `${Math.round(health.uptime)} 秒` : '—' }}</span>

              <span class="kv-label">平台</span>
              <span class="kv-value mono">
                {{ platform ? `${platform.os} / ${platform.arch}` : '—' }}
              </span>

              <span class="kv-label">主机名</span>
              <span class="kv-value mono">{{ platform?.hostname ?? '—' }}</span>

              <span class="kv-label">CPU</span>
              <span class="kv-value mono">{{ monitor.staticInfo?.cpu.brand || '—' }}</span>

              <span class="kv-label">内核</span>
              <span class="kv-value mono">{{ monitor.staticInfo?.os.kernel || '—' }}</span>

              <span class="kv-label">启动方式</span>
              <span class="kv-value mono">单文件二进制 + 内嵌前端</span>
            </div>

            <NButton size="small" tertiary class="mt" @click="router.push('/')">回到桌面</NButton>
          </template>
        </section>
      </Transition>
    </main>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-6);
  height: 100%;
  min-height: 0;
  /* 必须显式给宽度：本元素是 .main-pane（纵向 flex）的子项，
     交叉轴上的 margin-inline:auto 会取消 stretch，只写 max-width 的话
     整个容器会按内容收缩成一条窄列。 */
  width: min(1180px, 100%);
  margin-inline: auto;
  padding: var(--sp-6) 32px var(--sp-7);
}

/* ── 左侧导航 ─────────────────────────────────────────────── */

.rail {
  position: sticky;
  top: var(--sp-6);
  flex: none;
  width: 208px;
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  padding: var(--sp-5) var(--sp-4);
  border: 0;
  border-radius: var(--r-md);
  background: var(--card-bg);
  backdrop-filter: var(--glass);
  -webkit-backdrop-filter: var(--glass);
  box-shadow: var(--shadow-1);
}

.back {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  align-self: flex-start;
  flex: none;
  white-space: nowrap;
  padding: 3px 8px 3px 5px;
  margin-left: -5px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

.back:hover {
  background: var(--hover);
  color: var(--text);
}

.back-arrow {
  font-size: 14px;
  line-height: 1;
}

.rail-title {
  font-size: 19px;
  font-weight: 650;
  letter-spacing: -0.015em;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 选中项用实色块点亮，不画左侧竖条 —— 那也是一条线 */
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

.nav-item:hover {
  background: var(--hover);
  color: var(--text);
}

.nav-item.active {
  color: var(--text);
  font-weight: 550;
  background: var(--field-hi);
}

.rail-foot {
  margin-top: var(--sp-2);
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-2);
}

.status-err {
  color: var(--err);
}

/* ── 右侧内容 ─────────────────────────────────────────────── */

.body {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-y: auto;
  padding: var(--sp-2) 0 var(--sp-7);
}

.panel {
  max-width: 720px;
}

.panel-head {
  margin-bottom: var(--sp-6);
}

.panel-head h2 {
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.panel-head p {
  margin: 5px 0 0;
  font-size: 13px;
}

/* 一行一项：标签在左、控件在右，只靠留白分行 */
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 268px;
  align-items: center;
  gap: var(--sp-5);
  padding: var(--sp-4) 0;
}

.row + .row {
  padding-top: var(--sp-4);
}

.row--stack {
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: var(--sp-4);
}

.row-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
}

.hint {
  font-size: 12px;
  line-height: 1.55;
}

.row-control {
  min-width: 0;
}

/* 开关这类小控件靠左对齐，避免在右栏里孤零零地飘着 */
.row-control--start {
  display: flex;
  justify-content: flex-start;
}

.row-control--text {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-3);
  font-size: 12px;
}

.row-control--wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}

.span-all {
  grid-column: 1 / -1;
}

.slider {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.slider :deep(.n-slider) {
  flex: 1;
}

.slider-value {
  flex: none;
  width: 42px;
  text-align: right;
  font-size: 12px;
  color: var(--text-2);
}

/* 原生 file input 藏起来，只留一个像控件的 label */
.file {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-sm);
  background: var(--field);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

.file:hover {
  background: var(--field-hi);
  color: var(--text);
}

.file input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

/* ── 系统状态卡片选择器 ───────────────────────────────────── */

.picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pick {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 0;
  border-radius: var(--r-sm);
  background: var(--field);
  font-size: 13px;
  transition: background 0.14s ease;
}

.pick:hover {
  background: var(--field-hi);
}

.pick--off {
  background: transparent;
}

.pick--off:hover {
  background: var(--field);
}

.pick-label {
  white-space: nowrap;
}

.spacer {
  flex: 1;
}

.pick-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, opacity 0.14s ease;
}

.pick-btn:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.pick-btn:disabled {
  opacity: 0.28;
  cursor: default;
}

/* 「未显示」这一档不画分割线，用字距 + 上留白分组 */
.picker-divider {
  margin: var(--sp-3) 0 2px;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

/* ── 采集能力 chip ────────────────────────────────────────── */

.chip {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border: 0;
  border-radius: var(--r-xs);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 11px;
}

.chip.on {
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 15%, transparent);
}

/* ── 关于 ─────────────────────────────────────────────────── */

/* 一张「规格表」：标签定宽、值紧随其后。刻意不用 space-between ——
   在 720px 宽的面板里把值推到最右边，标签和值会断成两截。 */
.about {
  display: grid;
  grid-template-columns: 128px minmax(0, 1fr);
  gap: var(--sp-3) var(--sp-4);
  max-width: 520px;
  font-size: 13px;
}

.kv-label {
  color: var(--text-2);
  font-size: 12px;
}

.kv-value {
  min-width: 0;
  overflow-wrap: anywhere;
}

.mt {
  margin-top: var(--sp-6);
}

/* ── 面板切换 ─────────────────────────────────────────────── */

.panel-enter-active,
.panel-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.panel-enter-from,
.panel-leave-to {
  opacity: 0;
  transform: translateY(5px);
}

/* ── 窄屏：导航退化成顶部一条横向胶囊 ─────────────────────── */

@media (max-width: 900px) {
  .settings {
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-4);
    padding: var(--sp-4) 18px var(--sp-6);
  }

  .rail {
    position: static;
    width: auto;
    flex-direction: row;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-3);
  }

  .rail-title,
  .rail-foot {
    display: none;
  }

  .nav {
    flex-direction: row;
    overflow-x: auto;
  }

  .nav-item {
    flex: none;
  }

  .body {
    height: auto;
    overflow: visible;
  }

  .row {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: var(--sp-3);
  }

  .row-control--text,
  .row-control--wrap {
    justify-content: flex-start;
  }
}
</style>
