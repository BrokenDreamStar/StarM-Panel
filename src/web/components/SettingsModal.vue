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
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NPopconfirm,
  NSelect,
  NSlider,
  NSwitch,
  useMessage,
} from 'naive-ui'
import { PasswordSchema } from '@shared/schemas'
import { useSettingsStore } from '@/stores/settings'
import { useItemsStore } from '@/stores/items'
import { useNetworkStore } from '@/stores/network'
import { useMonitorStore } from '@/stores/monitor'
import { useAuthStore } from '@/stores/auth'
import { api, type BackupImportMode } from '@/api/client'
import { SETTINGS_DEFAULTS } from '@/api/settings'
import { useDeleteConfirm } from '@/composables/useDeleteConfirm'
import { fmtUptimeFull } from '@/utils/format'
import FaviconGlyph from '@/components/FaviconGlyph.vue'
import { TEXT as T, type SectionKey } from '@shared/text'

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
const auth = useAuthStore()
// 二级确认弹窗（退出登录 / 退出所有设备），与卡片删除共用同一套弹窗
const { confirm } = useDeleteConfirm()

const { error } = storeToRefs(settings)

async function save(patch: Record<string, unknown>, label: string, quiet = false): Promise<void> {
  const ok = await settings.patch(patch)
  if (ok) {
    if (!quiet) message.success(T.settings.saved(label))
  } else {
    message.error(T.settings.saveFailed(label))
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
    if (!quiet) message.success(T.settings.saved(label))
  } else {
    message.error(T.settings.saveFailed(label))
  }
}

// ── 开关生命周期：Esc 关闭 + 「关于」数据按需加载 ─────────────

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // 改密码弹窗开着时，Esc 只关弹窗 —— 别把整个设置面板一起关掉
  if (passwordOpen.value) {
    closePasswordDialog()
    return
  }
  // 导入 / 导出弹窗同理：它们自己有「取消」，Esc 也先只收弹窗
  if (importOpen.value) {
    closeImportDialog()
    return
  }
  if (exportOpen.value) {
    closeExportDialog()
    return
  }
  close()
}

watch(
  () => props.show,
  (open) => {
    if (open) {
      document.addEventListener('keydown', onKeydown)
      void loadAbout()
      // 「安全」面板要展示上次登录时间 / 来源 IP / 会话有效期 —— 这几个字段
      // 只有 state 接口知道（会话 Cookie 是 HttpOnly，前端读不到也不该读），
      // 所以打开时补一次：已登录会顺带刷新它们，正是期望行为。
      void auth.load()
    } else {
      document.removeEventListener('keydown', onKeydown)
      // 关掉设置面板时顺手收起几个子弹窗，下次打开不会自己冒出来
      closePasswordDialog()
      closeImportDialog()
      closeExportDialog()
    }
  },
)

// 打开设置时顺手把遗留的 `/api/assets/<id>` 壁纸地址自愈成 `/bg/<文件名>`
watch(
  () => props.show,
  (open) => {
    if (open) void normalizeWallpaperUrl()
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
  () => T.settings.sections.find((s) => s.key === active.value) ?? T.settings.sections[0],
)

function select(key: SectionKey): void {
  active.value = key
  // 换面板后把右栏滚回顶部，否则长面板的滚动位置会跟到下一个面板
  void bodyRef.value?.scrollTo({ top: 0 })
}

const bodyRef = ref<HTMLElement | null>(null)

// ── 外观 ─────────────────────────────────────────────────────

const themeOptions = [
  { label: T.common.light, value: 'light' },
  { label: T.common.dark, value: 'dark' },
  { label: T.common.system, value: 'system' },
]

const wallpaperOptions = [
  { label: T.settings.options.wallpaperType.solid, value: 'solid' },
  { label: T.settings.options.wallpaperType.gradient, value: 'gradient' },
  { label: T.settings.options.wallpaperType.asset, value: 'asset' },
  { label: T.settings.options.wallpaperType.bing, value: 'bing' },
]

const cardSizeOptions = [
  { label: T.settings.options.cardSize.sm, value: 'sm' },
  { label: T.settings.options.cardSize.md, value: 'md' },
  { label: T.settings.options.cardSize.lg, value: 'lg' },
]

/** 壁纸直排文字（标题/时钟/分组名）颜色：壁纸明暗不随主题，需要可手动定 */
const wallpaperTextOptions = [
  { label: T.settings.options.wallpaperText.auto, value: 'auto' },
  { label: T.settings.options.wallpaperText.light, value: 'light' },
  { label: T.settings.options.wallpaperText.dark, value: 'dark' },
]

/** 全局打开方式：所有卡片共用一个值（原先是卡片级字段，已取消） */
const openModeOptions = [
  { label: T.settings.options.openMode.newTab, value: 'newTab' },
  { label: T.settings.options.openMode.self, value: 'self' },
]

const glassStyleOptions = [
  { label: T.settings.options.glassStyle.solid, value: 'solid' },
  { label: T.settings.options.glassStyle.frost, value: 'frost' },
  { label: T.settings.options.glassStyle.liquid, value: 'liquid' },
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
  if (t <= 0) return T.settings.opaque
  if (t >= 100) return T.settings.transparent
  return `${t}%`
})

/** 当前风格的出厂默认值（用于滑杆上的「重置」按钮） */
const defaultTransparency = computed(() => SETTINGS_DEFAULTS[TRANSPARENCY_KEY[settings.glassStyle]])
const defaultBlur = computed(() => SETTINGS_DEFAULTS[blurKey.value])

function resetTransparency(): void {
  void save(
    { [TRANSPARENCY_KEY[settings.glassStyle]]: defaultTransparency.value },
    T.settings.labels.transparency,
  )
}

function resetBlur(): void {
  void save({ [blurKey.value]: defaultBlur.value }, T.settings.labels.blur)
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
    saveLive(
      { [TRANSPARENCY_KEY[settings.glassStyle]]: next },
      T.settings.labels.transparency,
      true,
    )
  } else {
    if (next === settings.cardBlur) return
    saveLive({ [blurKey.value]: next }, T.settings.labels.blur, true)
  }
}

