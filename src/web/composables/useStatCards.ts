/**
 * 首页「系统状态」区的卡片清单。
 *
 * 只负责「有哪些卡片、什么顺序」，不做任何渲染与取数（渲染见 SystemStatCard）。
 * 全部由设置驱动：
 *   - `monitor.cards` 决定展示哪些卡片，数组顺序即展示顺序
 *   - **卡片按设备添加**：disk（挂载点）、network（网卡）、gpu（设备序号）
 *     各是一张独立卡片；「自动」条目按当前检测到的全部设备展开
 *
 * 增删与排序都通过设置 store 的 PATCH 写回 `monitor.cards`：交互对齐 App 卡片
 * 的「在首页直接新建 / 移除」。换算逻辑在 utils/stat-cards.ts（纯函数、有单测）。
 */
import { computed } from 'vue'
import { useMonitorStore } from '@/stores/monitor'
import { useSettingsStore } from '@/stores/settings'
import {
  cardEntryId,
  readMonitorCards,
  type MonitorCardEntry,
  type MonitorCardKind,
} from '@/api/settings'
import {
  expandCards,
  listCandidates,
  moveCard as moveCardEntries,
  removeCard as removeCardEntries,
  sameCardEntries,
  type DeviceSlot,
  type StatCardRef,
} from '@/utils/stat-cards'

export type { StatCardRef, DeviceSlot } from '@/utils/stat-cards'

/** 每类卡片的文案与图标（disk / network / gpu 的标签用设备标识覆盖） */
export const STAT_CARD_META: Record<
  MonitorCardKind,
  {
    /** 卡片左侧的短标签（无设备时兜底） */
    label: string
    /** 详情弹窗 / aria 用的名称 */
    title: string
    /** 「添加卡片」选择器里的名称 */
    name: string
    /** 「添加卡片」选择器里的一句说明 */
    hint: string
    icon: string
  }
> = {
  cpu: {
    label: 'CPU',
    title: 'CPU',
    name: 'CPU 使用率',
    hint: '总使用率与每核心明细',
    icon: 'cpu',
  },
  memory: {
    label: 'RAM',
    title: '内存',
    name: '内存',
    hint: '已用 / 总量与交换分区',
    icon: 'memory',
  },
  disk: {
    label: '/',
    title: '磁盘',
    name: '磁盘',
    hint: '已用 / 总量与读写速率',
    icon: 'drive',
  },
  network: {
    label: 'NET',
    title: '网络',
    name: '网络',
    hint: '该网卡的上下行速率',
    icon: 'wifi',
  },
  gpu: {
    label: 'GPU',
    title: 'GPU',
    name: 'GPU',
    hint: '使用率与显存',
    icon: 'gpu',
  },
  system: {
    label: 'SYS',
    title: '系统',
    name: '系统信息',
    hint: '运行时长、主机与内核版本',
    icon: 'server',
  },
}

/** 卡片 / 候选的展示名：设备类带上设备标识，整机类用类型名 */
export function cardDisplayName(kind: MonitorCardKind, device?: string): string {
  if (device === undefined) return STAT_CARD_META[kind].name
  switch (kind) {
    case 'disk':
      return `磁盘 ${device}`
    case 'network':
      return `网卡 ${device}`
    case 'gpu':
      return `GPU #${device}`
    default:
      return `${STAT_CARD_META[kind].name} ${device}`
  }
}

/** 「添加卡片」的一个候选：一台具体设备（或一个整机类型） */
export interface CardCandidate {
  kind: MonitorCardKind
  device?: string
  id: string
  name: string
  hint: string
  icon: string
}

function dedupe(list: readonly string[]): string[] {
  return [...new Set(list)]
}

