<script setup lang="ts">
/**
 * 设置弹窗（首页右上角齿轮打开）。
 *
 * 骨架沿用原设置页：左侧分类导航 + 右侧单栏内容，一次只看一类设置，
 * 面板内一律「标签在左、控件在右、说明在标签下」，分组之间只靠留白分开。
 * 弹窗整体一块跟随 UI 风格的面板（--surface）：扁平化是实色底，
 * 毛玻璃 / 液态玻璃下透出背后壁纸（main.css 统一给 backdrop-filter 与
 * 液态玻璃的边缘光泽）。
 *
 * 所有改动最终都写回 PATCH /api/settings —— 乐观更新：
 * 本地立即生效，失败只提示不回滚（离线也能先改主题 / 网络模式）。
 * 滑块 / 取色器这类连续型控件用 saveLive()：拖动过程先 preview() 本地预览，
 * 停止后把中间值合并成一次 PATCH、只弹一次提示，否则拖一下就刷一串「已保存」。
 */
import { computed, ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import {
  NButton,
  NColorPicker,
  NInput,
  NInputNumber,
  NPopconfirm,
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
import { SETTINGS_DEFAULTS } from '@/api/settings'
import FaviconGlyph from '@/components/FaviconGlyph.vue'
import {
  SETTINGS_HINTS,
  SETTINGS_SECTIONS,
  glassStyleHint,
  glassTransparencyHint,
  type SectionKey,
} from './settings-text'

const props = defineProps<{ show: boolean }>()

const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

function close(): void {
  emit('update:show', false)
}

const message = useMessage()
const settings = useSettingsStore()
const itemsStore = useItemsStore()
const network = useNetworkStore()
const monitor = useMonitorStore()

const { error } = storeToRefs(settings)

async function save(patch: Record<string, unknown>, label: string, quiet = false): Promise<void> {
  const ok = await settings.patch(patch)
  if (ok) {
    if (!quiet) message.success(`${label} 已保存`)
  } else {
    message.error(`${label} 保存到服务端失败（已保留本地改动）`)
  }
}

/**
 * 连续型控件（滑块 / 取色器 / URL 输入）专用：每个中间值先 preview 到本地
 * 保证实时预览，PATCH 请求与成功提示去抖合并成一次。
 */
const live: { body: Record<string, unknown>; label: string; quiet: boolean } = {
  body: {},
  label: '',
  quiet: false,
}
let liveTimer: ReturnType<typeof setTimeout> | null = null

function saveLive(patch: Record<string, unknown>, label: string, quiet = false): void {
  settings.preview(patch)
  Object.assign(live.body, patch)
  live.label = label
  live.quiet = quiet
  if (liveTimer !== null) clearTimeout(liveTimer)
  liveTimer = setTimeout(() => {
    liveTimer = null
    void commitLive()
  }, 500)
}

async function commitLive(): Promise<void> {
  const body = live.body
  const label = live.label
  const quiet = live.quiet
  live.body = {}
  if (Object.keys(body).length === 0) return
  const ok = await settings.patch(body)
  if (ok) {
    if (!quiet) message.success(`${label} 已保存`)
  } else {
    message.error(`${label} 保存到服务端失败（已保留本地改动）`)
  }
}

// ── 开关生命周期：Esc 关闭 + 「关于」数据按需加载 ─────────────

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}

watch(
  () => props.show,
  (open) => {
    if (open) {
      document.addEventListener('keydown', onKeydown)
      void loadAbout()
    } else {
      document.removeEventListener('keydown', onKeydown)
    }
  },
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  // 还有没落库的去抖改动就立刻补发，避免丢最后一次调整
  if (liveTimer !== null) {
    clearTimeout(liveTimer)
    liveTimer = null
    void commitLive()
  }
})

// ── 导航 ─────────────────────────────────────────────────────

const active = ref<SectionKey>('appearance')
const activeSection = computed(
  () => SETTINGS_SECTIONS.find((s) => s.key === active.value) ?? SETTINGS_SECTIONS[0],
)

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
  { label: '纯色', value: 'solid' },
  { label: '渐变', value: 'gradient' },
  { label: '自定义图片', value: 'asset' },
  { label: '必应每日壁纸', value: 'bing' },
]

