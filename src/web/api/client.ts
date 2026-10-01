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
  BootstrapPayload,
  Group,
  Item,
  ProbeEntry,
  ProbeStatus,
  SystemSnapshot,
  SystemStaticInfo,
} from '@shared/types'

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
  let message = `请求失败（HTTP ${res.status}）`
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { ...init, headers: buildHeaders(init) })
  } catch (e) {
    // 网络层失败（后端未启动 / 断网）—— 也要抛 ApiError，调用方只需处理一种类型
    throw new ApiError(0, 'NETWORK_ERROR', e instanceof Error ? e.message : String(e))
  }

  if (!res.ok) throw await toApiError(res)
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
// 接口
// ─────────────────────────────────────────────────────────────

export const api = {
  health: () =>
    request<{ status: string; version: string; uptime: number; platform: string }>('/healthz'),

  bootstrap: () => request<BootstrapPayload>('/api/bootstrap'),

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
  },

  /** 内网可达性探测（M2）—— 后端未实现时调用方需优雅降级 */
  probe: {
    status: () => request<ProbeStatus>('/api/probe/status'),
    refresh: () => request<ProbeStatus>('/api/probe/refresh', { method: 'POST' }),
    check: (url: string) => request<ProbeEntry>('/api/probe/check', json({ url })),
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
    remove: (id: string) => request<void>(`/api/assets/${id}`, { method: 'DELETE' }),
    url: (id: string) => `/api/assets/${id}`,
  },

  /** 服务端抓取 favicon（M4）—— 未实现时前端回落 DuckDuckGo 占位 */
  favicon: {
    fetch: (url: string) =>
      request<{ assetId: string; url: string }>('/api/favicon', json({ url })),
  },
}
