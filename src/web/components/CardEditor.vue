<script setup lang="ts">
/**
 * 卡片编辑器（新建 / 编辑）。
 *
 * 几个刻意的取舍：
 *   - URL **不做前端补全**：后端会用与 shared/schemas 相同的规则归一化
 *     （`192.168.1.5:5000` → `http://192.168.1.5:5000/`），前端只做「像不像
 *     一个地址」的轻校验，避免与后端规则分叉。
 *   - 上传优先走 POST /api/assets（后端已实现，id 为内容哈希）；若接口不可用
 *     （旧二进制 / 409 / 413）则回落到把图片读成 dataURL 存进 iconValue。
 *     两条路径都限制 ≤256KB —— 这是本项目的图标体积约定。
 *   - favicon 用后端 /api/favicon 抓取（服务端抓取，内网可用），来源由用户在内网 /
 *     外网之间显式选择；**抓不到就直接报错**，不写 DuckDuckGo 之类的占位地址。
 *   - 图标库是**本地常量列表**，不请求 Iconify 公网 API。
 */
import { computed, nextTick, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NColorPicker,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  useMessage,
} from 'naive-ui'
import { api, ApiError } from '@/api/client'
import { useDeleteConfirm } from '@/composables/useDeleteConfirm'
import { useItemsStore } from '@/stores/items'
import { normalizeUrlInput, TITLE_MAX } from '@shared/schemas'
import type { Group, IconType, Item, NetworkPref } from '@shared/types'
import FaviconGlyph from './FaviconGlyph.vue'

const props = defineProps<{
  show: boolean
  /** null = 新建 */
  item: Item | null
  groups: Group[]
  /** 新建时的预设分组（从某个分组区的「新建卡片」进入） */
  initialGroupId?: number | null
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'saved', item: Item): void
  (e: 'deleted', item: Item): void
}>()

const items = useItemsStore()
const message = useMessage()
const { confirmRemove } = useDeleteConfirm()

/** 图标体积上限：与需求约定的 256KB 一致 */
const MAX_ICON_BYTES = 256 * 1024

/**
 * 精选图标名（全部来自公共图标集的常见名字）。
 * 刻意内置常量而非请求 api.iconify.design —— 本项目面向内网。
 * 未内置的形状会由 FaviconGlyph 用几何字形兜底，仍然是可区分的。
 */