const cardSizeOptions = [
  { label: '紧凑', value: 'sm' },
  { label: '标准', value: 'md' },
  { label: '宽松', value: 'lg' },
]

/** 壁纸直排文字（标题/时钟/分组名）颜色：壁纸明暗不随主题，需要可手动定 */
const wallpaperTextOptions = [
  { label: '跟随主题（默认）', value: 'auto' },
  { label: '白色', value: 'light' },
  { label: '黑色', value: 'dark' },
]

/** 全局打开方式：所有卡片共用一个值（原先是卡片级字段，已取消） */
const openModeOptions = [
  { label: '新窗口', value: 'newTab' },
  { label: '当前窗口', value: 'self' },
]

const glassStyleOptions = [
  { label: '扁平化（默认）', value: 'solid' },
  { label: '毛玻璃', value: 'frost' },
  { label: '液态玻璃', value: 'liquid' },
]

/** 卡片透明度滑杆：每种风格独立配置（ui.*Transparency），滑杆只读写当前风格那份 */
const TRANSPARENCY_KEY = {
  solid: 'ui.solidTransparency',
  frost: 'ui.frostTransparency',
  liquid: 'ui.liquidTransparency',
} as const

/** 模糊半径滑杆：frost / liquid 各一份（solid 无模糊，取 frost 那份仅作占位） */
const blurKey = computed(() =>
  settings.glassStyle === 'liquid' ? 'ui.liquidBlur' : 'ui.frostBlur',
)

const glassTransparencyLabel = computed(() => {
  const t = settings.cardTransparency
  if (t <= 0) return '不透明'
  if (t >= 100) return '透明'
  return `${t}%`
})

/** 当前风格的出厂默认值（用于滑杆上的「重置」按钮） */
const defaultTransparency = computed(() => SETTINGS_DEFAULTS[TRANSPARENCY_KEY[settings.glassStyle]])
const defaultBlur = computed(() => SETTINGS_DEFAULTS[blurKey.value])

function resetTransparency(): void {
  void save({ [TRANSPARENCY_KEY[settings.glassStyle]]: defaultTransparency.value }, '卡片透明度')
}

function resetBlur(): void {
  void save({ [blurKey.value]: defaultBlur.value }, '模糊度')
}

/**
 * 滑杆数值「点击就能输入」：平时是只读文本（按钮），点击后换成 number 输入框，
 * 回车 / 失焦提交、Esc 取消。提交时夹到滑杆区间，并沿用 saveLive 的去抖合并，
 * 避免连打多次请求。
 */
type NumericSlider = 'transparency' | 'blur'
const editing = ref<NumericSlider | null>(null)
const draft = ref('')
const editInput = ref<HTMLInputElement | null>(null)

function startEdit(which: NumericSlider, value: number): void {
  editing.value = which
  draft.value = String(value)
  void nextTick(() => {
    editInput.value?.focus()
    editInput.value?.select()
  })
}

function cancelEdit(): void {
  editing.value = null
}

function commitEdit(which: NumericSlider, min: number, max: number): void {
  if (editing.value !== which) return
  const parsed = Number(draft.value)
  editing.value = null
  if (!Number.isFinite(parsed)) return
  const next = Math.min(max, Math.max(min, Math.round(parsed)))
  if (which === 'transparency') {
    if (next === settings.cardTransparency) return
    saveLive({ [TRANSPARENCY_KEY[settings.glassStyle]]: next }, '卡片透明度', true)
  } else {
    if (next === settings.cardBlur) return
    saveLive({ [blurKey.value]: next }, '模糊度', true)
  }
}