/**
 * 壁纸文件中转：不落库，仅把可访问地址写进 wallpaper.value。
 *
 * 上传成功后写的是**文件直链** `/bg/<文件名>`（壁纸就是数据目录 bg/ 下的图），
 * 而不是内容哈希接口 `/api/assets/<id>` —— 后者只有图标 / favicon 才用。
 */
const wallpaperUrl = computed({
  get: () => (typeof settings.wallpaperValue === 'string' ? settings.wallpaperValue : ''),
  set: (v: string) => saveLive({ 'wallpaper.value': v || null }, T.settings.labelWallpaper),
})

const wallpaperUploading = ref(false)

async function onWallpaperFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    message.error(T.common.chooseImageFile)
    return
  }
  wallpaperUploading.value = true
  try {
    const asset = await api.assets.upload(file, 'wallpaper')
    // bgUrl 不存在时（理论上只有图标）回落到哈希接口，至少能用
    await save(
      { 'wallpaper.type': 'asset', 'wallpaper.value': asset.bgUrl ?? asset.url },
      T.settings.labelWallpaper,
    )
  } catch (e) {
    message.error(
      T.settings.wallpaperUploadFailed(e instanceof Error ? e.message : T.common.unknownError),
    )
  } finally {
    wallpaperUploading.value = false
  }
}

/** 早期版本写进设置的壁纸地址：`/api/assets/<内容哈希>` */
const LEGACY_WALLPAPER_URL = /^\/api\/assets\/([0-9a-f]{16})$/i

/**
 * 老数据自愈：把设置里遗留的 `/api/assets/<id>` 改写成 `/bg/<文件名>`，
 * 让「图片地址」显示的就是 bg/ 下那个文件。
 *
 * 只在确认该资源确实有文件（`bgUrl`）时才改：内容寻址去重会让同一张图带着
 * icon 的身份留在库里，那种情况没有文件，改了反而 404。失败静默 —— 旧地址
 * 照样能取到图，不该因为一次自愈失败打扰用户。
 */