const ICON_LIBRARY: Array<{ group: string; names: string[] }> = [
  {
    group: '通用',
    names: [
      'mdi:home', 'mdi:home-outline', 'mdi:apps', 'mdi:grid', 'mdi:view',
      'mdi:eye', 'mdi:dashboard', 'mdi:link', 'mdi:external', 'mdi:open',
      'mdi:plus', 'mdi:add', 'mdi:star', 'mdi:heart', 'mdi:bookmark',
      'mdi:tag', 'mdi:bell', 'mdi:calendar', 'mdi:clock', 'mdi:clock-outline',
      'mdi:folder', 'mdi:folder-open', 'mdi:folder-star', 'mdi:folder-network', 'mdi:folder-lock',
      'mdi:file', 'mdi:file-cog', 'mdi:folder-cog', 'mdi:pin', 'mdi:map-marker',
      'mdi:compass', 'mdi:navigation', 'mdi:qrcode', 'mdi:magnet',
    ],
  },
  {
    group: '操作与状态',
    names: [
      'mdi:edit', 'mdi:pencil', 'mdi:trash', 'mdi:delete', 'mdi:close',
      'mdi:close-circle', 'mdi:check', 'mdi:refresh', 'mdi:reload', 'mdi:sync',
      'mdi:restart', 'mdi:search', 'mdi:magnify', 'mdi:copy', 'mdi:content_copy',
      'mdi:cog', 'mdi:settings', 'mdi:tools', 'mdi:wrench', 'mdi:hammer',
      'mdi:bug', 'mdi:clipboard-list', 'mdi:calculator', 'mdi:database-export', 'mdi:database-import',
      'mdi:backup-restore', 'mdi:power', 'mdi:power-plug', 'mdi:battery', 'mdi:flashlight',
      'mdi:lock', 'mdi:lock-outline', 'mdi:key', 'mdi:shield', 'mdi:shield-key',
      'mdi:security', 'mdi:fingerprint',
    ],
  },
  {
    group: '账户与通讯',
    names: [
      'mdi:account', 'mdi:user', 'mdi:account-group', 'mdi:account-key', 'mdi:login',
      'mdi:logout', 'mdi:email', 'mdi:send', 'mdi:chat', 'mdi:message-text',
      'mdi:rss', 'mdi:telegram', 'mdi:discord', 'mdi:slack', 'mdi:whatsapp',
    ],
  },
  {
    group: '系统与品牌',
    names: [
      'mdi:linux', 'mdi:apple', 'simple-icons:windows', 'mdi:android', 'mdi:debian',
      'mdi:ubuntu', 'mdi:fedora', 'mdi:arch', 'mdi:centos', 'mdi:redhat',
      'mdi:raspberry-pi', 'simple-icons:arduino', 'simple-icons:intel', 'simple-icons:amd', 'simple-icons:nvidia',
      'mdi:docker', 'mdi:kubernetes', 'simple-icons:cloudflare', 'simple-icons:tailscale', 'simple-icons:wireguard',
      'simple-icons:openvpn', 'mdi:vpn', 'mdi:firewall', 'simple-icons:proxmox', 'simple-icons:truenas',
      'simple-icons:unraid', 'simple-icons:openmediavault', 'simple-icons:synology', 'simple-icons:qnap', 'mdi:home-assistant',
    ],
  },
  {
    group: '运维与服务',
    names: [
      'simple-icons:portainer', 'simple-icons:jenkins', 'mdi:ansible', 'mdi:terraform', 'simple-icons:consul',
      'simple-icons:vault', 'mdi:gitlab', 'mdi:github', 'mdi:bitbucket', 'simple-icons:gitea',
      'simple-icons:nginx', 'simple-icons:apache', 'simple-icons:prometheus', 'simple-icons:grafana', 'simple-icons:influxdb',
      'simple-icons:kibana', 'simple-icons:nodered', 'simple-icons:mqtt', 'mdi:zigbee', 'simple-icons:frigate',
      'simple-icons:pihole', 'simple-icons:adguard', 'simple-icons:openwrt', 'simple-icons:nextcloud', 'simple-icons:syncthing',
    ],
  },
  {
    group: '存储与数据库',
    names: [
      'mdi:nas', 'mdi:database', 'mdi:storage', 'mdi:drive', 'mdi:harddisk',
      'mdi:harddisk-plus', 'mdi:sd', 'mdi:usb-flash-drive', 'mdi:cloud', 'mdi:cloud-sync',
      'mdi:cloud-check', 'mdi:cloud-download', 'mdi:cloud-upload', 'mdi:server', 'simple-icons:mysql',
      'simple-icons:postgresql', 'simple-icons:mariadb', 'simple-icons:mongodb', 'simple-icons:redis', 'simple-icons:rabbitmq',
      'simple-icons:apachekafka', 'simple-icons:minio', 'simple-icons:ceph', 'simple-icons:sqlite',
    ],
  },
  {
    group: '网络',
    names: [
      'mdi:router', 'mdi:lan', 'mdi:sitemap', 'mdi:globe', 'mdi:earth',
      'mdi:wifi', 'mdi:wifi-off', 'mdi:access-point', 'mdi:ethernet', 'mdi:bluetooth',
      'mdi:signal', 'mdi:terminal', 'mdi:code',
    ],
  },
  {
    group: '媒体与设备',
    names: [
      'mdi:plex', 'simple-icons:jellyfin', 'mdi:emby', 'mdi:kodi', 'mdi:vlc',
      'mdi:youtube', 'mdi:spotify', 'mdi:movie', 'mdi:film', 'mdi:music',
      'mdi:camera', 'mdi:image', 'mdi:video', 'mdi:play', 'mdi:book',
      'mdi:notebook', 'simple-icons:sonarr', 'simple-icons:radarr', 'simple-icons:qbittorrent', 'simple-icons:transmission',
      'mdi:download', 'mdi:upload', 'mdi:monitor', 'mdi:display', 'mdi:television',
      'mdi:projector', 'mdi:speaker', 'mdi:headphones', 'mdi:microphone', 'mdi:printer',
      'mdi:scanner', 'mdi:keyboard', 'mdi:mouse', 'mdi:cellphone', 'mdi:tablet',
      'mdi:laptop', 'mdi:desktop-tower', 'mdi:watch', 'mdi:cctv', 'simple-icons:immich',
    ],
  },
  {
    group: '硬件与图表',
    names: [
      'mdi:cpu', 'mdi:memory', 'mdi:gpu', 'mdi:thermometer', 'mdi:lightbulb',
      'mdi:vacuum', 'mdi:chart', 'mdi:chart-line', 'mdi:speed', 'mdi:gauge',
      'mdi:rocket',
    ],
  },
  {
    group: '生活与出行',
    names: [
      'mdi:train', 'mdi:car', 'mdi:airplane', 'mdi:bike', 'mdi:leaf',
      'mdi:tree', 'mdi:fire', 'mdi:snowflake', 'mdi:weather-sunny', 'mdi:weather-night',
      'mdi:umbrella', 'mdi:wallet', 'mdi:cash', 'mdi:credit-card', 'mdi:package',
      'mdi:cart', 'mdi:gift', 'mdi:ticket',
    ],
  },
]
const form = ref({
  title: '',
  subtitle: '',
  groupId: null as number | null,
  lanUrl: '',
  wanUrl: '',
  networkPref: 'auto' as NetworkPref,
  iconType: 'iconify' as IconType,
  iconValue: '',
  iconColor: '',
  bgColor: '',
})

/**
 * 一级菜单：图标来源。顺序即界面顺序（上传 / 文字 / 抓取 / 图标库）。
 * 选中项直接就是 form.iconType —— 菜单、来源面板、预览共用同一份生效值，
 * 不存在「菜单切了但没生效」的中间态。
 */
const ICON_SOURCES: Array<{ value: IconType; label: string }> = [
  { value: 'asset', label: '上传' },
  { value: 'text', label: '文字' },
  { value: 'favicon', label: '抓取' },
  { value: 'iconify', label: '图标库' },
]

/**
 * 每个来源各自记住最近一次填的值，一级菜单来回切换不丢已填内容。
 * 打开弹窗时按卡片重置，之后只由 form 单向回写。
 */
