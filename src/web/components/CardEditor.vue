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
 *   - favicon 优先调用后端 /api/favicon（服务端抓取，内网可用）；
 *     失败时用 DuckDuckGo 的公开占位地址，并明确标注它需要外网。
 *   - 图标库是**本地常量列表**，不请求 Iconify 公网 API。
 */
import { computed, ref, watch } from 'vue'
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
  NTabPane,
  NTabs,
  useMessage,
} from 'naive-ui'
import { api, ApiError } from '@/api/client'
import { useItemsStore } from '@/stores/items'
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
      'mdi:home',
      'mdi:apps',
      'mdi:view-dashboard',
      'mdi:link',
      'mdi:open-in-new',
      'mdi:star',
      'mdi:heart',
      'mdi:bookmark',
      'mdi:folder',
      'mdi:file',
      'mdi:bell',
      'mdi:calendar',
    ],
  },
  {
    group: '服务与运维',
    names: [
      'mdi:server',
      'mdi:nas',
      'mdi:docker',
      'mdi:database',
      'mdi:harddisk',
      'mdi:router-network',
      'mdi:shield-check',
      'mdi:cloud',
      'mdi:terminal',
      'mdi:code-braces',
      'mdi:chart-line',
      'mdi:speedometer',
    ],
  },
  {
    group: '媒体与设备',
    names: [
      'mdi:monitor',
      'mdi:movie',
      'mdi:music',
      'mdi:camera',
      'mdi:image',
      'mdi:video',
      'mdi:play',
      'mdi:book-open-page-variant',
      'mdi:notebook',
      'mdi:clock-outline',
      'mdi:download',
      'mdi:upload',
    ],
  },
  {
    group: '系统与品牌',
    names: [
      'mdi:linux',
      'mdi:apple',
      'mdi:home-assistant',
      'mdi:account',
      'mdi:cog',
      'mdi:lock',
      'mdi:key',
      'mdi:wifi',
      'mdi:lan',
      'mdi:earth',
      'mdi:rocket',
      'mdi:tag',
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

const iconTab = ref<IconType>('iconify')
const submitting = ref(false)
const errorText = ref<string | null>(null)
const faviconInput = ref('')
const faviconBusy = ref(false)
const uploading = ref(false)
const dirty = ref(false)

const isEdit = computed(() => props.item !== null)
const title = computed(() => (isEdit.value ? '编辑卡片' : '新建卡片'))

/**
 * ⚠️ 选项值刻意不含 null：Naive UI 的 SelectMixedOption 不接受 `number | null` 的联合类型。
 * 未分组用哨兵值 0 表示（后端 groupId 必须为正整数，0 不会与真实 id 冲突），
 * 提交前再由 toGroupId() 转回 null。
 */
const UNGROUPED = 0

const groupOptions = computed(() => [
  { label: '未分组', value: UNGROUPED },
  ...props.groups.map((g) => ({ label: g.name, value: g.id })),
])

const groupValue = computed({
  get: () => form.value.groupId ?? UNGROUPED,
  set: (v: number) => {
    form.value.groupId = v === UNGROUPED ? null : v
    dirty.value = true
  },
})

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
    dirty.value = false
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
      iconTab.value = item.iconType
      faviconInput.value = item.iconType === 'favicon' ? (item.iconValue ?? '') : ''
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
      iconTab.value = 'iconify'
      faviconInput.value = ''
    }
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

function pickIcon(name: string): void {
  form.value.iconType = 'iconify'
  form.value.iconValue = name
  iconTab.value = 'iconify'
  dirty.value = true
}

function clearIcon(): void {
  form.value.iconValue = ''
  form.value.iconColor = ''
  form.value.bgColor = ''
  dirty.value = true
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
    dirty.value = true
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
      dirty.value = true
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

/** favicon 占位地址：DuckDuckGo 的公开服务（需要外网） */
function duckUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`)
    return `https://icons.duckduckgo.com/ip3/${u.hostname}.ico`
  } catch {
    return null
  }
}