async function normalizeWallpaperUrl(): Promise<void> {
  if (settings.wallpaperType !== 'asset') return
  const value = typeof settings.wallpaperValue === 'string' ? settings.wallpaperValue : ''
  const matched = LEGACY_WALLPAPER_URL.exec(value)
  if (!matched) return
  try {
    const list = await api.assets.list('wallpaper')
    const hit = list.find((a) => a.id === matched[1] && a.bgUrl)
    if (hit?.bgUrl) await settings.patch({ 'wallpaper.value': hit.bgUrl })
  } catch {
    /* 自愈是尽力而为 */
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
  'ui.cardSize',
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
    message.success(T.settings.appearanceReset)
  } else {
    message.error(T.settings.resetFailed)
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
  void save({ 'ui.title': next }, T.settings.labels.homeTitle)
}

// ── 网络 ─────────────────────────────────────────────────────

const modeOptions = [
  { label: T.common.lan, value: 'lan' },
  { label: T.common.wan, value: 'wan' },
]

/** 默认网络模式切换同时走 store（双写 localStorage + PATCH） */
function setNetworkMode(value: string): void {
  if (value === 'lan' || value === 'wan') {
    network.setMode(value)
    message.success(
      T.settings.networkModeSet(modeOptions.find((m) => m.value === value)?.label ?? value),
    )
  }
}

/** 开关「自动选择内外网模式」（走 settings store 乐观更新） */
async function setAutoMode(value: boolean): Promise<void> {
  const ok = await network.setAutoMode(value)
  if (ok) message.success(value ? T.settings.autoModeOn : T.settings.autoModeOff)
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

// ── 安全：会话 / 登录保护 / 密码 ─────────────────────────────

/**
 * 登录保护开关。
 *
 * 这里只处理「开」：把面板开放给网络是危险操作，关闭必须过 NPopconfirm；
 * 确认层用 `disabled` 控制，只有当前是「开」的时候点开关才弹确认，
 * 「关」的状态下点开关会被放行到这里直接落库。
 * 值一律读设置缓存 auth.enabled，写仍走现有 save()，与其它设置项同一条路径。
 */
function setLoginGuard(value: boolean): void {
  if (value) void save({ 'auth.enabled': true }, T.settings.labels.loginProtection)
}

/** 上次登录时间戳 → 本地时间；没有记录（从未登录过）时显示占位符 */
function fmtLoginTime(ts: number | null): string {
  if (ts === null) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

// 修改密码：草稿只活在弹窗里，关闭即清空 —— 设置页上不留任何密码输入框
const passwordOpen = ref(false)
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const currentPwRef = ref<InstanceType<typeof NInput> | null>(null)

/** 密码规则直接复用后端 schema，提示文案不会两边漂移（同 LoginView） */
function checkPassword(value: string): string | null {
  const result = PasswordSchema.safeParse(value)
  if (result.success) return null
  return result.error.issues[0]?.message ?? T.common.passwordInvalid
}

function clearPasswordDraft(): void {
  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
}

async function openPasswordDialog(): Promise<void> {
  clearPasswordDraft()
  auth.clearError()
  passwordOpen.value = true
  // NModal 是 teleport 出来的，等挂载完再聚焦
  await nextTick()
  currentPwRef.value?.focus()
}

function closePasswordDialog(): void {
  passwordOpen.value = false
  clearPasswordDraft()
}

/**
 * 修改密码：先本地校验（规则 + 两次输入一致），不合法就只弹提示、不发请求；
 * 通过后交给 store，失败文案用 store 里后端返回的那句。
 */
async function submitPasswordChange(): Promise<void> {
  if (auth.busy) return
  if (!currentPassword.value) {
    message.error(T.settings.enterCurrentPassword)
    return
  }
  const problem = checkPassword(newPassword.value)
  if (problem) {
    message.error(problem)
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    message.error(T.common.passwordMismatch)
    return
  }
  if (await auth.changePassword(currentPassword.value, newPassword.value)) {
    closePasswordDialog()
    message.success(T.settings.passwordChanged)
  } else {
    message.error(auth.error ?? T.settings.changePasswordFailed)
  }
}

/** 退出当前设备（store 保证失败也会切回锁屏，所以这里只报成功） */
async function logoutHere(): Promise<void> {
  await auth.logout()
  message.success(T.settings.loggedOut)
}

/** 退出所有设备：成功才会作废全部令牌，失败要如实报错 */
async function revokeAllDevices(): Promise<void> {
  await auth.revokeAll()
  if (auth.error) message.error(auth.error)
  else message.success(T.settings.revokedAll)
}

/**
 * 退出登录 / 退出所有设备的两级确认。
 *
 * 一级是按钮上的 NPopconfirm 气泡，这里接二级应用内弹窗 —— 与卡片删除同一套
 * 确认体验：两个动作都会当场作废会话、本机也要重新输密码，误点代价大。
 */
async function confirmLogout(): Promise<void> {
  const ok = await confirm({
    title: T.settings.labels.logout,
    content: T.settings.logoutDialogContent,
    positiveText: T.settings.labels.logout,
  })
  if (ok) await logoutHere()
}

async function confirmRevokeAll(): Promise<void> {
  const ok = await confirm({
    title: T.settings.labels.revokeAll,
    content: T.settings.revokeAllDialogContent,
    positiveText: T.settings.labels.revokeAll,
  })
  if (ok) await revokeAllDevices()
}

// ── 数据：备份导出 / 导入（换机迁移） ────────────────────────

/**
 * 导出弹窗：导出内容（含资源 / 仅配置）跟导入一样收进弹窗，不再占设置页的一行。
 *
 * 图标与壁纸在卡片里存的是本机地址（/api/assets/…），换台机器就失效了，
 * 所以默认选「含图标与壁纸」，只想备份配置（进版本库、文件够小）时再切到「仅配置」。
 */
const exportOpen = ref(false)
const exportWithAssets = ref(true)
const exporting = ref(false)

const exportOptions = [
  {
    value: true,
    label: T.settings.exportDialog.withAssets,
    desc: T.settings.exportDialog.withAssetsDesc,
  },
  {
    value: false,
    label: T.settings.exportDialog.configOnly,
    desc: T.settings.exportDialog.configOnlyDesc,
  },
]

function openExportDialog(): void {
  resetExportDialog()
  exportOpen.value = true
}

function closeExportDialog(): void {
  exportOpen.value = false
}

/** 关掉弹窗就回到默认选项，不把上一次的选择当成隐藏状态留给下次 */
function resetExportDialog(): void {
  exportWithAssets.value = true
}

/** 把文本存成本地文件：Blob + 一次性 <a download>，不新开页面 */
function downloadTextFile(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 时部分浏览器还没取到数据，放到下一轮事件循环更稳
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

async function exportBackup(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    // 文件名以后端 content-disposition 为准（见 api/client.ts 的 exportBackup）
    const { filename, text } = await api.backup.export({ assets: exportWithAssets.value })
    downloadTextFile(text, filename)
    closeExportDialog()
    message.success(T.settings.exported)
  } catch (e) {
    message.error(T.settings.exportFailed(e instanceof Error ? e.message : T.common.unknownError))
  } finally {
    exporting.value = false
  }
}

/**
 * 导入弹窗：导入是两步流程（选文件 → 选合并 / 覆盖），不再是设置页上的两个行。
 *
 * `importModeOptions` 只有两个语义固定的选项，用自绘的整行单选卡片而不是
 * NSelect —— 覆盖会清空现有卡片，两种方式的差别必须一眼能看见，而不是藏在下拉里。
 */
const importOpen = ref(false)
const importFile = ref<File | null>(null)
const importMode = ref<BackupImportMode>('merge')
const importing = ref(false)

const importModeOptions = [
  {
    value: 'merge' as const,
    label: T.settings.importDialog.merge,
    desc: T.settings.importDialog.mergeDesc,
  },
  {
    value: 'replace' as const,
    label: T.settings.importDialog.replace,
    desc: T.settings.importDialog.replaceDesc,
  },
]

function openImportDialog(): void {
  resetImportDialog()
  importOpen.value = true
}

function closeImportDialog(): void {
  importOpen.value = false
}

/** 关掉弹窗就丢掉草稿：下次打开回到「还没选文件」的第一步 */
function resetImportDialog(): void {
  importFile.value = null
  importMode.value = 'merge'
}

/** 选文件：顺手清空 input，这样再选同一个文件也能触发 change */
function onImportFile(event: Event): void {
  const input = event.target as HTMLInputElement
  importFile.value = input.files?.[0] ?? null
  input.value = ''
}

/**
 * 导入备份。
 *
 * 前端只做「是不是 JSON」这一层解析，字段结构一律交给后端校验
 * （routes/backup.ts 的 BackupSchema）—— 校验规则只有一份。
 * 覆盖会清空现有卡片，因此除了弹窗里显式选中「覆盖」，还要再过一次应用内确认。
 */
async function runImport(): Promise<void> {
  const file = importFile.value
  if (!file || importing.value) return

  if (importMode.value === 'replace') {
    const ok = await confirm({
      title: T.settings.overwriteTitle,
      content: T.settings.overwriteConfirm,
      positiveText: T.settings.overwriteConfirmButton,
    })
    if (!ok) return
  }

  importing.value = true
  try {
    let payload: unknown
    try {
      payload = JSON.parse(await file.text())
    } catch {
      message.error(T.settings.invalidBackup)
      return
    }

    const mode = importMode.value
    const result = await api.backup.import(payload, mode)
    await refreshAfterImport()
    closeImportDialog()
    const { groups: g, items: i, assets: a } = result.imported
    message.success(
      T.settings.importDone(g, i, a) + (mode === 'replace' ? T.settings.importCleared : ''),
    )
  } catch (e) {
    message.error(T.settings.importFailed(e instanceof Error ? e.message : T.common.unknownError))
  } finally {
    importing.value = false
  }
}

/**
 * 导入后把前端状态拉回服务端真值：走与首屏同一个 bootstrap，
 * 一次把分组 / 卡片 / 设置 / 版本全部换掉，不在这里逐个接口拼。
 *
 * 网络模式**强制**以服务端为准（force=true）—— 备份里的默认模式应当立刻生效，
 * 而不是被本次会话早先同步过的本地值挡住（syncFromServer 默认只对齐一次）。
 */
async function refreshAfterImport(): Promise<void> {
  try {
    const payload = await api.bootstrap()
    itemsStore.hydrate(payload)
    settings.hydrate(payload.settings)
    network.syncFromServer(payload.settings['network.mode'], true)
  } catch {
    // 数据已经落库了，这里失败只是界面没跟上，刷新页面即可
    message.warning(T.settings.importReloadFailed)
  }
}

// ── 关于 ─────────────────────────────────────────────────────

const platform = ref<{ os: string; arch: string; hostname: string } | null>(null)
const health = ref<{ version: string; schemaVersion?: number; uptime: number; pid: number } | null>(
  null,
)

/**
 * 运行时长走本地走秒：/healthz 的 uptime 只在打开弹窗 / 重启后取一次，
 * 而展示口径已细到秒，不复读的话读数会冻在打开那一刻。
 *
 * 用「取数时刻 + 当前时刻」算差值，而不是每秒累加一个计数器：
 * 切到别的分类、标签页被后台节流时定时器会停摆或掉拍，累加会永久少算，
 * 取时间戳差值则在下一拍自动追平。定时器只在弹窗打开期间跑。
 */
const uptimeAnchor = ref<{ seconds: number; at: number } | null>(null)
const nowTs = ref(Date.now())
let uptimeTimer: ReturnType<typeof setInterval> | null = null

const uptimeSeconds = computed(() =>
  uptimeAnchor.value === null
    ? null
    : uptimeAnchor.value.seconds + Math.floor((nowTs.value - uptimeAnchor.value.at) / 1000),
)

watch(
  () => props.show,
  (open) => {
    if (uptimeTimer !== null) {
      clearInterval(uptimeTimer)
      uptimeTimer = null
    }
    if (!open) return
    nowTs.value = Date.now()
    uptimeTimer = setInterval(() => (nowTs.value = Date.now()), 1000)
  },
  { immediate: true },
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
    uptimeAnchor.value = { seconds: h.uptime, at: Date.now() }
  } catch {
    health.value = null
    uptimeAnchor.value = null
  }
  await monitor.loadStaticInfo()
}

onBeforeUnmount(() => {
  if (uptimeTimer !== null) {
    clearInterval(uptimeTimer)
    uptimeTimer = null
  }
})

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
    message.success(T.settings.restarted)
  } else {
    message.error(T.settings.restartTimeout)
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
        <div class="settings-modal" role="dialog" aria-modal="true" :aria-label="T.settings.ariaLabel">
          <aside class="rail">
            <button class="back" type="button" @click="close">
              <span class="back-arrow" aria-hidden="true">←</span>
              {{ T.settings.backToDesktop }}
            </button>

            <h1 class="rail-title">{{ T.settings.title }}</h1>

            <nav class="nav" :aria-label="T.settings.navAriaLabel">
              <button
                v-for="s in T.settings.sections"
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
                  <p v-if="activeSection.desc" class="dim">{{ activeSection.desc }}</p>
                </header>

                <!-- ── 外观 ─────────────────────────────────────── -->
                <template v-if="active === 'appearance'">
                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.themeMode }}</span>
                      <span v-if="T.settings.hints.themeMode" class="hint dim">{{ T.settings.hints.themeMode }}</span>
                    </div>
                    <div class="row-control">
                      <NSelect
                        :value="settings.themeMode"
                        :options="themeOptions"
                        size="small"
                        :consistent-menu-width="false"
                        @update:value="(v: string) => save({ 'theme.mode': v }, T.settings.labels.themeMode)"
                      />
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.accent }}</span>
                      <span v-if="T.settings.hints.accent" class="hint dim">{{ T.settings.hints.accent }}</span>
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
                        @update:value="(v: string) => saveLive({ 'theme.accent': v }, T.settings.labels.accent)"
                      />
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.glassStyle }}</span>
                      <span v-if="T.settings.glassStyleHint(settings.glassStyle)" class="hint dim">{{ T.settings.glassStyleHint(settings.glassStyle) }}</span>
                    </div>
                    <div class="row-control">
                      <NSelect
                        :value="settings.glassStyle"
                        :options="glassStyleOptions"
                        size="small"
                        :consistent-menu-width="false"
                        @update:value="(v: string) => save({ 'ui.glassStyle': v }, T.settings.labels.glassStyle)"
                      />
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.transparency }}</span>
                      <span v-if="T.settings.glassTransparencyHint(settings.glassStyle)" class="hint dim">{{ T.settings.glassTransparencyHint(settings.glassStyle) }}</span>
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
                                T.settings.labels.transparency,
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
                          :title="T.settings.sliderInputTitle"
                          @click="startEdit('transparency', settings.cardTransparency)"
                        >
                          {{ glassTransparencyLabel }}
                        </button>
                        <button
                          class="slider-reset"
                          type="button"
                          :title="T.settings.resetToDefaultPct(defaultTransparency)"
                          :aria-label="T.settings.transparencyResetAria(defaultTransparency)"
                          :disabled="settings.cardTransparency === defaultTransparency"
                          @click="resetTransparency"
                        >
                          <FaviconGlyph name="refresh" :size="13" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div v-if="settings.glassStyle !== 'solid'" class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.blur }}</span>
                      <span v-if="T.settings.hints.blur" class="hint dim">{{ T.settings.hints.blur }}</span>
                    </div>
                    <div class="row-control">
                      <div class="slider">
                        <NSlider
                          :value="settings.cardBlur"
                          :min="0"
                          :max="48"
                          :step="1"
                          @update:value="(v: number) => saveLive({ [blurKey]: v }, T.settings.labels.blur, true)"
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
                          :title="T.settings.sliderInputTitle"
                          @click="startEdit('blur', settings.cardBlur)"
                        >
                          {{ settings.cardBlur }}px
                        </button>
                        <button
                          class="slider-reset"
                          type="button"
                          :title="T.settings.resetToDefaultPx(defaultBlur)"
                          :aria-label="T.settings.blurResetAria(defaultBlur)"
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
                      <span class="label">{{ T.settings.labels.cardSize }}</span>
                      <span v-if="T.settings.hints.cardSize" class="hint dim">{{ T.settings.hints.cardSize }}</span>
                    </div>
                    <div class="row-control">
                      <NSelect
                        :value="settings.cardSize"
                        :options="cardSizeOptions"
                        size="small"
                        :consistent-menu-width="false"
                        @update:value="(v: string) => save({ 'ui.cardSize': v }, T.settings.labels.cardSize)"
                      />
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.wallpaperType }}</span>
                      <span v-if="T.settings.hints.wallpaperType" class="hint dim">{{ T.settings.hints.wallpaperType }}</span>
                    </div>
                    <div class="row-control">
                      <NSelect
                        :value="settings.wallpaperType"
                        :options="wallpaperOptions"
                        size="small"
                        :consistent-menu-width="false"
                        @update:value="(v: string) => save({ 'wallpaper.type': v }, T.settings.labels.wallpaperType)"
                      />
                    </div>
                  </div>

                  <div v-if="settings.wallpaperType === 'solid'" class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.wallpaperColor }}</span>
                      <span v-if="T.settings.hints.wallpaperColor" class="hint dim">{{ T.settings.hints.wallpaperColor }}</span>
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
                        @update:value="(v: string) => saveLive({ 'wallpaper.value': v }, T.settings.labels.wallpaperColor)"
                      />
                    </div>
                  </div>

                  <template v-if="settings.wallpaperType === 'asset'">
                    <div class="row">
                      <div class="row-label">
                        <span class="label">{{ T.settings.labels.wallpaperUrl }}</span>
                        <span v-if="T.settings.hints.wallpaperUrl" class="hint dim">{{ T.settings.hints.wallpaperUrl }}</span>
                      </div>
                      <div class="row-control">
                        <NInput
                          v-model:value="wallpaperUrl"
                          size="small"
                          :placeholder="T.settings.wallpaperUrlPlaceholder"
                        />
                      </div>
                    </div>
                    <div class="row">
                      <div class="row-label">
                        <span class="label">{{ T.settings.labels.wallpaperUpload }}</span>
                        <span v-if="T.settings.hints.wallpaperUpload" class="hint dim">{{ T.settings.hints.wallpaperUpload }}</span>
                      </div>
                      <div class="row-control">
                        <label class="file">
                          <input type="file" accept="image/*" @change="onWallpaperFile" />
                          <span>{{ wallpaperUploading ? T.settings.uploading : T.settings.chooseImage }}</span>
                        </label>
                      </div>
                    </div>
                  </template>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.wallpaperText }}</span>
                      <span v-if="T.settings.hints.wallpaperText" class="hint dim">{{ T.settings.hints.wallpaperText }}</span>
                    </div>
                    <div class="row-control">
                      <NSelect
                        :value="settings.wallpaperText"
                        :options="wallpaperTextOptions"
                        size="small"
                        :consistent-menu-width="false"
                        @update:value="(v: string) => save({ 'ui.wallpaperText': v }, T.settings.labelWallpaperText)"
                      />
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.resetAppearance }}</span>
                      <span v-if="T.settings.hints.resetAppearance" class="hint dim">{{ T.settings.hints.resetAppearance }}</span>
                    </div>
                    <div class="row-control row-control--start">
                      <NPopconfirm @positive-click="resetAppearance">
                        <template #trigger>
                          <NButton size="small" tertiary>{{ T.settings.resetAppearanceButton }}</NButton>
                        </template>
                        {{ T.settings.resetAppearanceConfirm }}
                      </NPopconfirm>
                    </div>
                  </div>
                </template>

                <!-- ── 首页 ─────────────────────────────────────── -->
                <template v-else-if="active === 'home'">
                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.homeTitle }}</span>
                      <span v-if="T.settings.hints.homeTitle" class="hint dim">{{ T.settings.hints.homeTitle }}</span>
                    </div>
                    <div class="row-control">
                      <NInput
                        v-model:value="titleDraft"
                        size="small"
                        :placeholder="T.settings.homeTitlePlaceholder"
                        @blur="commitTitle"
                        @keydown.enter="commitTitle"
                      />
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.showClock }}</span>
                      <span v-if="T.settings.hints.showClock" class="hint dim">{{ T.settings.hints.showClock }}</span>
                    </div>
                    <div class="row-control row-control--start">
                      <NSwitch
                        :value="settings.get('ui.showClock')"
                        size="small"
                        @update:value="(v: boolean) => save({ 'ui.showClock': v }, T.settings.labelShowClock)"
                      />
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.showMonitor }}</span>
                      <span v-if="T.settings.hints.showMonitor" class="hint dim">{{ T.settings.hints.showMonitor }}</span>
                    </div>
                    <div class="row-control row-control--start">
                      <NSwitch
                        :value="settings.showMonitor"
                        size="small"
                        @update:value="(v: boolean) => save({ 'ui.showMonitor': v }, T.settings.labelShowMonitor)"
                      />
                    </div>
                  </div>
                </template>

                <!-- ── 安全 ─────────────────────────────────────── -->
                <template v-else-if="active === 'security'">
                  <!-- 会话信息：三五个字段用「规格表」排版，比拆成多行更好读 -->
                  <div class="row row--stack">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.sessions }}</span>
                      <span v-if="T.settings.hints.sessions" class="hint dim">{{ T.settings.hints.sessions }}</span>
                    </div>
                    <div class="row-control">
                      <div class="about">
                        <span class="kv-label">{{ T.settings.kv.loginState }}</span>
                        <!-- 与下面登录保护开关同源（设置缓存），刚切换时不会和开关自相矛盾 -->
                        <span class="kv-value mono">
                          {{ settings.get('auth.enabled') ? T.settings.loggedIn : T.settings.loginDisabled }}
                        </span>

                        <span class="kv-label">{{ T.settings.kv.lastLogin }}</span>
                        <span class="kv-value mono">{{ fmtLoginTime(auth.lastLoginAt) }}</span>

                        <span class="kv-label">{{ T.settings.kv.lastLoginIp }}</span>
                        <span class="kv-value mono">{{ auth.lastLoginIp ?? '—' }}</span>

                        <span class="kv-label">{{ T.settings.kv.sessionTtl }}</span>
                        <span class="kv-value mono">{{ T.duration.days(auth.sessionDays) }}</span>
                      </div>
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.loginProtection }}</span>
                      <span v-if="T.settings.hints.loginProtection" class="hint dim">{{ T.settings.hints.loginProtection }}</span>
                    </div>
                    <div class="row-control row-control--start">
                      <!-- disabled 受控：只有「开着」时点开关才弹确认，
                           关闭状态下直接放行给下面的 @update:value -->
                      <NPopconfirm
                        :disabled="!settings.get('auth.enabled')"
                        @positive-click="save({ 'auth.enabled': false }, T.settings.labels.loginProtection)"
                      >
                        <template #trigger>
                          <NSwitch
                            :value="settings.get('auth.enabled')"
                            size="small"
                            @update:value="setLoginGuard"
                          />
                        </template>
                        {{ T.settings.disableLoginConfirm }}
                      </NPopconfirm>
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.changePassword }}</span>
                      <span v-if="T.settings.hints.changePassword" class="hint dim">{{ T.settings.hints.changePassword }}</span>
                      <!-- 启动参数要等宽显示，这一句恢复时如需 <span class="mono"> 包住 --reset-auth，得拆成前后两段 -->
                      <span v-if="T.settings.hints.passwordReset" class="hint dim">{{ T.settings.hints.passwordReset }}</span>
                    </div>
                    <div class="row-control row-control--start">
                      <!-- 密码输入框不常驻设置页：点这里开弹窗，改完即关、草稿即清 -->
                      <NButton size="small" type="primary" @click="openPasswordDialog">
                        {{ T.settings.labels.changePassword }}
                      </NButton>
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.logout }}</span>
                      <span v-if="T.settings.hints.logout" class="hint dim">{{ T.settings.hints.logout }}</span>
                    </div>
                    <div class="row-control row-control--start">
                      <!-- 一级：气泡确认；二级应用内弹窗在 confirmLogout 里 -->
                      <NPopconfirm @positive-click="confirmLogout">
                        <template #trigger>
                          <NButton size="small" tertiary type="error">{{ T.settings.labels.logout }}</NButton>
                        </template>
                        {{ T.settings.logoutConfirm }}
                      </NPopconfirm>
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.revokeAll }}</span>
                      <span v-if="T.settings.hints.revokeAll" class="hint dim">{{ T.settings.hints.revokeAll }}</span>
                    </div>
                    <div class="row-control row-control--start">
                      <!-- 一级：气泡确认；二级应用内弹窗在 confirmRevokeAll 里 -->
                      <NPopconfirm @positive-click="confirmRevokeAll">
                        <template #trigger>
                          <NButton size="small" tertiary type="error">{{ T.settings.labels.revokeAll }}</NButton>
                        </template>
                        {{ T.settings.revokeAllConfirm }}
                      </NPopconfirm>
                    </div>
                  </div>
                </template>

                <!-- ── 其它（网络 / 监控 / 卡片行为） ───────────── -->
                <template v-else-if="active === 'misc'">
                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.openMode }}</span>
                      <span v-if="T.settings.hints.openMode" class="hint dim">{{ T.settings.hints.openMode }}</span>
                    </div>
                    <div class="row-control">
                      <NSelect
                        :value="settings.openMode"
                        :options="openModeOptions"
                        size="small"
                        :consistent-menu-width="false"
                        @update:value="(v: string) => save({ 'ui.openMode': v }, T.settings.labels.openMode)"
                      />
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.networkMode }}</span>
                      <span v-if="T.settings.hints.networkMode" class="hint dim">{{ T.settings.hints.networkMode }}</span>
                      <span v-if="network.persistError" class="hint dim">
                        {{ T.settings.persistFailed(network.persistError) }}
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

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.autoMode }}</span>
                      <span v-if="T.settings.hints.autoMode" class="hint dim">{{ T.settings.hints.autoMode }}</span>
                    </div>
                    <div class="row-control row-control--start">
                      <NSwitch :value="network.autoMode" size="small" @update:value="setAutoMode" />
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.monitorInterval }}</span>
                      <span v-if="T.settings.hints.monitorInterval" class="hint dim">{{ T.settings.hints.monitorInterval }}</span>
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
                          (v: number | null) => commitInterval('monitor.interval', v, T.settings.labels.monitorInterval)
                        "
                      >
                        <template #suffix>ms</template>
                      </NInputNumber>
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.hiddenInterval }}</span>
                      <span v-if="T.settings.hints.hiddenInterval" class="hint dim">{{ T.settings.hints.hiddenInterval }}</span>
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
                            commitInterval('monitor.hiddenInterval', v, T.settings.labels.hiddenInterval)
                        "
                      >
                        <template #suffix>ms</template>
                      </NInputNumber>
                    </div>
                  </div>
                </template>

                <!-- ── 数据（备份导出 / 导入） ──────────────────── -->
                <template v-else-if="active === 'data'">
                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.exportData }}</span>
                      <span v-if="T.settings.hints.exportData" class="hint dim">{{ T.settings.hints.exportData }}</span>
                    </div>
                    <div class="row-control row-control--start">
                      <!-- 导出内容（含资源 / 仅配置）在弹窗里选，与导入对称 -->
                      <NButton size="small" type="primary" @click="openExportDialog">{{ T.settings.exportButton }}</NButton>
                    </div>
                  </div>

                  <div class="row">
                    <div class="row-label">
                      <span class="label">{{ T.settings.labels.importData }}</span>
                      <span v-if="T.settings.hints.importData" class="hint dim">{{ T.settings.hints.importData }}</span>
                    </div>
                    <div class="row-control row-control--start">
                      <!-- 选文件与选方式都在弹窗里：这里只负责把流程打开 -->
                      <NButton size="small" type="primary" @click="openImportDialog">{{ T.settings.importButton }}</NButton>
                    </div>
                  </div>
                </template>

                <!-- ── 关于 ─────────────────────────────────────── -->
                <template v-else>
                  <div class="about">
                    <span class="kv-label">{{ T.settings.kv.version }}</span>
                    <span class="kv-value mono">{{ health?.version ?? itemsStore.version ?? '0.1.0' }}</span>

                    <span class="kv-label">{{ T.settings.kv.uptime }}</span>
                    <span class="kv-value mono">{{ fmtUptimeFull(uptimeSeconds) }}</span>

                    <span class="kv-label">{{ T.settings.kv.platform }}</span>
                    <span class="kv-value mono">
                      {{ platform ? `${platform.os} / ${platform.arch}` : '—' }}
                    </span>

                    <span class="kv-label">{{ T.settings.kv.hostname }}</span>
                    <span class="kv-value mono">{{ platform?.hostname ?? '—' }}</span>

                    <span class="kv-label">{{ T.settings.kv.cpu }}</span>
                    <span class="kv-value mono">{{ monitor.staticInfo?.cpu.brand || '—' }}</span>

                    <span class="kv-label">{{ T.settings.kv.kernel }}</span>
                    <span class="kv-value mono">{{ monitor.staticInfo?.os.kernel || '—' }}</span>
                  </div>

                  <div class="about-actions">
                    <NPopconfirm @positive-click="restartPanel">
                      <template #trigger>
                        <NButton size="small" tertiary type="warning" :loading="restarting">
                          {{ T.settings.restart }}
                        </NButton>
                      </template>
                      {{ T.settings.restartConfirm }}
                    </NPopconfirm>

                    <NButton size="small" tertiary type="error" @click="close">{{ T.settings.close }}</NButton>
                  </div>
                </template>
              </section>
            </Transition>
          </main>
        </div>

        <!-- 修改密码弹窗：密码输入不常驻设置页，改完即关、草稿即清 -->
        <NModal
          v-model:show="passwordOpen"
          preset="card"
          :title="T.settings.labels.changePassword"
          class="pw-modal"
          :style="{ width: '400px', maxWidth: '94vw' }"
          :mask-closable="false"
          @after-leave="clearPasswordDraft"
        >
          <NForm class="pw-form" label-placement="top" size="small">
            <NFormItem :label="T.settings.labels.currentPassword" :show-feedback="false">
              <NInput
                ref="currentPwRef"
                v-model:value="currentPassword"
                type="password"
                show-password-on="click"
                :maxlength="128"
                :placeholder="T.login.passwordPlaceholder"
                @keyup.enter="submitPasswordChange"
              />
            </NFormItem>

            <NFormItem :label="T.settings.labels.newPassword" :show-feedback="false">
              <NInput
                v-model:value="newPassword"
                type="password"
                show-password-on="click"
                :maxlength="128"
                :placeholder="T.login.passwordSetupPlaceholder"
                @keyup.enter="submitPasswordChange"
              />
            </NFormItem>

            <NFormItem :label="T.settings.labels.confirmPassword" :show-feedback="false">
              <NInput
                v-model:value="confirmPassword"
                type="password"
                show-password-on="click"
                :maxlength="128"
                :placeholder="T.login.confirmPlaceholder"
                @keyup.enter="submitPasswordChange"
              />
            </NFormItem>
          </NForm>

          <p v-if="T.settings.hints.changePassword" class="pw-note dim">
            {{ T.settings.hints.changePassword }}
          </p>

          <template #footer>
            <div class="pw-actions">
              <NButton size="small" @click="closePasswordDialog">{{ T.common.cancel }}</NButton>
              <NButton
                size="small"
                type="primary"
                :loading="auth.busy"
                @click="submitPasswordChange"
              >
                {{ T.settings.confirmPasswordChange }}
              </NButton>
            </div>
          </template>
        </NModal>

        <!--
          导出备份弹窗：与导入对称，导出内容（含资源 / 仅配置）在弹窗里选。
          两个弹窗共用同一套「整行单选卡片」（.choices / .choice）。
        -->
        <NModal
          v-model:show="exportOpen"
          preset="card"
          :title="T.settings.labels.exportData"
          class="export-modal"
          :style="{ width: '440px', maxWidth: '94vw' }"
          :mask-closable="false"
          @after-leave="resetExportDialog"
        >
          <div class="import-step">
            <span class="step-label">{{ T.settings.exportDialog.stepContent }}</span>
            <div class="choices" role="radiogroup" :aria-label="T.settings.exportDialog.stepContent">
              <button
                v-for="o in exportOptions"
                :key="o.label"
                class="choice"
                :class="{ active: exportWithAssets === o.value }"
                type="button"
                role="radio"
                :aria-checked="exportWithAssets === o.value"
                @click="exportWithAssets = o.value"
              >
                <span class="choice-dot" aria-hidden="true" />
                <span class="choice-text">
                  <span class="choice-label">{{ o.label }}</span>
                  <span class="hint dim">{{ o.desc }}</span>
                </span>
              </button>
            </div>
          </div>

          <p class="pw-note dim">{{ T.settings.exportNote }}</p>

          <template #footer>
            <div class="pw-actions">
              <NButton size="small" :disabled="exporting" @click="closeExportDialog">{{ T.common.cancel }}</NButton>
              <NButton size="small" type="primary" :loading="exporting" @click="exportBackup">
                {{ T.settings.exportDialog.confirm }}
              </NButton>
            </div>
          </template>
        </NModal>

        <!--
          导入备份弹窗：两步走 —— 先选文件，选完才出现「合并 / 覆盖」。
          刻意不把这两个选择摊在设置页上：它们是这条流程的参数，不是常驻配置。
        -->
        <NModal
          v-model:show="importOpen"
          preset="card"
          :title="T.settings.labels.importData"
          class="import-modal"
          :style="{ width: '440px', maxWidth: '94vw' }"
          :mask-closable="false"
          @after-leave="resetImportDialog"
        >
          <div class="import-step">
            <span class="step-label">{{ T.settings.importDialog.stepFile }}</span>
            <div class="file-row">
              <label class="file" :title="importFile?.name ?? ''">
                <input type="file" accept=".json,application/json" @change="onImportFile" />
                <span class="file-name">{{ importFile ? importFile.name : T.settings.chooseFile }}</span>
              </label>
              <span class="hint dim">
                {{ importFile ? T.settings.importDialog.fileChosen : T.settings.importDialog.fileHint }}
              </span>
            </div>
          </div>

          <!-- 第二步要等文件选好才出现：没选文件时先别让人纠结合并还是覆盖 -->
          <Transition name="panel">
            <div v-if="importFile" class="import-step">
              <span class="step-label">{{ T.settings.importDialog.stepMode }}</span>
              <div class="choices" role="radiogroup" :aria-label="T.settings.importDialog.stepMode">
                <button
                  v-for="m in importModeOptions"
                  :key="m.value"
                  class="choice"
                  :class="{ active: importMode === m.value }"
                  type="button"
                  role="radio"
                  :aria-checked="importMode === m.value"
                  @click="importMode = m.value"
                >
                  <span class="choice-dot" aria-hidden="true" />
                  <span class="choice-text">
                    <span class="choice-label">{{ m.label }}</span>
                    <span class="hint dim">{{ m.desc }}</span>
                  </span>
                </button>
              </div>
            </div>
          </Transition>

          <p class="pw-note dim">{{ T.settings.importNote }}</p>

          <template #footer>
            <div class="pw-actions">
              <NButton size="small" :disabled="importing" @click="closeImportDialog">{{ T.common.cancel }}</NButton>
              <NButton
                size="small"
                type="primary"
                :disabled="!importFile"
                :loading="importing"
                @click="runImport"
              >
                {{
                  importMode === 'replace'
                    ? T.settings.importDialog.confirmReplace
                    : T.settings.importDialog.confirm
                }}
              </NButton>
            </div>
          </template>
        </NModal>
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