const iconDrafts = ref<Record<IconType, string>>({
  iconify: '',
  asset: '',
  text: '',
  favicon: '',
})

/** 图标库弹层（点一级菜单的「图标库」，或面板里的「浏览图标库」） */
const libraryOpen = ref(false)
const libraryQuery = ref('')

const filteredLibrary = computed(() => {
  const q = libraryQuery.value.trim().toLowerCase()
  if (!q) return ICON_LIBRARY
  return ICON_LIBRARY.map((section) => ({
    ...section,
    names: section.names.filter((name) => name.toLowerCase().includes(q)),
  })).filter((section) => section.names.length > 0)
})

/** 打开弹窗时按卡片重置草稿：只有卡片自己的来源带值，其它来源留空 */
function resetIconDrafts(type: IconType, value: string): void {
  iconDrafts.value = {
    iconify: '',
    asset: '',
    text: '',
    favicon: '',
    [type]: value,
  }
}

/** 生效值单向回写草稿，切回某个来源时能还原上次填的内容 */
watch(
  () => [form.value.iconType, form.value.iconValue] as const,
  ([type, value]) => {
    iconDrafts.value[type] = value ?? ''
  },
)

const submitting = ref(false)
const errorText = ref<string | null>(null)
const faviconBusy = ref(false)
const uploading = ref(false)
/** 隐藏的原生 file 控件：上传面板的「+」方块用 click() 触发它 */
const fileInputRef = ref<HTMLInputElement | null>(null)
/**
 * 未保存判定：拿当前表单和「打开弹窗时的快照」比，而不是靠各处手写 dirty = true。
 * 手写标记会把「点了几下上传/文字/抓取/图标库又切回原样」也算成改动，
 * 明明一个字段都没变却会弹未保存确认。
 */
const formSnapshot = () => JSON.stringify(form.value)
const baseline = ref(formSnapshot())
const dirty = computed(() => formSnapshot() !== baseline.value)
const confirmClose = ref(false)

const isEdit = computed(() => props.item !== null)
const title = computed(() => (isEdit.value ? '编辑卡片' : '新建卡片'))

/**
 * ⚠️ 选项值刻意不含 null：Naive UI 的 SelectMixedOption 不接受 `number | null` 的联合类型。
 * 未分组用哨兵值 0 表示（后端 groupId 必须为正整数，0 不会与真实 id 冲突），
 * 提交前再由 toGroupId() 转回 null。
 */
const UNGROUPED = 0

/**
 * 「新建分组」也是下拉里的一个选项，用 -1 这个哨兵值表示。
 * 选中它**不写回表单**（setter 里拦下来），而是弹出一个小弹窗问名称：
 * 建组成功后新分组直接成为当前所属分组，全程不用离开卡片编辑器。
 */
const NEW_GROUP = -1

const groupOptions = computed(() => [
  { label: '未分组', value: UNGROUPED },
  ...props.groups.map((g) => ({ label: g.name, value: g.id })),
  // 「新建分组」是一条动作而不是真实分组：不加 + 号，改用强调色区分。
  // style 会落到下拉项元素上（见 naive-ui SelectOption），行内样式不会被
  // hover / pending 等状态样式覆盖，颜色始终是主题强调色。
  { label: '新建分组', value: NEW_GROUP, style: 'color: var(--accent)' },
])

/**
 * 「所属分组」下拉的局部主题：把「已选中 / 悬停中」选项的文字色还原成普通文字色。
 *
 * naive-ui 默认把这两种状态也染成主色（optionTextColorActive / optionTextColorPressed
 * 的默认值就是 primaryColor），于是当前分组（默认就是「未分组」）看起来和
 * 「新建分组」这条动作一模一样 —— 强调色要留给动作项，选中状态本身还有对勾和底色。
 * 值直接复用 naive-ui 自己的普通选项色变量，浅色 / 深色都跟着主题走；
 * 选项色属于内部的 InternalSelectMenu 主题，所以走 peers（见 naive-ui useTheme）。
 */
const groupSelectTheme = {
  peers: {
    InternalSelectMenu: {
      optionTextColorActive: 'var(--n-option-text-color)',
      optionTextColorPressed: 'var(--n-option-text-color)',
    },
  },
}

const groupValue = computed({
  get: () => form.value.groupId ?? UNGROUPED,
  set: (v: number) => {
    if (v === NEW_GROUP) {
      openGroupDialog()
      return
    }
    form.value.groupId = v === UNGROUPED ? null : v
  },
})

// ── 新建分组弹窗 ─────────────────────────────────────────────

const groupDialogOpen = ref(false)
const groupName = ref('')
const groupError = ref<string | null>(null)
const groupSaving = ref(false)
const groupNameInput = ref<InstanceType<typeof NInput> | null>(null)

async function openGroupDialog(): Promise<void> {
  groupName.value = ''
  groupError.value = null
  groupDialogOpen.value = true
  // 弹窗挂载后再聚焦（NModal 是 teleport 出来的）
  await nextTick()
  groupNameInput.value?.focus()
}

function closeGroupDialog(): void {
  groupDialogOpen.value = false
  groupName.value = ''
  groupError.value = null
}

