/**
 * 后端 API 客户端 —— 薄封装，只负责：
 *   1. 拼路径 + JSON 序列化
 *   2. 把 `{ error: { code, message, details } }` 统一抛成 ApiError 实例
 *   3. 204 / 空响应体安全处理
 *
 * 不做任何 URL 归一化 —— 后端已经归一化（见 @shared/schemas 的 urlInput），
 * 前端直接展示后端返回的值。
 */
import type {
  Asset,
  AuthState,
  BootstrapPayload,
  Group,
  Item,
  SystemSnapshot,
  SystemStaticInfo,
} from '@shared/types'
import { TEXT as T } from '@shared/text'

/**
 * 认证失效的全局广播事件名。
 *
 * 任何请求拿到 401（未登录 / 待初始化）都会触发它，外壳据此立刻切回登录页，
 * 不需要每个调用点各自处理 —— 会话过期时往往同时有 SSE、轮询、
 * 用户操作三条线在跑，逐个 catch 是漏网的根源。
 */
export const AUTH_REQUIRED_EVENT = 'starm:auth-required'

export interface AuthRequiredDetail {
  code: 'UNAUTHENTICATED' | 'SETUP_REQUIRED'
}

function notifyAuthRequired(err: ApiError): void {
  if (err.status !== 401) return
  if (err.code !== 'UNAUTHENTICATED' && err.code !== 'SETUP_REQUIRED') return
  try {
    const detail: AuthRequiredDetail = { code: err.code }
    window.dispatchEvent(new CustomEvent<AuthRequiredDetail>(AUTH_REQUIRED_EVENT, { detail }))
  } catch {
    // 非浏览器环境（单测）里没有 window —— 静默跳过
  }
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** 从任意响应中尽力提取后端错误结构 */
async function toApiError(res: Response): Promise<ApiError> {
  let code = 'HTTP_' + res.status
  let message = T.api.requestFailed(res.status)
  let details: unknown

  try {
    const body: unknown = await res.json()
    if (body && typeof body === 'object' && 'error' in body) {
      const err = (body as { error?: unknown }).error
      if (err && typeof err === 'object') {
        const e = err as { code?: unknown; message?: unknown; details?: unknown }
        if (typeof e.code === 'string') code = e.code
        if (typeof e.message === 'string') message = e.message
        details = e.details
      }
    }
  } catch {
    // 响应体不是 JSON（网关错误页等），保留上面的兜底文案
  }

  return new ApiError(res.status, code, message, details)
}

/**
 * 构造请求头。
 *
 * 抽成独立函数是为了可测试 —— 这里有一条容易踩的规则：
 * **只有字符串 body（JSON）才设 `content-type: application/json`；
 * FormData 绝不能带这个头。**
 *
 * 一旦对 FormData 显式指定 Content-Type，浏览器就不再生成本该由它生成的
 * `multipart/form-data; boundary=...`，服务端 `parseBody()` 会解析不出任何字段
 * （实测返回 400 NO_FILE），图标上传随之静默失效。
 */
export function buildHeaders(init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {}
  if (typeof init?.body === 'string') {
    headers['content-type'] = 'application/json'
  }
  return { ...headers, ...(init?.headers as Record<string, string> | undefined) }
}

/**
 * 发请求，并把非 2xx 统一转成 ApiError。
 *
 * 与 `request()` 分开，是因为备份导出要读响应头（content-disposition 里的
 * 文件名），而不是解析后的 body —— 但两条路径的错误语义必须完全一致。
 */
async function send(path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(path, { ...init, headers: buildHeaders(init) })
  } catch (e) {
    // 网络层失败（后端未启动 / 断网）—— 也要抛 ApiError，调用方只需处理一种类型
    throw new ApiError(0, 'NETWORK_ERROR', e instanceof Error ? e.message : String(e))
  }

  if (!res.ok) {
    const err = await toApiError(res)
    notifyAuthRequired(err)
    throw err
  }
  return res
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init)
  if (res.status === 204) return undefined as T

  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
})

// ─────────────────────────────────────────────────────────────
// 请求体类型（与后端 schema 对齐，全部字段可选）
// ─────────────────────────────────────────────────────────────

export interface ItemInput {
  groupId?: number | null
  title?: string
  subtitle?: string | null
  iconType?: Item['iconType']
  iconValue?: string | null
  iconColor?: string | null
  bgColor?: string | null
  lanUrl?: string | null
  wanUrl?: string | null
  networkPref?: Item['networkPref']
  sort?: number
  enabled?: boolean
}

export interface GroupInput {
  name?: string
  icon?: string | null
  sort?: number
  collapsed?: boolean
}

// ─────────────────────────────────────────────────────────────
// 备份（导入 / 导出）
// ─────────────────────────────────────────────────────────────

export type BackupImportMode = 'merge' | 'replace'

/** 导入结果的分类计数，用于成功提示 */
export interface BackupImportResult {
  ok: boolean
  mode: BackupImportMode
  imported: { groups: number; items: number; assets: number; settings: number }
}

export interface BackupExport {
  /** 下载文件名：以后端 content-disposition 为准，拿不到时前端按同一规则兜底 */
  filename: string
  /** 备份 JSON 原文，原样写进文件即可 */
  text: string
}

/**
 * 从 `content-disposition` 解析文件名。
 *
 * 服务端已经给了文件名（见 routes/backup.ts），前端不该再拼一份 ——
 * 两处各写一套迟早会漂移。非标准头（网关改写、缺字段）时返回 null，
 * 由调用方兜底。
 */