/*
 * 留白取 --sp-3：副标题默认留空（TEXT.settings.sections[].desc），行自带 16px
 * 上内边距，合计 28px，与行间 32px 的节奏接近，标题不会被读成第一项的标签。
 */
.panel-head {
  margin-bottom: var(--sp-3);
}

/* 「关于」面板第一项是规格表，没有行内边距，单独补一点间隔 */
.panel-head + .about {
  margin-top: var(--sp-2);
}

.panel-head h2 {
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

/* 副标题：默认空字符串 → 不渲染；填了 TEXT.settings.sections[].desc 才出现 */
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
  /* 备份文件名可能很长：限宽 + 省略号，别把 268px 的右栏撑破 */
  max-width: 100%;
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

.file-name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
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

/* 关于页底部操作：重启在左（主操作），关闭紧随其右 */
.about-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-6);
}

.mt {
  margin-top: var(--sp-6);
}

/* ── 修改密码 / 导入备份弹窗（NModal teleport 到 body，但仍带本组件的作用域属性）── */

.pw-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
}

/* 密码表单：标签必须贴住**自己的**输入框。
   全局规则给标签留了 8px 下内边距，而 show-feedback=false 的字段之间
   没有任何间隔 —— 结果是标签离上一个输入框只有 3px、离自己的输入框
   却有 11px，一眼看上去像是上一个输入框的说明。这里把标签下移贴住
   输入框（省下的 4px×3 正好抵掉一部分字段间距），分组改由字段间距承担；
   间距取 --sp-3 而不是 --sp-4，是为了别把这个弹窗撑得比原来高太多。 */