/**
 * 确认建组。返回 false 时 Naive UI 不关闭弹窗（见 Modal 的 handlePositiveClick），
 * 失败就把输入留在原地让用户改，而不是丢掉刚敲的名字。
 */
async function createGroup(): Promise<boolean> {
  const name = groupName.value.trim()
  if (!name || groupSaving.value) return false

  groupSaving.value = true
  groupError.value = null
  try {
    const created = await items.createGroup({ name })
    form.value.groupId = created.id
    closeGroupDialog()
    return true
  } catch (e) {
    groupError.value = e instanceof Error ? e.message : '新建分组失败'
    return false
  } finally {
    groupSaving.value = false
  }
}

const networkPrefOptions = [
  { label: '继承全局', value: 'auto' },
  { label: '强制内网', value: 'lan' },
  { label: '强制外网', value: 'wan' },
]

/** 打开弹窗时把 item 灌进表单 */
watch(
  () => [props.show, props.item] as const,
  ([show, item]) => {
    if (!show) return
    errorText.value = null
    confirmClose.value = false
    if (item) {
      form.value = {
        title: item.title,
        subtitle: item.subtitle ?? '',
        groupId: item.groupId,
        lanUrl: item.lanUrl ?? '',
        wanUrl: item.wanUrl ?? '',
        networkPref: item.networkPref,
        iconType: item.iconType,
        iconValue: item.iconValue ?? '',
        iconColor: item.iconColor ?? '',
        bgColor: item.bgColor ?? '',
      }
      resetIconDrafts(item.iconType, item.iconValue ?? '')
      libraryOpen.value = false
      libraryQuery.value = ''
      // 抓取来源回到默认（内网优先；内网没地址时 faviconMode 会自动落外网）
      faviconPref.value = 'lan'
    } else {
      form.value = {
        title: '',
        subtitle: '',
        groupId: props.initialGroupId ?? null,
        lanUrl: '',
        wanUrl: '',
        networkPref: 'auto',
        iconType: 'iconify',
        iconValue: '',
        iconColor: '',
        bgColor: '',
      }
      resetIconDrafts('iconify', '')
      libraryOpen.value = false
      libraryQuery.value = ''
      faviconPref.value = 'lan'
    }
    // 灌完表单再落快照，之后 dirty 全靠与它对比
    baseline.value = formSnapshot()
  },
  { immediate: true },
)

// ── 校验 ─────────────────────────────────────────────────────

/** 轻量校验：只判断「有没有 scheme 或是否是 host:port 形态」 */
function looksLikeUrl(raw: string): boolean {
  const s = raw.trim()
  if (!s) return true
  if (/^(https?|ftp|file|javascript|data):/i.test(s)) {
    // 只接受 http/https
    return /^https?:\/\//i.test(s)
  }
  // 无 scheme：host[:port][/path]，要求至少一个点或冒号，或单标签主机名
  return /^[a-z0-9[\]_-]+(\.[a-z0-9[\]_-]+)*(:[0-9]{1,5})?(\/.*)?$/i.test(s)
}

const urlsEmpty = computed(
  () => form.value.lanUrl.trim() === '' && form.value.wanUrl.trim() === '',
)

const urlWarning = computed(() => {
  if (!looksLikeUrl(form.value.lanUrl)) return '内网地址看起来不是合法的 http(s) 地址'
  if (!looksLikeUrl(form.value.wanUrl)) return '外网地址看起来不是合法的 http(s) 地址'
  return null
})

const canSubmit = computed(
  () => form.value.title.trim() !== '' && !urlsEmpty.value && !urlWarning.value,
)

// ── 图标操作 ─────────────────────────────────────────────────

/** 触发隐藏的 file 控件：上传模式下点预览框里的「+」即上传 */
function openFilePicker(): void {
  fileInputRef.value?.click()
}

/** 打开图标库弹层（一级菜单的「图标库」和预览框都走这里） */
function openLibrary(): void {
  libraryQuery.value = ''
  libraryOpen.value = true
}

/** 文字没有可挑的东西，预览框退化成纯展示的 span */
const boxActionable = computed(() => form.value.iconType !== 'text')

/**
 * 预览框在各来源下的行为 —— 四个来源统一成「点这个图标就做这件事」：
 *   上传 → 选文件；抓取 → 用卡片的内网 / 外网地址抓；图标库 → 打开图标库。
 */
const previewBoxProps = computed(() => {
  if (!boxActionable.value) return {}
  const busy = uploading.value || faviconBusy.value
  const actions: Partial<
    Record<IconType, { fresh: string; again: string; title: string; run: () => void }>
  > = {
    asset: {
      fresh: '选择图片上传',
      again: '重新选择图片',
      title: '支持 PNG / JPEG / GIF / WebP / SVG / ICO，单个 ≤256KB',
      run: openFilePicker,
    },
    favicon: {
      fresh: '抓取 favicon',
      again: '重新抓取 favicon',
      title: faviconHint.value,
      run: fetchFavicon,
    },
    iconify: {
      fresh: '打开图标库',
      again: '重新选择图标',
      title: '打开图标库挑选图标',
      run: openLibrary,
    },
  }
  const action = actions[form.value.iconType]
  if (!action) return {}
  return {
    type: 'button',
    disabled: busy,
    'aria-busy': busy,
    'aria-label': form.value.iconValue ? action.again : action.fresh,
    title: action.title,
    onClick: action.run,
  }
})

