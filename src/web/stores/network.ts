/**
 * 内外网切换 store —— 本项目的核心状态。
 *
 * 设计要点（对应验收要求）：
 *   1. mode 初值来自 localStorage（离线可用、首屏立刻能渲染），缺省 'lan'
 *   2. setMode 双写：**先写 localStorage**（同步、立即生效），再异步 PATCH 设置；
 *      请求失败既不阻塞 UI 也不回滚 —— 用户意图优先
 *   3. bootstrap/服务端设置返回后：不一致时**以服务端为准**并回写 localStorage
 *   4. resolve() 只是 @shared/resolve-url 的薄封装，不重写解析逻辑
 *   5. 探测状态优雅降级：后端 /api/probe/status 返回 404（旧版本二进制）
 *      或请求失败时，一律按「不可达」处理并停止轮询 —— 不报错、不刷屏。
 */
import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/api/client'
import { NETWORK_MODE_KEY } from '@/api/settings'
import { resolveUrl, describeSource } from '@shared/resolve-url'
import type { Item, NetworkMode, ProbeStatus, ResolvedUrl, ResolveSource } from '@shared/types'

const MODES: readonly NetworkMode[] = ['lan', 'wan', 'auto']

export const MODE_LABEL: Record<NetworkMode, string> = {
  lan: '内网',
  wan: '外网',
  auto: '自动',
}

export const MODE_HINT: Record<NetworkMode, string> = {
  lan: '优先使用内网地址，缺失时回退外网',
  wan: '优先使用外网地址，缺失时回退内网',
  auto: '根据探测结果自动选择，探测不可用时保守走外网',
}

function isMode(v: unknown): v is NetworkMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v)
}