.pw-form :deep(.n-form-item .n-form-item-label) {
  padding-bottom: 4px;
}

.pw-form :deep(.n-form-item + .n-form-item) {
  margin-top: var(--sp-3);
}

.pw-note {
  margin: var(--sp-2) 0 0;
  font-size: 12px;
  line-height: 1.6;
}

/* 导入弹窗：两步各成一段，段与段之间留白分开 */
.import-step + .import-step {
  margin-top: var(--sp-5);
}

.step-label {
  display: block;
  margin-bottom: var(--sp-2);
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

/* 文件名 + 状态提示同一行；文件名太长时省略，提示不被挤走 */
.file-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}

.file-row .hint {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 导出 / 导入弹窗共用的「整行单选卡片」：整行可点，选中项用强调色描边 + 实心圆点 */
.choices {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.choice {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--r-sm);
  background: var(--field);
  color: var(--text-2);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, box-shadow 0.14s ease;
}

.choice:hover {
  background: var(--field-hi);
  color: var(--text);
}

.choice.active {
  background: var(--field-hi);
  color: var(--text);
  /* 用 inset 描边而不是 border：不让选中时整块跳动 1px */
  box-shadow: inset 0 0 0 1px var(--accent);
}

.choice-dot {
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 3px;
  border-radius: 50%;
  border: 1.5px solid var(--text-3);
  transition: border-color 0.14s ease, background 0.14s ease, box-shadow 0.14s ease;
}

.choice.active .choice-dot {
  border-color: var(--accent);
  background: var(--accent);
  /* 内环取当前行底色，把实心点做成圆环，和「单选」的心智一致 */
  box-shadow: inset 0 0 0 3px var(--field-hi);
}

.choice-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.choice-label {
  font-size: 13px;
  color: var(--text);
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