/**
 * 一级菜单：只负责切来源（和「上传」一致 —— 切过去就完事，弹层/选文件都交给预览框），
 * 已填过的值从草稿里还原。
 */
function selectSource(type: IconType): void {
  if (form.value.iconType === type) return
  form.value.iconType = type
  form.value.iconValue = iconDrafts.value[type] ?? ''
}

/** 图标库里点选一个图标：回填生效值并关掉弹层 */
function pickIcon(name: string): void {
  form.value.iconType = 'iconify'
  form.value.iconValue = name
  libraryOpen.value = false
}

function clearIcon(): void {
  form.value.iconValue = ''
  form.value.iconColor = ''
  form.value.bgColor = ''
}

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 允许重新选择同一个文件
  input.value = ''
  if (!file) return

  if (file.size > MAX_ICON_BYTES) {
    message.error(
      `图标不能超过 256KB（当前 ${(file.size / 1024).toFixed(1)}KB）—— 建议改用矢量图标`,
    )
    return
  }
  if (!file.type.startsWith('image/')) {
    message.error('请选择图片文件')
    return
  }

  uploading.value = true
  try {
    // 首选：上传到服务端资源库（内容哈希去重、可直接被 <img> 引用）
    const asset = await api.assets.upload(file, 'icon')
    form.value.iconType = 'asset'
    form.value.iconValue = asset.url
    message.success('图标已上传')
  } catch (e) {
    // 接口未实现 / 被拒绝 → 回落 dataURL（完全离线可用，只是会占用 iconValue 空间）
    try {
      const dataUrl = await toDataUrl(file)
      if (dataUrl.length > 4096) {
        message.error('图片太大，内联存储会超出图标字段长度上限（4096 字符）')
        return
      }
      form.value.iconType = 'asset'
      form.value.iconValue = dataUrl
      message.warning(
        e instanceof ApiError && e.status !== 0
          ? `上传接口不可用（${e.message}），已改为内联存储`
          : '上传失败，已改为内联存储',
      )
    } catch (err) {
      message.error(err instanceof Error ? err.message : '图标读取失败')
    }
  } finally {
    uploading.value = false
  }
}

/** 图标就存后端返回的 /api/assets/xxx；抓取失败不再拼 DuckDuckGo 占位地址 */
/** 归一化后的两侧地址：没填或非法 → null（按钮禁用、抓取前校验都用它） */
const lanIconUrl = computed(() => normalizeUrlInput(form.value.lanUrl))
const wanIconUrl = computed(() => normalizeUrlInput(form.value.wanUrl))

/** 抓取来源偏好（点右侧「内网 / 外网」按钮会改它） */
const faviconPref = ref<'lan' | 'wan'>('lan')

/** 实际生效的来源：选中的那侧没地址时，自动落到有地址的一侧 */
const faviconMode = computed<'lan' | 'wan'>(() => {
  if (faviconPref.value === 'lan' && lanIconUrl.value) return 'lan'
  if (faviconPref.value === 'wan' && wanIconUrl.value) return 'wan'
  return wanIconUrl.value ? 'wan' : 'lan'
})

/**
 * 预览框 hover 提示：说清楚这次会用哪个地址，以及右侧能切来源。
 * 不再单开一行“抓取来源”，卡片高度因此不变。
 */
const faviconHint = computed(() => {
  const url = faviconMode.value === 'lan' ? lanIconUrl.value : wanIconUrl.value
  const label = faviconMode.value === 'lan' ? '内网' : '外网'
  return url
    ? `从${label}地址抓取 favicon：${url}（右侧可切换内网 / 外网）`
    : '用卡片的内网 / 外网地址抓取 favicon —— 先在表单里填一个地址'
})

/**
 * 只切抓取来源（内网 / 外网），不发起请求 —— 真正抓取统一走预览框，
 * 和上传/图标库一样「点那个图标才做事」。
 */
function selectFaviconSource(mode: 'lan' | 'wan'): void {
  faviconPref.value = mode
}

/**
 * 抓取 favicon：用当前选中的那一侧地址（内网 / 外网），不再自动两路都试；
 * 失败就直接报错（不再回落到 DuckDuckGo 占位地址）。
 */
async function fetchFavicon(): Promise<void> {
  const pick = faviconMode.value
  const url = pick === 'lan' ? lanIconUrl.value : wanIconUrl.value
  if (!lanIconUrl.value && !wanIconUrl.value) {
    message.warning('请先填写内网地址或外网地址')
    return
  }
  if (!url) {
    message.warning(pick === 'lan' ? '未填写内网地址，换外网试试' : '未填写外网地址，换内网试试')
    return
  }
  const label = pick === 'lan' ? '内网' : '外网'
  faviconBusy.value = true
  try {
    const result = await api.favicon.fetch(url)
    setFavicon(result.url)
    message.success(`已从${label}地址抓取 favicon`)
  } catch (e) {
    // 不写占位地址、不动现有图标，只把失败原因说清楚
    message.error(`${label}地址抓取失败：${e instanceof Error ? e.message : '未知错误'}`)
  } finally {
    faviconBusy.value = false
  }
}