const faviconPreview = computed(() => duckUrl(faviconInput.value))

/** 优先让后端抓取（服务端在内网也能取到），失败再用公开占位地址 */
async function fetchFavicon(): Promise<void> {
  const source = faviconInput.value.trim()
  if (!source) {
    message.warning('请先填写站点地址')
    return
  }
  faviconBusy.value = true
  try {
    const result = await api.favicon.fetch(source)
    form.value.iconType = 'favicon'
    form.value.iconValue = result.url
    dirty.value = true
    message.success('已通过后端抓取 favicon')
  } catch (e) {
    const fallback = duckUrl(source)
    if (!fallback) {
      message.error('地址无法解析')
      return
    }
    form.value.iconType = 'favicon'
    form.value.iconValue = fallback
    dirty.value = true
    message.warning(
      `后端抓取不可用（${e instanceof Error ? e.message : '未知错误'}），` +
        '已填入 DuckDuckGo 占位地址（需要客户端能访问外网）',
    )
  } finally {
    faviconBusy.value = false
  }
}

function useManualIconUrl(): void {
  const raw = faviconInput.value.trim()
  if (!raw) {
    message.warning('请先填写图标地址')
    return
  }
  form.value.iconType = 'favicon'
  form.value.iconValue = raw
  dirty.value = true
  message.success('已使用手动输入的图标地址')
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
    dirty.value = false
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

function close(): void {
  if (dirty.value) {
    const ok = window.confirm('有未保存的修改，确定关闭吗？')
    if (!ok) return
  }
  emit('update:show', false)
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="title"
    class="editor-modal"
    :style="{ width: '720px', maxWidth: '94vw' }"
    :mask-closable="false"
    @update:show="(v: boolean) => (v ? emit('update:show', true) : close())"
  >
    <NForm label-placement="top" size="small" @input="dirty = true">
      <div class="two-col">
        <NFormItem label="标题" required>
          <NInput
            v-model:value="form.title"
            placeholder="例如：群晖 NAS"
            :maxlength="64"
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

      <NAlert v-if="urlsEmpty" type="warning" :bordered="false" class="alert">
        内网地址与外网地址至少填写一个 —— 两个都为空无法保存。
      </NAlert>
      <NAlert v-else-if="urlWarning" type="warning" :bordered="false" class="alert">
        {{ urlWarning }}
      </NAlert>
      <p v-else class="hint dim">
        不需要写 <span class="mono">http://</span>，后端会自动补全并归一化（保存后以服务端返回值展示）。
      </p>

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
          />
        </NFormItem>
      </div>

      <NFormItem label="图标">
        <div class="icon-area">
          <div class="icon-preview">
            <span class="preview-box">
              <img
                v-if="
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
              <FaviconGlyph v-else :name="form.iconValue || form.title || 'home'" :size="30" />
            </span>
            <div class="preview-meta">
              <span class="mono dim">{{ form.iconType }}</span>
              <span class="mono dim ellipsis" :title="form.iconValue">
                {{ form.iconValue || '未设置' }}
              </span>
              <NButton size="tiny" quaternary @click="clearIcon">清除</NButton>
            </div>
          </div>

          <NTabs v-model:value="iconTab" type="segment" size="small" animated>
            <!-- 1. 图标库 -->
            <NTabPane name="iconify" tab="图标库">
              <p class="hint dim">
                内置精选图标名（本地常量，不请求 Iconify 公网 API）。
                未命中内置形状时会用按名称生成的几何字形兜底，离线也可区分。
              </p>
              <div v-for="section in ICON_LIBRARY" :key="section.group" class="lib-section">
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
                    <FaviconGlyph :name="name" :size="20" />
                  </button>
                </div>
              </div>
              <NFormItem label="或直接输入图标名">
                <NInput
                  v-model:value="form.iconValue"
                  placeholder="mdi:server"
                  @update:value="form.iconType = 'iconify'"
                />
              </NFormItem>
            </NTabPane>

            <!-- 2. 上传 -->
            <NTabPane name="asset" tab="上传">
              <p class="hint dim">
                支持 PNG / JPEG / GIF / WebP / SVG / ICO，单个 ≤256KB。
                优先上传到服务端资源库；接口不可用时自动改为内联（dataURL）存储。
              </p>
              <div class="upload-row">
                <input
                  type="file"
                  accept="image/*"
                  :disabled="uploading"
                  @change="onFile"
                />
                <NButton size="tiny" :loading="uploading" @click="clearIcon">重置</NButton>
              </div>
              <NFormItem label="图片地址（也可手填）">
                <NInput
                  v-model:value="form.iconValue"
                  placeholder="/api/assets/xxxx 或 https://…/icon.png"
                  @update:value="form.iconType = 'asset'"
                />
              </NFormItem>
            </NTabPane>

            <!-- 3. 文字 -->
            <NTabPane name="text" tab="文字">
              <p class="hint dim">
                显示标题的第一个字符（支持 emoji），可单独指定前景色与背景色。
              </p>
              <div class="two-col">
                <NFormItem label="前景色">
                  <NColorPicker
                    v-model:value="form.iconColor"
                    :show-alpha="false"
                    size="small"
                    @update:value="form.iconType = 'text'"
                  />
                </NFormItem>
                <NFormItem label="背景色">
                  <NColorPicker
                    v-model:value="form.bgColor"
                    :show-alpha="false"
                    size="small"
                    @update:value="form.iconType = 'text'"
                  />
                </NFormItem>
              </div>
              <NButton size="tiny" secondary @click="form.iconType = 'text'">
                使用文字图标
              </NButton>
            </NTabPane>

            <!-- 4. favicon -->
            <NTabPane name="favicon" tab="抓取 favicon">
              <p class="hint dim">
                填写站点地址后点「抓取」：优先调用后端
                <span class="mono">POST /api/favicon</span>（服务端抓取，内网可用）；
                失败时回落到 DuckDuckGo 占位地址
                <span class="mono">icons.duckduckgo.com/ip3/&lt;host&gt;.ico</span>
                —— 该地址需要客户端能访问外网，纯内网环境请改用上传或图标库。
              </p>
              <div class="favicon-row">
                <NInput
                  v-model:value="faviconInput"
                  placeholder="https://example.com 或 192.168.1.5:8080"
                  clearable
                />
                <NButton size="small" type="primary" :loading="faviconBusy" @click="fetchFavicon">
                  抓取
                </NButton>
              </div>
              <div v-if="faviconPreview" class="favicon-hint dim mono">
                占位地址预览：{{ faviconPreview }}
              </div>
              <div class="favicon-row">
                <NButton size="tiny" secondary @click="useManualIconUrl">
                  使用输入的地址作为图标 URL
                </NButton>
              </div>
              <NFormItem label="图标地址（最终写入 iconValue）">
                <NInput
                  v-model:value="form.iconValue"
                  placeholder="https://…/favicon.ico"
                  @update:value="form.iconType = 'favicon'"
                />
              </NFormItem>
            </NTabPane>
          </NTabs>
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
          删除后无法恢复，确定删除「{{ item?.title }}」？
        </NPopconfirm>
        <span class="spacer" />
        <NButton size="small" @click="close">取消</NButton>
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
</template>

<style scoped>
.editor-modal {
  max-height: 92vh;
}

.two-col {
  display: grid;
  gap: 0 var(--sp-4);
  grid-template-columns: 1fr 1fr;
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
  gap: var(--sp-4);
}

.icon-preview {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
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

.upload-row,
.favicon-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
  flex-wrap: wrap;
}

.favicon-row :deep(.n-input) {
  flex: 1;
  min-width: 220px;
}

.favicon-hint {
  font-size: 11px;
  margin-bottom: var(--sp-2);
  word-break: break-all;
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