/** 壁纸文件中转：不落库，仅把可访问地址写进 wallpaper.value */
const wallpaperUrl = computed({
  get: () => (typeof settings.wallpaperValue === 'string' ? settings.wallpaperValue : ''),
  set: (v: string) => saveLive({ 'wallpaper.value': v || null }, '壁纸'),
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

/** 外观面板涉及的全部键：还原时整体写回 SETTINGS_DEFAULTS 的值 */
const APPEARANCE_KEYS = [
  'theme.mode',
  'theme.accent',
  'ui.glassStyle',
  'ui.solidTransparency',
  'ui.frostTransparency',
  'ui.liquidTransparency',
  'ui.frostBlur',
  'ui.liquidBlur',
  'ui.glassScale',
  'ui.glassChroma',
  'wallpaper.type',
  'wallpaper.value',
  'ui.wallpaperText',
] as const

async function resetAppearance(): Promise<void> {
  // 丢弃还没落库的去抖预览值，否则还原后旧值会再补发一次把默认值盖回去
  if (liveTimer !== null) {
    clearTimeout(liveTimer)
    liveTimer = null
    live.body = {}
  }
  const patch: Record<string, unknown> = {}
  for (const key of APPEARANCE_KEYS) patch[key] = SETTINGS_DEFAULTS[key]
  const ok = await settings.patch(patch)
  if (ok) {
    message.success('外观已恢复默认配置')
  } else {
    message.error('恢复默认失败（已保留本地改动）')
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

// ── 网络 ─────────────────────────────────────────────────────

const modeOptions = [
  { label: '内网', value: 'lan' },
  { label: '外网', value: 'wan' },
]

/** 默认网络模式切换同时走 store（双写 localStorage + PATCH） */
function setNetworkMode(value: string): void {
  if (value === 'lan' || value === 'wan') {
    network.setMode(value)
    message.success(`默认网络模式：${modeOptions.find((m) => m.value === value)?.label}`)
  }
}

/** 开关「自动选择内外网模式」（走 settings store 乐观更新） */
async function setAutoMode(value: boolean): Promise<void> {
  const ok = await network.setAutoMode(value)
  if (ok) message.success(value ? '已启用自动选择' : '已关闭自动选择')
}

// ── 监控：采样间隔 ───────────────────────────────────────────

/** 采样间隔输入框：清空（null）或非法值直接忽略，避免写入脏值 */
function commitInterval(
  key: 'monitor.interval' | 'monitor.hiddenInterval',
  value: number | null,
  label: string,
): void {
  if (value === null || !Number.isFinite(value)) return
  void save({ [key]: value }, label)
}

// ── 关于 ─────────────────────────────────────────────────────

const platform = ref<{ os: string; arch: string; hostname: string } | null>(null)
const health = ref<{ version: string; schemaVersion?: number; uptime: number; pid: number } | null>(
  null,
)

async function loadAbout(): Promise<void> {
  try {
    const payload = await api.bootstrap()
    platform.value = payload.platform
  } catch {
    platform.value = null
  }
  try {
    const h = await api.health()
    health.value = { version: h.version, uptime: h.uptime, pid: h.pid }
  } catch {
    health.value = null
  }
  await monitor.loadStaticInfo()
}

/** 重启进行中：按钮转圈并挡住重复点击 */
const restarting = ref(false)

/**
 * 重启面板进程。
 *
 * 后端先回 200、200ms 后才真正关停并拉起新进程，所以 200 只代表「已受理」：
 * 这里改为轮询 /healthz，等 pid 变了才算新进程真的接管。重启窗口内请求失败
 * 是预期内的（端口正在交接），不当错误处理。
 */
async function restartPanel(): Promise<void> {
  if (restarting.value) return
  restarting.value = true

  // 先拿到旧 pid 作为比对基准；关于页没加载完时补一次，避免把「首次拿到 pid」
  // 误判成「新进程已就绪」
  let oldPid = health.value?.pid ?? 0
  if (!oldPid) {
    try {
      oldPid = (await api.health()).pid
    } catch {
      /* 拿不到就保持 0，后面按超时处理 */
    }
  }

  try {
    await api.system.restart()
  } catch {
    // 旧进程可能在回包前就关停了，网络层报错同样视为重启已触发
  }

  if (await waitForNewProcess(oldPid)) {
    await loadAbout()
    message.success('面板已重启')
  } else {
    message.error('重启超时：请检查面板进程是否已启动')
  }
  restarting.value = false
}

/** 轮询 /healthz，直到 pid 与旧进程不同（新进程接管）或超时 */
async function waitForNewProcess(oldPid: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700))
    try {
      const h = await api.health()
      if (h.pid && h.pid !== oldPid) return true
    } catch {
      /* 重启窗口内连不上，继续等 */
    }
  }
  return false
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" class="settings-overlay" @click.self="close">
        <div class="settings-modal" role="dialog" aria-modal="true" aria-label="设置">
          <aside class="rail">
            <button class="back" type="button" @click="close">
              <span class="back-arrow" aria-hidden="true">←</span>
              返回桌面
            </button>

            <h1 class="rail-title">设置</h1>

            <nav class="nav" aria-label="设置分类">
              <button
                v-for="s in SETTINGS_SECTIONS"
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
                      <span class="hint dim">{{ SETTINGS_HINTS.themeMode }}</span>
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
                        @update:value="(v: string) => saveLive({ 'theme.accent': v }, '主题色')"
                      />
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">UI 风格</span>
                      <span class="hint dim">{{ glassStyleHint(settings.glassStyle) }}</span>
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

                  <div class="row row--slider">
                    <div class="row-label">
                      <span class="label">卡片透明度</span>
                      <span class="hint dim">{{ glassTransparencyHint(settings.glassStyle) }}</span>
                    </div>
                    <div class="row-control">
                      <div class="slider">
                        <NSlider
                          :value="settings.cardTransparency"
                          :min="0"
                          :max="100"
                          :step="1"
                          @update:value="
                            (v: number) =>
                              saveLive(
                                { [TRANSPARENCY_KEY[settings.glassStyle]]: v },
                                '卡片透明度',
                                true,
                              )
                          "
                        />
                        <input
                          v-if="editing === 'transparency'"
                          ref="editInput"
                          v-model="draft"
                          class="slider-input mono"
                          type="number"
                          inputmode="numeric"
                          min="0"
                          max="100"
                          step="1"
                          @keydown.enter.prevent="commitEdit('transparency', 0, 100)"
                          @keydown.esc.stop="cancelEdit"
                          @blur="commitEdit('transparency', 0, 100)"
                        />
                        <button
                          v-else
                          class="slider-value mono"
                          type="button"
                          title="点击输入具体数值"
                          @click="startEdit('transparency', settings.cardTransparency)"
                        >
                          {{ glassTransparencyLabel }}
                        </button>
                        <button
                          class="slider-reset"
                          type="button"
                          :title="`恢复默认（${defaultTransparency}%）`"
                          :aria-label="`卡片透明度恢复默认（${defaultTransparency}%）`"
                          :disabled="settings.cardTransparency === defaultTransparency"
                          @click="resetTransparency"
                        >
                          <FaviconGlyph name="refresh" :size="13" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div v-if="settings.glassStyle !== 'solid'" class="row row--slider">
                    <div class="row-label">
                      <span class="label">模糊度</span>
                      <span class="hint dim">{{ SETTINGS_HINTS.blur }}</span>
                    </div>
                    <div class="row-control">
                      <div class="slider">
                        <NSlider
                          :value="settings.cardBlur"
                          :min="0"
                          :max="48"
                          :step="1"
                          @update:value="(v: number) => saveLive({ [blurKey]: v }, '模糊度', true)"
                        />
                        <input
                          v-if="editing === 'blur'"
                          ref="editInput"
                          v-model="draft"
                          class="slider-input mono"
                          type="number"
                          inputmode="numeric"
                          min="0"
                          max="48"
                          step="1"
                          @keydown.enter.prevent="commitEdit('blur', 0, 48)"
                          @keydown.esc.stop="cancelEdit"
                          @blur="commitEdit('blur', 0, 48)"
                        />
                        <button
                          v-else
                          class="slider-value mono"
                          type="button"
                          title="点击输入具体数值"
                          @click="startEdit('blur', settings.cardBlur)"
                        >
                          {{ settings.cardBlur }}px
                        </button>
                        <button
                          class="slider-reset"
                          type="button"
                          :title="`恢复默认（${defaultBlur}px）`"
                          :aria-label="`模糊度恢复默认（${defaultBlur}px）`"
                          :disabled="settings.cardBlur === defaultBlur"
                          @click="resetBlur"
                        >
                          <FaviconGlyph name="refresh" :size="13" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">壁纸类型</span>
                      <span class="hint dim">{{ SETTINGS_HINTS.wallpaperType }}</span>
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
                        @update:value="(v: string) => saveLive({ 'wallpaper.value': v }, '壁纸颜色')"
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
                        <span class="hint dim">{{ SETTINGS_HINTS.wallpaperUpload }}</span>
                      </div>
                      <div class="row-control">
                        <label class="file">
                          <input type="file" accept="image/*" @change="onWallpaperFile" />
                          <span>{{ wallpaperUploading ? '上传中…' : '选择图片' }}</span>
                        </label>
                      </div>
                    </div>
                  </template>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">壁纸文字颜色</span>
                      <span class="hint dim">{{ SETTINGS_HINTS.wallpaperText }}</span>
                    </div>
                    <div class="row-control">
                      <NSelect
                        :value="settings.wallpaperText"
                        :options="wallpaperTextOptions"
                        size="small"
                        :consistent-menu-width="false"
                        @update:value="(v: string) => save({ 'ui.wallpaperText': v }, '壁纸文字颜色')"
                      />
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">还原默认配置</span>
                      <span class="hint dim">{{ SETTINGS_HINTS.resetAppearance }}</span>
                    </div>
                    <div class="row-control row-control--start">
                      <NPopconfirm @positive-click="resetAppearance">
                        <template #trigger>
                          <NButton size="small" tertiary>还原默认</NButton>
                        </template>
                        外观的所有选项都将恢复为默认值，确定继续？
                      </NPopconfirm>
                    </div>
                  </div>
                </template>

                <!-- ── 首页 ─────────────────────────────────────── -->
                <template v-else-if="active === 'home'">
                  <div class="row">
                    <div class="row-label">
                      <span class="label">首页标题</span>
                      <span class="hint dim">{{ SETTINGS_HINTS.homeTitle }}</span>
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
                      <span class="hint dim">{{ SETTINGS_HINTS.showClock }}</span>
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
                      <span class="hint dim">{{ SETTINGS_HINTS.cardSize }}</span>
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
                      <span class="hint dim">{{ SETTINGS_HINTS.openMode }}</span>
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
                      <span class="hint dim">{{ SETTINGS_HINTS.showMonitor }}</span>
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
                      <span class="label">自动选择内外网模式</span>
                      <span class="hint dim">{{ SETTINGS_HINTS.autoMode }}</span>
                    </div>
                    <div class="row-control row-control--start">
                      <NSwitch :value="network.autoMode" size="small" @update:value="setAutoMode" />
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">默认网络模式</span>
                      <span class="hint dim">{{ SETTINGS_HINTS.networkMode }}</span>
                      <span v-if="network.persistError" class="hint dim">
                        上次写入服务端失败：{{ network.persistError }}
                      </span>
                    </div>
                    <div class="row-control">
                      <NSelect
                        :value="network.mode"
                        :options="modeOptions"
                        size="small"
                        :disabled="network.autoMode"
                        :consistent-menu-width="false"
                        @update:value="setNetworkMode"
                      />
                    </div>
                  </div>
                </template>

                <!-- ── 监控 ─────────────────────────────────────── -->
                <template v-else-if="active === 'monitor'">
                  <div class="row">
                    <div class="row-label">
                      <span class="label">采样间隔</span>
                      <span class="hint dim">{{ SETTINGS_HINTS.monitorInterval }}</span>
                    </div>
                    <div class="row-control">
                      <NInputNumber
                        :value="settings.monitorInterval"
                        :min="100"
                        :max="60_000"
                        :step="100"
                        size="small"
                        :update-value-on-input="false"
                        @update:value="
                          (v: number | null) => commitInterval('monitor.interval', v, '采样间隔')
                        "
                      >
                        <template #suffix>ms</template>
                      </NInputNumber>
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">后台采样间隔</span>
                      <span class="hint dim">{{ SETTINGS_HINTS.hiddenInterval }}</span>
                    </div>
                    <div class="row-control">
                      <NInputNumber
                        :value="settings.get('monitor.hiddenInterval')"
                        :min="100"
                        :max="600_000"
                        :step="100"
                        size="small"
                        :update-value-on-input="false"
                        @update:value="
                          (v: number | null) =>
                            commitInterval('monitor.hiddenInterval', v, '后台采样间隔')
                        "
                      >
                        <template #suffix>ms</template>
                      </NInputNumber>
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
                  </div>

                  <NPopconfirm @positive-click="restartPanel">
                    <template #trigger>
                      <NButton size="small" tertiary type="warning" class="mt" :loading="restarting">
                        重启
                      </NButton>
                    </template>
                    面板服务将重新启动，期间页面会短暂断连，确定继续？
                  </NPopconfirm>
                </template>
              </section>
            </Transition>
          </main>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
  background: rgba(12, 16, 24, 0.4);
}

.settings-modal {
  display: flex;
  width: min(1120px, 100%);
  height: min(720px, 100%);
  overflow: hidden;
  border-radius: var(--r-xl);
  background: var(--surface);
  /* 面材质随 UI 风格变化：solid = none（实色底），frost / liquid = 毛玻璃；
     液态玻璃的光泽与边缘光由 main.css 的 [data-glass='liquid'] .settings-modal 补上 */
  backdrop-filter: var(--glass);
  box-shadow: var(--shadow-3);
}

/* ── 左侧导航：纯白面板上直接排，不再单独成卡 ─────────────── */

.rail {
  flex: none;
  width: 224px;
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  padding: 24px 16px 20px;
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

/* ── 右侧内容 ─────────────────────────────────────────────── */

.body {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 26px 36px 36px;
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

/* 带滑杆的行：右栏加宽 5px，滑块轨道相应加长 5px */
.row--slider {
  grid-template-columns: minmax(0, 1fr) 273px;
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

/* 滑杆数值：平时是只读文本（按钮外观），点击后换成可输入的 number 框 */
.slider-value {
  flex: none;
  width: 42px;
  padding: 0 2px;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  text-align: right;
  font-size: 12px;
  color: var(--text-2);
  cursor: text;
  transition: background 0.14s ease, color 0.14s ease;
}

.slider-value:hover {
  background: var(--hover);
  color: var(--text);
}

.slider-input {
  flex: none;
  width: 42px;
  padding: 0 3px;
  border: 0;
  border-radius: var(--r-xs);
  background: var(--field);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  text-align: right;
  outline: 1px solid var(--accent);
}

/* 去掉 number 输入框的上下箭头，保持和文本态同宽 */
.slider-input::-webkit-outer-spin-button,
.slider-input::-webkit-inner-spin-button {
  margin: 0;
  -webkit-appearance: none;
}

.slider-input {
  appearance: textfield;
  -moz-appearance: textfield;
}

/* 滑杆旁的「恢复默认」小按钮：已是默认值时禁用并变淡 */
.slider-reset {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, opacity 0.14s ease;
}

.slider-reset:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.slider-reset:disabled {
  opacity: 0.28;
  cursor: default;
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

/* ── 弹窗进出场 ───────────────────────────────────────────── */

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s ease;
}

.modal-enter-active .settings-modal,
.modal-leave-active .settings-modal {
  transition: transform 0.18s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .settings-modal,
.modal-leave-to .settings-modal {
  transform: translateY(12px) scale(0.98);
}

/* ── 窄屏：弹窗铺满全屏，导航退化成顶部一条横向胶囊 ───────── */

@media (max-width: 900px) {
  .settings-overlay {
    padding: 0;
  }

  .settings-modal {
    flex-direction: column;
    width: 100%;
    height: 100%;
    border-radius: 0;
  }

  .rail {
    width: auto;
    flex-direction: row;
    align-items: center;
    gap: var(--sp-3);
    padding: 14px 18px 10px;
  }

  .rail-title {
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
    padding: 18px 18px 32px;
  }

  .row {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: var(--sp-3);
  }

  .row-control--text {
    justify-content: flex-start;
  }
}
</style>