export function useStatCards() {
  const settings = useSettingsStore()
  const monitor = useMonitorStore()

  /** 已落库的卡片条目（顺序即展示顺序） */
  const entries = computed<MonitorCardEntry[]>(() => readMonitorCards(settings.raw))

  // ── 设备清单 ────────────────────────────────────────────────
  // 动态快照优先，首帧未到时回落到 /api/system/info，否则刷新页面会有一瞬间
  // 「设备卡不存在」的跳变。

  /** 全部挂载点 —— 供「自动」展开与候选使用 */
  const mounts = computed<string[]>(() => {
    const fromSnapshot = (monitor.latest?.disks ?? []).map((d) => d.mount)
    const fromStatic = (monitor.staticInfo?.disks ?? []).map((d) => d.mount)
    return dedupe([...fromSnapshot, ...fromStatic])
  })

  /** 全部网卡 */
  const ifaces = computed<string[]>(() => {
    const fromSnapshot = (monitor.latest?.net ?? []).map((n) => n.iface)
    const fromStatic = (monitor.staticInfo?.net ?? []).map((n) => n.iface)
    return dedupe([...fromSnapshot, ...fromStatic])
  })

  /** 全部 GPU 设备（设备序号 + 型号），按序号升序 */
  const gpuSlots = computed<DeviceSlot[]>(() => {
    const models = new Map<number, string>()
    for (const g of [...(monitor.latest?.gpus ?? []), ...(monitor.staticInfo?.gpus ?? [])]) {
      if (!models.has(g.index)) models.set(g.index, g.model)
    }
    return [...models.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, model]) => ({ device: String(index), hint: model }))
  })

  /** 某类卡片当前可选的设备；返回新数组以便 Vue 追踪 */
  function slots(kind: MonitorCardKind): readonly DeviceSlot[] {
    switch (kind) {
      case 'disk':
        return mounts.value.map((m) => ({ device: m, hint: '该挂载点的容量与读写速率' }))
      case 'network':
        return ifaces.value.map((i) => ({ device: i, hint: '该网卡的上行 / 下行速率' }))
      case 'gpu':
        return gpuSlots.value
      default:
        return []
    }
  }

  /**
   * 该设备当前是否仍然存在 —— 设备消失后显式卡片不再渲染。
   * GPU 无动态指标时回落到静态信息。
   */
  function deviceExists(kind: MonitorCardKind, device: string): boolean {
    switch (kind) {
      case 'disk':
        return [...(monitor.latest?.disks ?? []), ...(monitor.staticInfo?.disks ?? [])].some(
          (d) => d.mount === device,
        )
      case 'network':
        return [...(monitor.latest?.net ?? []), ...(monitor.staticInfo?.net ?? [])].some(
          (n) => n.iface === device,
        )
      case 'gpu':
        return [...(monitor.latest?.gpus ?? []), ...(monitor.staticInfo?.gpus ?? [])].some(
          (g) => String(g.index) === device,
        )
      default:
        return false
    }
  }

  /** 实际渲染的卡片：设备类按设备展开，不存在的设备跳过 */
  const cards = computed<StatCardRef[]>(() =>
    expandCards(entries.value, slots, deviceExists),
  )

  /** 「添加卡片」的候选：设备类逐台列出，已展示的不再出现 */
  const candidates = computed<CardCandidate[]>(() =>
    listCandidates(entries.value, slots).map((entry) => ({
      ...entry,
      id: cardEntryId(entry),
      name: cardDisplayName(entry.kind, entry.device),
      hint:
        entry.device === undefined
          ? STAT_CARD_META[entry.kind].hint
          : (slots(entry.kind).find((s) => s.device === entry.device)?.hint ??
            STAT_CARD_META[entry.kind].hint),
      icon: STAT_CARD_META[entry.kind].icon,
    })),
  )

  function write(next: MonitorCardEntry[]): Promise<boolean> {
    return settings.patch({ 'monitor.cards': next })
  }

  /** 追加一张卡片（已存在则原样返回） */
  function addCard(kind: MonitorCardKind, device?: string): Promise<boolean> {
    const entry: MonitorCardEntry = device === undefined ? { kind } : { kind, device }
    const id = cardEntryId(entry)
    if (entries.value.some((e) => cardEntryId(e) === id)) return Promise.resolve(true)
    return write([...entries.value, entry])
  }

  /** 移除一张卡片（按设备粒度；自动条目会先物化成具体设备） */
  function removeCard(card: StatCardRef): Promise<boolean> {
    const next = removeCardEntries(entries.value, card, slots)
    if (sameCardEntries(next, entries.value)) return Promise.resolve(true)
    return write(next)
  }

  /** 把 source 这张卡移动到 target 的位置（按设备粒度，自动条目会先物化） */
  function moveCard(source: StatCardRef, target: StatCardRef): Promise<boolean> {
    const next = moveCardEntries(entries.value, source, target, slots)
    if (sameCardEntries(next, entries.value)) return Promise.resolve(true)
    return write(next)
  }

  return {
    cards,
    candidates,
    entries,
    mounts,
    gpuSlots,
    addCard,
    removeCard,
    moveCard,
  }
}
