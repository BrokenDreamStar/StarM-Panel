/**
 * 卡片与分组 store —— 后端数据的唯一前端副本。
 *
 * 约定：
 *   - bootstrap 一次性填充（首屏只发一个请求）
 *   - 所有写操作走「服务端返回值为准」，不用本地拼装的对象覆盖
 *   - 分组顺序 / 卡片顺序始终按 sort 排序，渲染层不需要再排
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api, type GroupInput, type ItemInput } from '@/api/client'
import type { Group, Item } from '@shared/types'

function bySort<T extends { sort: number; id: number }>(a: T, b: T): number {
  return a.sort - b.sort || a.id - b.id
}

export const useItemsStore = defineStore('items', () => {
  const groups = ref<Group[]>([])
  const items = ref<Item[]>([])
  const version = ref('')
  const loading = ref(false)
  const error = ref<string | null>(null)
  const hydrated = ref(false)

  /** 正在进行的写操作数量：用于禁用按钮 / 显示 loading */
  const pending = ref(0)

  const busy = computed(() => pending.value > 0)

  const sortedGroups = computed(() => [...groups.value].sort(bySort))
  const sortedItems = computed(() => [...items.value].sort(bySort))

  /** 已启用卡片（bootstrap 只返回 enabled=true，这里防御性过滤） */
  const enabledItems = computed(() => sortedItems.value.filter((i) => i.enabled))

  /** 未分组卡片 */
  const ungroupedItems = computed(() => enabledItems.value.filter((i) => i.groupId === null))

  function itemsOfGroup(groupId: number): Item[] {
    return enabledItems.value.filter((i) => i.groupId === groupId)
  }

  function groupById(id: number | null): Group | null {
    if (id === null) return null
    return groups.value.find((g) => g.id === id) ?? null
  }

  function hydrate(payload: {
    groups: Group[]
    items: Item[]
    version?: string
  }): void {
    groups.value = [...payload.groups].sort(bySort)
    items.value = [...payload.items].sort(bySort)
    if (payload.version !== undefined) version.value = payload.version
    hydrated.value = true
    error.value = null
  }

  /** 包一层：统一 pending 计数与错误捕获 */
  async function run<T>(fn: () => Promise<T>): Promise<T> {
    pending.value += 1
    try {
      const result = await fn()
      error.value = null
      return result
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      pending.value -= 1
    }
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      const [g, i] = await Promise.all([api.groups.list(), api.items.list()])
      hydrate({ groups: g, items: i })
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  // ── 卡片 ────────────────────────────────────────────────────

  async function createItem(body: ItemInput & { title: string }): Promise<Item> {
    const created = await run(() => api.items.create(body))
    items.value = [...items.value, created]
    return created
  }

  async function updateItem(id: number, body: ItemInput): Promise<Item> {
    const updated = await run(() => api.items.update(id, body))
    items.value = items.value.map((i) => (i.id === id ? updated : i))
    return updated
  }

  async function removeItem(id: number): Promise<void> {
    await run(() => api.items.remove(id))
    items.value = items.value.filter((i) => i.id !== id)
  }

  /** 拖拽/移动卡片：一次提交完整顺序（后端要求全量 order） */
  async function reorderItems(
    order: Array<{ id: number; groupId: number | null; sort: number }>,
  ): Promise<void> {
    const next = await run(() => api.items.reorder(order))
    items.value = [...next].sort(bySort)
  }

  // ── 分组 ────────────────────────────────────────────────────

  async function createGroup(body: GroupInput & { name: string }): Promise<Group> {
    const created = await run(() => api.groups.create(body))
    groups.value = [...groups.value, created].sort(bySort)
    return created
  }

  async function updateGroup(id: number, body: GroupInput): Promise<Group> {
    const updated = await run(() => api.groups.update(id, body))
    groups.value = groups.value.map((g) => (g.id === id ? updated : g))
    return updated
  }

  /** 删除分组：组内卡片 groupId 变为 null（后端行为），前端同步镜像 */
  async function removeGroup(id: number): Promise<void> {
    await run(() => api.groups.remove(id))
    groups.value = groups.value.filter((g) => g.id !== id)
    items.value = items.value.map((i) => (i.groupId === id ? { ...i, groupId: null } : i))
  }

  /** 折叠状态就地切换（乐观更新，失败静默回滚该字段） */
  async function toggleGroupCollapsed(id: number): Promise<void> {
    const target = groups.value.find((g) => g.id === id)
    if (!target) return
    const next = !target.collapsed
    groups.value = groups.value.map((g) => (g.id === id ? { ...g, collapsed: next } : g))
    try {
      const updated = await api.groups.update(id, { collapsed: next })
      groups.value = groups.value.map((g) => (g.id === id ? updated : g))
    } catch (e) {
      groups.value = groups.value.map((g) =>
        g.id === id ? { ...g, collapsed: !next } : g,
      )
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  return {
    groups,
    items,
    version,
    loading,
    error,
    hydrated,
    pending,
    busy,
    sortedGroups,
    sortedItems,
    enabledItems,
    ungroupedItems,
    itemsOfGroup,
    groupById,
    hydrate,
    load,
    createItem,
    updateItem,
    removeItem,
    reorderItems,
    createGroup,
    updateGroup,
    removeGroup,
    toggleGroupCollapsed,
  }
})