function setFavicon(url: string): void {
  form.value.iconType = 'favicon'
  form.value.iconValue = url
}

// ── 提交 / 删除 ───────────────────────────────────────────────

async function submit(): Promise<void> {
  errorText.value = null
  if (form.value.title.trim() === '') {
    errorText.value = '标题不能为空'
    return
  }
  if (urlsEmpty.value) {
    errorText.value = '内网地址与外网地址至少填写一个'
    return
  }
  if (urlWarning.value) {
    errorText.value = urlWarning.value
    return
  }

  const body = {
    title: form.value.title.trim(),
    subtitle: form.value.subtitle.trim() || null,
    groupId: form.value.groupId,
    lanUrl: form.value.lanUrl.trim() || null,
    wanUrl: form.value.wanUrl.trim() || null,
    networkPref: form.value.networkPref,
    iconType: form.value.iconType,
    iconValue: form.value.iconValue || null,
    iconColor: form.value.iconColor || null,
    bgColor: form.value.bgColor || null,
  }

  submitting.value = true
  try {
    const saved = props.item
      ? await items.updateItem(props.item.id, body)
      : await items.createItem(body)
    message.success(props.item ? '卡片已更新' : '卡片已创建')
    emit('saved', saved)
    emit('update:show', false)
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    submitting.value = false
  }
}

async function confirmDelete(): Promise<void> {
  if (!props.item) return
  const target = props.item
  // 一级确认来自 NPopconfirm（气泡），这里再弹应用内弹窗做二级确认
  if (!(await confirmRemove(target))) return
  const ok = await items.removeItem(target.id).then(
    () => true,
    (e: unknown) => {
      errorText.value = e instanceof Error ? e.message : '删除失败'
      return false
    },
  )
  if (!ok) return
  message.success('卡片已删除')
  emit('deleted', target)
  emit('update:show', false)
}

/** 关闭前拦截：有未保存修改时用应用内弹窗确认，不用原生 confirm */
function requestClose(): void {
  if (dirty.value) {
    confirmClose.value = true
    return
  }
  emit('update:show', false)
}