export function parseDispositionFilename(disposition: string | null): string | null {
  if (!disposition) return null
  // RFC 5987 形式优先：filename*=UTF-8''%E5%A4%87%E4%BB%BD.json
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim())
    } catch {
      // 编码坏了就退回下面按普通形式解析
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition)
  return plain?.[1]?.trim() || null
}

/** 后端文件名口径的兜底副本，只在响应头不可用时使用 */
function fallbackBackupFilename(): string {
  return `starm-panel-backup-${new Date().toISOString().slice(0, 10)}.json`
}

/** 导出备份：取回 JSON 原文与文件名，交给调用方决定怎么落盘 */
async function exportBackup(withAssets: boolean): Promise<BackupExport> {
  const res = await send(`/api/backup/export${withAssets ? '?assets=true' : ''}`)
  return {
    filename:
      parseDispositionFilename(res.headers.get('content-disposition')) ?? fallbackBackupFilename(),
    text: await res.text(),
  }
}

// ─────────────────────────────────────────────────────────────
// 接口
// ─────────────────────────────────────────────────────────────

export const api = {
  health: () =>
    request<{ status: string; version: string; uptime: number; pid: number; platform: string }>(
      '/healthz',
    ),

  bootstrap: () => request<BootstrapPayload>('/api/bootstrap'),

  /**
   * 管理员认证（单账号）。这些接口是门禁内唯一允许匿名访问的一批 ——
   * 登录页需要它们在未登录状态下也能调用。
   */
  auth: {
    state: () => request<AuthState>('/api/auth/state'),
    /** 首次设定管理员密码（仅在尚未设置时可用） */
    setup: (password: string) => request<AuthState>('/api/auth/setup', json({ password })),
    login: (password: string) => request<AuthState>('/api/auth/login', json({ password })),
    logout: () => request<AuthState>('/api/auth/logout', { method: 'POST' }),
    /** 修改密码：需要当前密码，成功后其它设备全部强制重新登录 */
    changePassword: (currentPassword: string, newPassword: string) =>
      request<AuthState>('/api/auth/password', json({ currentPassword, newPassword })),
    /** 退出所有设备（会话世代自增） */
    revokeAll: () => request<AuthState>('/api/auth/revoke-all', { method: 'POST' }),
  },

  groups: {
    list: () => request<Group[]>('/api/groups'),
    create: (body: GroupInput & { name: string }) => request<Group>('/api/groups', json(body)),
    update: (id: number, body: GroupInput) =>
      request<Group>(`/api/groups/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: number) => request<void>(`/api/groups/${id}`, { method: 'DELETE' }),
    reorder: (order: Array<{ id: number; sort: number }>) =>
      request<Group[]>('/api/groups/reorder', json({ order })),
  },

  items: {
    list: (onlyEnabled = true) =>
      request<Item[]>(`/api/items${onlyEnabled ? '' : '?enabled=false'}`),
    create: (body: ItemInput & { title: string }) => request<Item>('/api/items', json(body)),
    update: (id: number, body: ItemInput) =>
      request<Item>(`/api/items/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: number) => request<void>(`/api/items/${id}`, { method: 'DELETE' }),
    reorder: (order: Array<{ id: number; groupId: number | null; sort: number }>) =>
      request<Item[]>('/api/items/reorder', json({ order })),
  },

  settings: {
    get: () => request<Record<string, unknown>>('/api/settings'),
    patch: (patch: Record<string, unknown>) =>
      request<Record<string, unknown>>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
  },

  system: {
    info: () => request<SystemStaticInfo>('/api/system/info'),
    snapshot: () => request<SystemSnapshot>('/api/system/snapshot'),
    history: () => request<SystemSnapshot[]>('/api/system/history'),
    /**
     * 重启面板进程。后端先回 200、随后才关停并拉起新进程，
     * 因此 200 只代表「已受理」，是否真的起来要轮询 /healthz 比对 pid。
     */
    restart: () => request<{ ok: boolean; pid: number }>('/api/system/restart', { method: 'POST' }),
  },

  /** 资源（图标上传 / 壁纸）。后端未实现时调用方回落到 dataURL */
  assets: {
    upload: (file: File, kind: 'icon' | 'wallpaper' | 'favicon' = 'icon') => {
      const form = new FormData()
      form.append('file', file)
      form.append('kind', kind)
      // 刻意不设 content-type：浏览器需要自己加 multipart boundary
      return request<Asset & { url: string }>('/api/assets', { method: 'POST', body: form })
    },
    /** 资源列表（不含二进制）。壁纸项带 bgUrl，可直接用作图片地址 */
    list: (kind?: 'icon' | 'wallpaper' | 'favicon') =>
      request<Asset[]>(`/api/assets${kind ? `?kind=${kind}` : ''}`),
    remove: (id: string) => request<void>(`/api/assets/${id}`, { method: 'DELETE' }),
    url: (id: string) => `/api/assets/${id}`,
  },

  /**
   * 数据迁移：导出 / 导入备份。
   *
   * 导入的 `payload` 是备份文件解析后的原文，结构与校验都在后端
   * （routes/backup.ts 的 BackupSchema），前端只负责选文件与模式。
   */
  backup: {
    export: (opts?: { assets?: boolean }) => exportBackup(opts?.assets === true),
    import: (payload: unknown, mode: BackupImportMode = 'merge') =>
      request<BackupImportResult>(`/api/backup/import?mode=${mode}`, json(payload)),
  },

  /** 服务端抓取 favicon（M4）—— 抓不到就抛错，前端只提示失败 */
  favicon: {
    fetch: (url: string) =>
      request<{ assetId: string; url: string }>('/api/favicon', json({ url })),
  },
}