function readLocalMode(): NetworkMode {
  try {
    const raw = localStorage.getItem(NETWORK_MODE_KEY)
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

/**
 * 把后端返回的探测缓存归一化成 `Record<itemId, boolean>`。
 *
 * 后端实际返回 `ProbeStatus = Record<number, ProbeEntry>`，其中
 * `reachable: null` 表示被 SSRF 白名单拒绝（未真正探测）→ 按不可达处理。
 */
function normalizeProbeStatus(body: unknown): ProbeStatus {
  if (!body || typeof body !== 'object') return {}
  const out: ProbeStatus = {}
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const id = Number(key)
    if (!Number.isInteger(id)) continue
    if (typeof value === 'boolean') {
      out[id] = { reachable: value, checkedAt: Date.now() }
      continue
    }
    if (value && typeof value === 'object') {
      const entry = value as { reachable?: unknown; checkedAt?: unknown; reason?: unknown }
      const reachable = typeof entry.reachable === 'boolean' ? entry.reachable : null
      out[id] = {
        reachable,
        checkedAt: typeof entry.checkedAt === 'number' ? entry.checkedAt : Date.now(),
        reason:
          entry.reason === 'blocked' || entry.reason === 'no-url' || entry.reason === 'error'
            ? entry.reason
            : undefined,
      }
    }
  }
  return out
}

export const useNetworkStore = defineStore('network', () => {
  const mode = ref<NetworkMode>(readLocalMode())

  /** 服务端设置是否已经对齐过本地值 */
  const syncedFromServer = ref(false)
  /** 最近一次 setMode 的 PATCH 是否失败（仅用于提示，不影响 mode） */
  const persistError = ref<string | null>(null)

  // ── 探测状态 ────────────────────────────────────────────────
  const probeStatus = ref<ProbeStatus>({})
  const probing = ref(false)
  /** 后端探测接口不可用（404/501，例如旧二进制）时置位，停止轮询 */
  const probeUnsupported = ref(false)
  const lastProbeAt = ref<number | null>(null)

  let probeTimer: ReturnType<typeof setInterval> | null = null
  let probeConfig = { enabled: false, intervalMs: 30_000 }

  const isAuto = computed(() => mode.value === 'auto')
  const label = computed(() => MODE_LABEL[mode.value])
  /** 探测过的卡片数量（0 = 全部未探测，UI 显示空心点） */
  const probedCount = computed(() => Object.keys(probeStatus.value).length)

  /**
   * 解析卡片最终使用的 URL。
   * 卡片级 networkPref 优先于全局 mode 的逻辑在 @shared/resolve-url 内。
   */
  function resolve(item: Item): ResolvedUrl {
    const entry = probeStatus.value[item.id]
    return resolveUrl(item, {
      mode: mode.value,
      // reachable === null（被白名单拒绝）视为不可达
      lanReachable: entry?.reachable === true,
    })
  }

  function resolveSourceLabel(source: ResolveSource): string {
    return describeSource(source)
  }

  /** 状态点：true=绿 false=灰 undefined=未探测 */
  function probeState(item: Item): boolean | undefined {
    return probeStatus.value[item.id]?.reachable ?? undefined
  }

  /** 卡片实际使用的地址是否与全局模式「不一致」（需要显示来源角标） */
  function isOffMode(item: Item, resolved: ResolvedUrl): boolean {
    if (resolved.source === 'none') return true
    if (resolved.source === 'fallback') return true
    // 卡片级强制偏好覆盖了全局模式 → 也算偏离
    if (item.networkPref !== 'auto') return true
    // auto 模式下由探测结果决定走内网，与全局模式本身无「偏离」概念
    if (mode.value === 'auto') return false
    return resolved.source !== mode.value
  }

  /**
   * 切换到指定模式。不返回 Promise —— 调用方（按钮 / 快捷键）拿到的是
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

    // 3) 切到自动模式时确保有一份探测数据（没有就触发一轮）
    if (next === 'auto' && probeConfig.enabled && !probeUnsupported.value) {
      void refreshProbe(probedCount.value === 0)
    }
  }

  /** 循环切换：内网 → 外网 → 自动 → 内网 */
  function cycleMode(): NetworkMode {
    const idx = MODES.indexOf(mode.value)
    const next = MODES[(idx + 1) % MODES.length] ?? 'lan'
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

  // ── 探测 ────────────────────────────────────────────────────

  /**
   * 拉取（或触发）探测结果。
   * @param force POST /api/probe/refresh 立即全量探测，否则读缓存
   */
  async function refreshProbe(force = false): Promise<void> {
    if (probing.value || probeUnsupported.value) return
    probing.value = true
    try {
      const res = await fetch(force ? '/api/probe/refresh' : '/api/probe/status', {
        method: force ? 'POST' : 'GET',
        headers: { accept: 'application/json' },
      })

      if (res.status === 404 || res.status === 501) {
        // 接口尚未实现（旧后端）：全部按不可达处理，并停止轮询
        probeUnsupported.value = true
        probeStatus.value = {}
        return
      }
      if (!res.ok) return

      probeStatus.value = normalizeProbeStatus(await res.json())
      lastProbeAt.value = Date.now()
    } catch {
      // 网络错误：保留上一次结果，下一轮再试
    } finally {
      probing.value = false
    }
  }

  function startProbing(config: { enabled: boolean; intervalMs: number }): void {
    probeConfig = config
    if (probeTimer) {
      clearInterval(probeTimer)
      probeTimer = null
    }
    if (!config.enabled) return

    const interval = Math.max(5_000, config.intervalMs)
    probeTimer = setInterval(() => void refreshProbe(false), interval)

    // 已经有缓存就只读一次，否则触发全量探测
    void refreshProbe(probedCount.value === 0)
  }

  function stopProbing(): void {
    if (probeTimer) clearInterval(probeTimer)
    probeTimer = null
  }

  onScopeDispose(stopProbing)

  return {
    mode,
    label,
    isAuto,
    syncedFromServer,
    persistError,
    probeStatus,
    probing,
    probeUnsupported,
    lastProbeAt,
    probeConfig,
    probedCount,
    resolve,
    resolveSourceLabel,
    probeState,
    isOffMode,
    setMode,
    cycleMode,
    syncFromServer,
    refreshProbe,
    startProbing,
    stopProbing,
  }
})