function discardAndClose(): void {
  confirmClose.value = false
  emit('update:show', false)
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="title"
    class="editor-modal"
    :style="{ width: '560px', maxWidth: '94vw' }"
    :mask-closable="false"
    @update:show="(v: boolean) => (v ? emit('update:show', true) : requestClose())"
  >
    <NForm label-placement="top" size="small">
      <div class="two-col">
        <NFormItem label="标题" required>
          <NInput
            v-model:value="form.title"
            placeholder="例如：群晖 NAS"
            :maxlength="TITLE_MAX"
            show-count
          />
        </NFormItem>
        <NFormItem label="副标题">
          <NInput
            v-model:value="form.subtitle"
            placeholder="可选，例如：DS920+ / 4TB"
            :maxlength="128"
          />
        </NFormItem>
      </div>

      <div class="two-col">
        <NFormItem label="内网地址">
          <NInput v-model:value="form.lanUrl" placeholder="192.168.1.5:5000" clearable />
        </NFormItem>
        <NFormItem label="外网地址">
          <NInput v-model:value="form.wanUrl" placeholder="https://nas.example.com" clearable />
        </NFormItem>
      </div>

      <NAlert v-if="urlWarning" type="warning" :bordered="false" class="alert">
        {{ urlWarning }}
      </NAlert>

      <div class="two-col">
        <NFormItem label="网络偏好">
          <NSelect
            v-model:value="form.networkPref"
            :options="networkPrefOptions"
            :consistent-menu-width="false"
          />
        </NFormItem>
        <NFormItem label="所属分组">
          <NSelect
            v-model:value="groupValue"
            :options="groupOptions"
            :consistent-menu-width="false"
            :theme-overrides="groupSelectTheme"
          />
        </NFormItem>
      </div>

      <NFormItem label="图标">
        <div class="icon-area">
          <!-- 一级菜单：图标来源直接摆在表单上，不再藏进二级浮层 -->
          <div class="icon-sources" role="group" aria-label="图标来源">
            <button
              v-for="source in ICON_SOURCES"
              :key="source.value"
              type="button"
              class="source-tab"
              :class="{ active: form.iconType === source.value }"
              :aria-pressed="form.iconType === source.value"
              @click="selectSource(source.value)"
            >
              {{ source.label }}
            </button>
          </div>

          <div class="icon-preview">
            <!-- 除了文字来源，预览框本身就是入口，隐藏控件供上传用 -->
            <input
              ref="fileInputRef"
              type="file"
              accept="image/*"
              class="file-input"
              @change="onFile"
            />
            <component
              :is="boxActionable ? 'button' : 'span'"
              class="preview-box"
              v-bind="previewBoxProps"
            >
              <span v-if="uploading || faviconBusy" class="dim">…</span>
              <img
                v-else-if="
                  (form.iconType === 'asset' || form.iconType === 'favicon') && form.iconValue
                "
                :src="form.iconValue"
                alt="图标预览"
                class="preview-img"
              />
              <span
                v-else-if="form.iconType === 'text'"
                class="preview-text"
                :style="{
                  background: form.bgColor || 'rgba(127,127,127,.15)',
                  color: form.iconColor || 'var(--accent)',
                }"
              >
                {{ Array.from(form.title || '?')[0] }}
              </span>
              <!-- 空的来源统一放一个「+」：和上传一样，点框就是去做这件事 -->
              <FaviconGlyph v-else-if="form.iconType === 'asset'" name="plus" :size="22" />
              <FaviconGlyph
                v-else-if="form.iconType === 'iconify'"
                :name="form.iconValue || 'plus'"
                :size="form.iconValue ? 26 : 22"
              />
              <FaviconGlyph v-else name="download" :size="22" />
            </component>
            <div class="preview-meta">
              <span class="mono dim">{{ form.iconType }}</span>
              <span class="mono dim ellipsis" :title="form.iconValue">
                {{ form.iconValue || '未设置' }}
              </span>
            </div>
            <span class="spacer" />
            <!-- 抓取来源：只切换用哪一侧地址，发请求统一由左侧图标触发 -->
            <div v-if="form.iconType === 'favicon'" class="fetch-sources">
              <button
                type="button"
                class="source-chip"
                :class="{ active: faviconMode === 'lan' }"
                :disabled="!lanIconUrl"
                :title="lanIconUrl ? `用内网地址抓取：${lanIconUrl}` : '未填写内网地址'"
                @click="selectFaviconSource('lan')"
              >
                内网
              </button>
              <button
                type="button"
                class="source-chip"
                :class="{ active: faviconMode === 'wan' }"
                :disabled="!wanIconUrl"
                :title="wanIconUrl ? `用外网地址抓取：${wanIconUrl}` : '未填写外网地址'"
                @click="selectFaviconSource('wan')"
              >
                外网
              </button>
            </div>
            <!-- 文字来源不另开面板：两个取色器并进这一行，卡片高度不额外增加 -->
            <div v-if="form.iconType === 'text'" class="text-colors">
              <label class="color-field" title="图标文字颜色">
                <span class="color-label dim">文字</span>
                <NColorPicker v-model:value="form.iconColor" show-alpha size="small" />
              </label>
              <label class="color-field" title="图标背景色">
                <span class="color-label dim">背景</span>
                <NColorPicker v-model:value="form.bgColor" show-alpha size="small" />
              </label>
            </div>
            <NButton size="tiny" quaternary @click="clearIcon">清除</NButton>
          </div>
        </div>
      </NFormItem>

      <NAlert v-if="errorText" type="error" :bordered="false" class="alert">
        {{ errorText }}
      </NAlert>
    </NForm>

    <template #footer>
      <div class="footer">
        <NPopconfirm v-if="isEdit" @positive-click="confirmDelete">
          <template #trigger>
            <NButton size="small" type="error" quaternary>删除</NButton>
          </template>
          确定删除「{{ item?.title }}」？
        </NPopconfirm>
        <span class="spacer" />
        <NButton size="small" @click="requestClose">取消</NButton>
        <NButton
          size="small"
          type="primary"
          :loading="submitting"
          :disabled="!canSubmit"
          @click="submit"
        >
          {{ isEdit ? '保存' : '创建' }}
        </NButton>
      </div>
    </template>
  </NModal>

  <!-- 图标列表：一级菜单选「图标库」时弹出，点选即回填并关闭 -->
  <NModal
    v-model:show="libraryOpen"
    preset="card"
    title="图标库"
    class="library-modal"
    :style="{ width: '580px', maxWidth: '94vw' }"
  >
    <NInput
      v-model:value="libraryQuery"
      placeholder="搜索图标名，如 server / video / home"
      clearable
    />
    <div class="library-body">
      <p v-if="filteredLibrary.length === 0" class="hint dim">
        没有匹配的内置图标，可在下方直接输入任意图标名 ——
        未内置的形状会用几何字形兜底。
      </p>
      <div v-for="section in filteredLibrary" :key="section.group" class="lib-section">
        <div class="lib-title dim">{{ section.group }}</div>
        <div class="lib-grid">
          <button
            v-for="name in section.names"
            :key="name"
            type="button"
            class="lib-item"
            :class="{ active: form.iconValue === name }"
            :title="name"
            @click="pickIcon(name)"
          >
            <FaviconGlyph :name="name" :size="22" />
          </button>
        </div>
      </div>
    </div>

    <!-- 面板里不再放输入框，自定义图标名收进弹层底部 -->
    <template #footer>
      <div class="library-custom">
        <NInput v-model:value="form.iconValue" placeholder="或直接输入图标名，如 mdi:server" />
        <NButton size="small" type="primary" @click="libraryOpen = false">
          完成
        </NButton>
      </div>
    </template>
  </NModal>

  <!-- 新建分组：下拉里选了「＋ 新建分组」才弹，建完自动成为当前所属分组 -->
  <NModal
    v-model:show="groupDialogOpen"
    preset="dialog"
    title="新建分组"
    positive-text="创建"
    negative-text="取消"
    :style="{ width: '360px', maxWidth: '90vw' }"
    :mask-closable="false"
    :positive-button-props="{
      disabled: !groupName.trim(),
      loading: groupSaving,
    }"
    @positive-click="createGroup"
    @negative-click="closeGroupDialog"
    @close="closeGroupDialog"
  >
    <div class="group-dialog">
      <NInput
        ref="groupNameInput"
        v-model:value="groupName"
        placeholder="分组名称，例如：家庭服务"
        :maxlength="48"
        @keydown.enter="createGroup"
      />
      <p v-if="groupError" class="group-dialog-error">{{ groupError }}</p>
    </div>
  </NModal>

  <!-- 未保存确认：替代原生 confirm，与应用视觉语言一致 -->
  <NModal
    v-model:show="confirmClose"
    preset="dialog"
    type="warning"
    title="未保存的修改"
    content="关闭后将丢失未保存的修改。"
    positive-text="放弃修改并关闭"
    negative-text="继续编辑"
    :style="{ width: '360px', maxWidth: '90vw' }"
    :positive-button-props="{ type: 'error' }"
    @positive-click="discardAndClose"
  />
