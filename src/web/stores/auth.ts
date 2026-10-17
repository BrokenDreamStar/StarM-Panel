/**
 * 认证 store —— 单管理员账号（无用户名、无多用户）。
 *
 * 状态机（`status`）：
 *   - `loading` 正在询问后端门禁状态（首屏一瞬间）
 *   - `setup`   启用了登录保护但尚未设置密码 → 首启设置页
 *   - `locked`  已设密码但当前没有有效会话 → 登录页
 *   - `ready`   已认证（或门禁被显式关闭）→ 正常渲染面板
 *
 * 后端的会话是无状态签名 Cookie（HttpOnly），前端读不到也不该读，
 * 因此「是否已登录」只能由 `GET /api/auth/state` 回答 —— 不存 localStorage，
 * 避免出现「本地以为登录了、服务端其实已经拒绝」的错位。
 * 唯一持久化的是设置缓存（主题/壁纸），登录页靠它保持观感一致。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ApiError, api } from '@/api/client'
import type { AuthState } from '@shared/types'

export type AuthStatus = 'loading' | 'setup' | 'locked' | 'ready'

/** 从 ApiError（或任意异常）里取出可直接展示的中文文案 */
export function authErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** 从 429 错误里取出「还需等待多少秒」——用于登录按钮倒计时 */
export function retryAfterSec(e: unknown): number | null {
  if (!(e instanceof ApiError)) return null
  const details = e.details
  if (!details || typeof details !== 'object') return null
  const value = (details as { retryAfterSec?: unknown }).retryAfterSec
  return typeof value === 'number' && value > 0 ? Math.ceil(value) : null
}

export const useAuthStore = defineStore('auth', () => {
  const status = ref<AuthStatus>('loading')
  /** 登录保护是否启用（auth.enabled） */
  const enabled = ref(true)
  const passwordSet = ref(false)
  const lastLoginAt = ref<number | null>(null)
  const lastLoginIp = ref<string | null>(null)
  const sessionDays = ref(7)
  const error = ref<string | null>(null)
  /** 最近一次失败的错误码（如 TOO_MANY_ATTEMPTS）—— 登录页据此做差异化提示 */
  const errorCode = ref<string | null>(null)
  /** 被限流时还需等待的秒数 */
  const lockedForSec = ref<number | null>(null)
  const busy = ref(false)

  const authenticated = computed(() => status.value === 'ready' && enabled.value)
  /** 门禁生效中（需要登录）—— 用于展示「登录保护已开启」等提示 */
  const gateActive = computed(() => enabled.value && status.value !== 'ready')

  function setError(e: unknown): void {
    error.value = authErrorMessage(e)
    errorCode.value = e instanceof ApiError ? e.code : null
    lockedForSec.value = retryAfterSec(e)
  }

  function clearError(): void {
    error.value = null
    errorCode.value = null
    lockedForSec.value = null
  }

  function apply(state: AuthState): void {
    enabled.value = state.enabled
    passwordSet.value = state.passwordSet
    lastLoginAt.value = state.lastLoginAt ?? null
    lastLoginIp.value = state.lastLoginIp ?? null
    if (typeof state.sessionDays === 'number') sessionDays.value = state.sessionDays

    if (state.authenticated) status.value = 'ready'
    else if (!state.enabled) status.value = 'ready'
    else status.value = state.passwordSet ? 'locked' : 'setup'
  }

  /** 询问后端当前门禁状态（首屏 / 重试 / 会话失效后调用） */
  async function load(): Promise<void> {
    busy.value = true
    try {
      apply(await api.auth.state())
      clearError()
    } catch (e) {
      setError(e)
    } finally {
      busy.value = false
    }
  }

  /** 首次设定管理员密码，成功后直接进入面板 */
  async function setup(password: string): Promise<boolean> {
    busy.value = true
    clearError()
    try {
      apply(await api.auth.setup(password))
      return true
    } catch (e) {
      setError(e)
      return false
    } finally {
      busy.value = false
    }
  }

  async function login(password: string): Promise<boolean> {
    busy.value = true
    clearError()
    try {
      apply(await api.auth.login(password))
      return true
    } catch (e) {
      setError(e)
      return false
    } finally {
      busy.value = false
    }
  }

  async function logout(): Promise<void> {
    busy.value = true
    try {
      apply(await api.auth.logout())
    } catch {
      // 网络失败也要把本地切回锁屏：宁可多输一次密码，也不要停在「以为还登录着」
      apply({ enabled: enabled.value, passwordSet: true, authenticated: false })
      clearError()
    } finally {
      busy.value = false
    }
  }

  /** 修改密码（成功后本机继续有效，其它设备需重新登录） */
  async function changePassword(current: string, next: string): Promise<boolean> {
    busy.value = true
    clearError()
    try {
      apply(await api.auth.changePassword(current, next))
      return true
    } catch (e) {
      setError(e)
      return false
    } finally {
      busy.value = false
    }
  }

  /** 退出所有设备（含本机） */
  async function revokeAll(): Promise<void> {
    busy.value = true
    try {
      apply(await api.auth.revokeAll())
      clearError()
    } catch (e) {
      setError(e)
    } finally {
      busy.value = false
    }
  }

  /**
   * 会话失效（后端返回 401）时由外壳调用。
   * 不重新请求 state —— 401 本身就是最权威的答案。
   */
  function lock(): void {
    status.value = enabled.value ? (passwordSet.value ? 'locked' : 'setup') : 'ready'
  }

  return {
    status,
    enabled,
    passwordSet,
    authenticated,
    gateActive,
    lastLoginAt,
    lastLoginIp,
    sessionDays,
    error,
    errorCode,
    lockedForSec,
    busy,
    load,
    setup,
    login,
    logout,
    changePassword,
    revokeAll,
    lock,
    clearError,
    apply,
  }
})
