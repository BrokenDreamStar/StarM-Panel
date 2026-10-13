/**
 * 内外网切换 store —— 本项目的核心状态。
 *
 * 设计要点：
 *   1. 两个独立设置：
 *      - `network.autoMode`：是否按访问方式自动选择（IP/localhost → 内网，域名 → 外网）
 *      - `network.mode`：关闭自动时的默认模式（'lan' | 'wan'）
 *   2. mode 初值来自 localStorage（离线可用、首屏立刻能渲染），缺省 'lan'
 *   3. setMode 双写：**先写 localStorage**（同步、立即生效），再异步 PATCH 设置；
 *      请求失败既不阻塞 UI 也不回滚 —— 用户意图优先
 *   4. bootstrap/服务端设置返回后：mode 不一致时**以服务端为准**并回写 localStorage；
 *      autoMode 直接取自 settings store（其自身已有 localStorage 缓存）
 *   5. resolve() 只是 @shared/resolve-url 的薄封装，传入的是落地后的具体模式
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/api/client'
import { NETWORK_MODE_KEY } from '@/api/settings'
import { useSettingsStore } from '@/stores/settings'
import { resolveUrl, describeSource, isLanHost } from '@shared/resolve-url'
import type { Item, NetworkMode, ResolvedUrl, ResolveSource } from '@shared/types'

const MODES: readonly NetworkMode[] = ['lan', 'wan']

function isMode(v: unknown): v is NetworkMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v)
}

function readLocalMode(): NetworkMode {
  try {
    const raw = localStorage.getItem(NETWORK_MODE_KEY)
    // 旧版本可能存过 'auto'，这里不再接受，回落到默认内网
    return isMode(raw) ? raw : 'lan'
  } catch {
    return 'lan'
  }
}

function writeLocalMode(mode: NetworkMode): void {
  try {
    localStorage.setItem(NETWORK_MODE_KEY, mode)
  } catch {
    // 忽略配额 / 隐私模式错误
  }
}

export const useNetworkStore = defineStore('network', () => {
  const settings = useSettingsStore()

  const mode = ref<NetworkMode>(readLocalMode())

  /** 服务端设置是否已经对齐过本地值 */
  const syncedFromServer = ref(false)
  /** 最近一次写入服务端是否失败（仅用于提示，不影响本地值） */
  const persistError = ref<string | null>(null)

  /** 是否启用「按访问方式自动选择」—— 单一事实来源是 settings store */
  const autoMode = computed(() => settings.get('network.autoMode'))

  /**
   * 生效模式：
   *   - autoMode 开启 → 按「面板本身是怎么被访问的」判断（IP / localhost = 内网，域名 = 外网）
   *   - autoMode 关闭 → 使用默认模式 mode
   */
  const effectiveMode = computed<NetworkMode>(() => {
    if (!autoMode.value) return mode.value
    return isLanHost(window.location.hostname) ? 'lan' : 'wan'
  })

  /**
   * 解析卡片最终使用的 URL。
   * 卡片级 networkPref 优先于全局模式的逻辑在 @shared/resolve-url 内；
   * 这里传入的是落地后的具体模式。
   */
  function resolve(item: Item): ResolvedUrl {
    return resolveUrl(item, { mode: effectiveMode.value })
  }

  function resolveSourceLabel(source: ResolveSource): string {
    return describeSource(source)
  }

  /** 卡片实际使用的地址是否与全局模式「不一致」（需要显示来源角标） */
  function isOffMode(item: Item, resolved: ResolvedUrl): boolean {
    if (resolved.source === 'none') return true
    if (resolved.source === 'fallback') return true
    // 卡片级强制偏好覆盖了全局模式 → 也算偏离
    if (item.networkPref !== 'auto') return true
    return resolved.source !== effectiveMode.value
  }

  /**
   * 切换到指定默认模式。不返回 Promise —— 调用方（按钮 / 快捷键）拿到的是
   * 「本地已生效」的立即结果。
   */
  function setMode(next: NetworkMode): void {
    if (!isMode(next)) return
    // 1) 同步写 localStorage —— 立即生效、离线可用
    writeLocalMode(next)
    mode.value = next

    // 2) 异步持久化到服务端 —— 失败不回滚、不阻塞
    void api.settings
      .patch({ 'network.mode': next })
      .then(() => {
        persistError.value = null
      })
      .catch((e: unknown) => {
        persistError.value = e instanceof Error ? e.message : String(e)
      })
  }

  /** 开关「自动选择」—— 走 settings store 的乐观更新 */
  async function setAutoMode(next: boolean): Promise<boolean> {
    const ok = await settings.patch({ 'network.autoMode': next })
    persistError.value = ok ? null : (settings.error ?? '写入失败')
    return ok
  }

  /**
   * 二态切换：内网 ↔ 外网（右上角按钮与 Ctrl/Cmd+Shift+N 快捷键用）。
   * 自动模式下点击 = 接管为手动：关闭自动并落到与当前生效模式相反的一侧。
   */
  function toggleMode(): NetworkMode {
    const next: NetworkMode = effectiveMode.value === 'lan' ? 'wan' : 'lan'
    if (autoMode.value) void setAutoMode(false)
    setMode(next)
    return next
  }

  /**
   * 用服务端设置对齐本地模式（启动顺序的第 2 步）。
   * ⚠️ 默认只对齐一次，否则一次会话里用户的手动切换会被随后的
   * settings 刷新覆盖掉。
   */
  function syncFromServer(serverMode: unknown, force = false): void {
    if (syncedFromServer.value && !force) return
    syncedFromServer.value = true
    if (!isMode(serverMode)) return
    if (serverMode === mode.value) return
    // 以服务端为准，并回写 localStorage
    mode.value = serverMode
    writeLocalMode(serverMode)
  }

  return {
    mode,
    autoMode,
    effectiveMode,
    syncedFromServer,
    persistError,
    resolve,
    resolveSourceLabel,
    isOffMode,
    setMode,
    setAutoMode,
    toggleMode,
    syncFromServer,
  }
})