</template>

<style scoped>
/*
 * 编辑卡片弹窗：高度由内容决定，不给固定高度、不留空白。
 * 四个图标来源的内容高度已经对齐（上图源行 + 预览行，无额外面板），
 * 所以切来源时高度不变；超过 86vh 时由下面的表单区自己滚。
 *
 * 注意：弹窗根节点是 teleport 出来的，拿不到 scoped 的 data-v 属性，
 * 所以这里必须用 :global 命中（.editor-modal 是本组件独有的类名，不会外溢）。
 */
:global(.editor-modal) {
  max-height: 86vh;
  display: flex;
  flex-direction: column;
}

/* 固定高度后让表单区自己滚动，header / footer 始终可见 */
:global(.editor-modal .n-card-content) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.two-col {
  display: grid;
  gap: 0 var(--sp-4);
  grid-template-columns: 1fr 1fr;
}

/* 新建分组弹窗：单个输入框 + 一行错误提示 */
.group-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.group-dialog-error {
  margin: 0;
  font-size: 12px;
  color: var(--err);
}

@media (max-width: 640px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}

.alert {
  margin-bottom: var(--sp-4);
}

.hint {
  font-size: 12px;
  line-height: 1.55;
  margin: 0 0 var(--sp-3);
}

.icon-area {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.icon-preview {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

/* ── 一级菜单：图标来源 ───────────────────────────────────
   四等分的一行按钮，选中用主题色底而不是描边（去线留白）。 */
.icon-sources {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-1);
  padding: 3px;
  border-radius: var(--r-sm);
  background: var(--field);
}

.source-tab {
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

.source-tab:hover {
  color: var(--text);
  background: var(--field-hi);
}

.source-tab.active {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}

/* 抓取来源：预览行里的两个小 chip（高度 ≤ 预览框，不改变行高） */
.fetch-sources {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.source-chip {
  height: 24px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-xs);
  background: var(--field);
  color: var(--text-2);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

.source-chip:hover:not(:disabled) {
  background: var(--field-hi);
  color: var(--text);
}

.source-chip.active {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}

.source-chip:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

/* 文字来源的两个取色器并进预览行（行高由 46px 的预览框撑着，不会变高）。 */
.text-colors {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.color-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

/*
 * 取色块：Naive 的 .n-color-picker 默认 width:100%，在弹性行里会被拉成长条，
 * 这里钉成 28×28 的正方形（半径用 --r-xs，对应设计令牌里的“小 chip”那一档）。
 */
.text-colors :deep(.n-color-picker) {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: var(--r-xs) !important;
}

.text-colors :deep(.n-color-picker__fill) {
  border-radius: var(--r-xs) !important;
}

/* 28px 的方块里不显示 RGB/HEX 数值（有 title 提示就够了） */
.text-colors :deep(.n-color-picker__value) {
  display: none;
}

.color-label {
  font-size: 11px;
}

/* 图标库弹层：搜索框常驻顶部，列表区自己滚；小屏时按视口收窄 */
.library-body {
  height: min(320px, 46vh);
  margin-top: var(--sp-3);
  overflow-y: auto;
  scrollbar-gutter: stable;
}

/* 预览框不描边，用一层色块承托图标 */
.preview-box {
  width: 46px;
  height: 46px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--r-sm);
  background: var(--field);
  overflow: hidden;
}

/* 上传模式下预览框是 <button>：点击选文件，hover 给一档色阶 */
button.preview-box {
  padding: 0;
  color: var(--text-2);
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

button.preview-box:hover:not(:disabled) {
  background: var(--field-hi);
  color: var(--accent);
}

button.preview-box:disabled {
  cursor: default;
  opacity: 0.6;
}

.preview-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.preview-text {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 20px;
}

.preview-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 11px;
  gap: 2px;
}

.ellipsis {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lib-section {
  margin-bottom: var(--sp-3);
}

.lib-title {
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}

.lib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(34px, 1fr));
  gap: 5px;
}

/* 图标格：纯色块、无边框；选中项用主题色底而不是描边 */
.lib-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 34px;
  border: 0;
  border-radius: var(--r-sm);
  background: var(--field);
  color: var(--text-2);
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

.lib-item:hover {
  background: var(--field-hi);
  color: var(--text);
}

.lib-item.active {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}

/* 上传模式的预览框就是个按钮：点击选文件；空时里面是「+」 */
.file-input {
  display: none;
}

.library-custom {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.library-custom :deep(.n-input) {
  flex: 1;
}

.footer {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.spacer {
  flex: 1;
}
</style>
