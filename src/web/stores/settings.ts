/**
 * 应用设置 store。
 *
 * 单一事实来源是**后端**（GET/PATCH /api/settings），但会：
 *   - 首屏先从 localStorage 读缓存渲染，避免闪白/闪深
 *   - 服务端返回后以服务端为准，并回写缓存
 *   - PATCH 采用乐观更新：本地立即生效，失败只记录错误（不回滚、不阻塞 UI）
 */
import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/api/client'
import {
  SETTINGS_CACHE_KEY,
  readEnum,
  readSetting,
  type SettingsKey,
  type SettingsShape,
} from '@/api/settings'

function loadCache(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function saveCache(values: Record<string, unknown>): void {
  try {
    localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(values))
  } catch {
    // 隐私模式 / 配额满：缓存失败不影响功能
  }
}

export const useSettingsStore = defineStore('settings', () => {
  /** 原始设置（服务端返回 + 本地乐观覆盖） */
  const raw = ref<Record<string, unknown>>(loadCache())
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const hydrated = ref(false)

  /** PATCH 失败的键，供设置页提示 */
  const failedKeys = shallowRef<Set<string>>(new Set())

  function get<K extends SettingsKey>(key: K): SettingsShape[K] {
    return readSetting(raw.value, key)
  }

  const networkMode = computed(() => readEnum(raw.value, 'network.mode', ['lan', 'wan', 'auto']))
  const themeMode = computed(() => readEnum(raw.value, 'theme.mode', ['light', 'dark', 'system']))
  const accent = computed(() => get('theme.accent'))

  /**
   * 系统深色偏好 —— 放在 store 而不是 App.vue，是因为 themeMode 有三态：
   * 'system' 时「界面上到底是深是浅」只有 isDark 说得清，而开关组件和外壳都要用它。
   */
  const systemDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    systemDark.value = e.matches
  })

  /** 生效的深色状态（themeMode + 系统偏好），所有明暗相关的视觉都以此为准 */
  const isDark = computed(() => {
    if (themeMode.value === 'dark') return true
    if (themeMode.value === 'light') return false
    return systemDark.value
  })
  const blur = computed(() => get('theme.blur'))
  const wallpaperType = computed(() =>
    readEnum(raw.value, 'wallpaper.type', ['none', 'solid', 'gradient', 'asset', 'bing']),
  )
  const wallpaperValue = computed(() => raw.value['wallpaper.value'] ?? null)
  const showMonitor = computed(() => get('ui.showMonitor'))
  const cardSize = computed(() => readEnum(raw.value, 'ui.cardSize', ['sm', 'md', 'lg']))
  const openMode = computed(() => readEnum(raw.value, 'ui.openMode', ['newTab', 'self']))
  /** 卡片玻璃风格与其参数（见 composables/useGlassTheme.ts） */
  const glassStyle = computed(() => readEnum(raw.value, 'ui.glassStyle', ['frost', 'liquid']))
  const glassOpacity = computed(() => get('ui.glassOpacity'))
  const glassScale = computed(() => get('ui.glassScale'))
  const glassChroma = computed(() => get('ui.glassChroma'))
  const searchEngine = computed(() => get('search.defaultEngine'))
  const monitorInterval = computed(() => get('monitor.interval'))
  const monitorGpuEnabled = computed(() => get('monitor.gpuEnabled'))
  const monitorDisks = computed(() => get('monitor.disks'))
  const monitorNetIfaces = computed(() => get('monitor.netIfaces'))

  /** 用服务端设置整体替换（bootstrap / GET /api/settings） */
  function hydrate(settings: Record<string, unknown>): void {
    raw.value = { ...raw.value, ...settings }
    hydrated.value = true
    error.value = null
    saveCache(raw.value)
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      hydrate(await api.settings.get())
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  /**
   * 乐观更新：先写本地（立即生效），再异步 PATCH。
   * 失败时保留本地值并记录错误 —— 与 network.setMode 的约定一致：
   * 离线状态下 UI 仍然可用，不回滚、不阻塞。
   */
  async function patch(patchBody: Record<string, unknown>): Promise<boolean> {
    raw.value = { ...raw.value, ...patchBody }
    saveCache(raw.value)
    saving.value = true
    try {
      const merged = await api.settings.patch(patchBody)
      hydrate(merged)
      failedKeys.value = new Set()
      return true
    } catch (e) {
      failedKeys.value = new Set([
        ...failedKeys.value,
        ...Object.keys(patchBody),
      ])
      error.value = e instanceof Error ? e.message : String(e)
      return false
    } finally {
      saving.value = false
    }
  }

  return {
    raw,
    loading,
    saving,
    error,
    hydrated,
    failedKeys,
    get,
    networkMode,
    themeMode,
    systemDark,
    isDark,
    accent,
    blur,
    wallpaperType,
    wallpaperValue,
    showMonitor,
    cardSize,
    openMode,
    glassStyle,
    glassOpacity,
    glassScale,
    glassChroma,
    searchEngine,
    monitorInterval,
    monitorGpuEnabled,
    monitorDisks,
    monitorNetIfaces,
    hydrate,
    load,
    patch,
  }
})
