/**
 * 「系统状态」卡片清单的**纯逻辑** —— 从 useStatCards 抽出，便于单测。
 *
 * 数据模型（见 api/settings.ts 的 MonitorCardEntry）：
 *   - `monitor.cards` 是「条目」数组，顺序即展示顺序；
 *   - 显式条目 `{ kind, device }` = 一台具体设备一张卡；
 *   - 「自动」条目 `{ kind }`（旧值 / 默认值）= 按当前设备展开成多张，已被
 *     显式条目占用的设备自动跳过（避免同一设备出现两张卡）。
 *
 * 这里只做「条目 ↔ 卡片」的换算与增删改，不碰 Vue，也不碰设置 IO。
 */
import {
  MONITOR_CARD_KINDS,
  cardEntryId,
  isDeviceCardKind,
  type MonitorCardEntry,
  type MonitorCardKind,
} from '@/api/settings'

/** 某类卡片可选的一台设备（device = 设备标识，hint = 选择器里的说明） */
export interface DeviceSlot {
  device: string
  hint: string
}

/** 按类别返回当前可用设备；整机唯一的类别返回空数组 */
export type SlotProvider = (kind: MonitorCardKind) => readonly DeviceSlot[]

/** 实际渲染的一张卡：device 已定，「自动」条目展开出来的标记 auto=true */
export interface StatCardRef {
  kind: MonitorCardKind
  device?: string
  auto?: boolean
  /** 稳定标识（kind + device），用于 v-for key 与拖拽 */
  id: string
}

/** 该设备当前是否仍然存在 —— 决定一张显式卡片还要不要渲染 */
export type DeviceExists = (kind: MonitorCardKind, device: string) => boolean

/** 把条目展开成实际渲染的卡片 */
export function expandCards(
  entries: readonly MonitorCardEntry[],
  slots: SlotProvider,
  exists: DeviceExists,
): StatCardRef[] {
  // 显式条目占用的设备：自动条目不得重复展开
  const claimed = new Set<string>()
  for (const e of entries) {
    if (e.device !== undefined) claimed.add(cardEntryId(e))
  }

  const out: StatCardRef[] = []
  for (const e of entries) {
    if (!isDeviceCardKind(e.kind)) {
      out.push({ kind: e.kind, id: cardEntryId(e) })
      continue
    }
    if (e.device !== undefined) {
      if (exists(e.kind, e.device)) {
        out.push({ kind: e.kind, device: e.device, id: cardEntryId(e) })
      }
      continue
    }
    for (const slot of slots(e.kind)) {
      const id = cardEntryId({ kind: e.kind, device: slot.device })
      if (claimed.has(id)) continue
      out.push({ kind: e.kind, device: slot.device, auto: true, id })
    }
  }
  return out
}

/**
 * 「添加卡片」的候选：设备类逐台列出，整机类只列一次。
 * 已经展示的设备（显式条目，或被「自动」条目覆盖）不再出现在候选里。
 */
export function listCandidates(
  entries: readonly MonitorCardEntry[],
  slots: SlotProvider,
): MonitorCardEntry[] {
  const present = new Set(entries.map(cardEntryId))
  const autoKinds = new Set(entries.filter((e) => e.device === undefined).map((e) => e.kind))

  const out: MonitorCardEntry[] = []
  for (const kind of MONITOR_CARD_KINDS) {
    if (isDeviceCardKind(kind)) {
      if (autoKinds.has(kind)) continue
      for (const slot of slots(kind)) {
        const entry: MonitorCardEntry = { kind, device: slot.device }
        if (!present.has(cardEntryId(entry))) out.push(entry)
      }
      continue
    }
    const entry: MonitorCardEntry = { kind }
    if (!present.has(cardEntryId(entry))) out.push(entry)
  }
  return out
}

/**
 * 把指定类别的「自动」条目物化成显式设备条目 —— 只在用户动过某个类别后调用。
 * 已被显式条目占用的设备仍然跳过，不会产生重复。
 */
export function materializeKinds(
  entries: readonly MonitorCardEntry[],
  kinds: ReadonlySet<MonitorCardKind>,
  slots: SlotProvider,
): MonitorCardEntry[] {
  const claimed = new Set(
    entries.filter((e) => e.device !== undefined).map((e) => cardEntryId(e)),
  )
  const out: MonitorCardEntry[] = []
  const seen = new Set<string>()

  const push = (entry: MonitorCardEntry): void => {
    const id = cardEntryId(entry)
    if (seen.has(id)) return
    seen.add(id)
    out.push(entry)
  }

  for (const e of entries) {
    if (kinds.has(e.kind) && isDeviceCardKind(e.kind) && e.device === undefined) {
      for (const slot of slots(e.kind)) {
        const entry: MonitorCardEntry = { kind: e.kind, device: slot.device }
        if (claimed.has(cardEntryId(entry))) continue
        push(entry)
      }
      continue
    }
    push(e)
  }
  return out
}

/** 移除一张卡：显式条目直接删；自动展开出来的先物化再删这一台设备 */
export function removeCard(
  entries: readonly MonitorCardEntry[],
  card: StatCardRef,
  slots: SlotProvider,
): MonitorCardEntry[] {
  if (!card.auto) return entries.filter((e) => cardEntryId(e) !== card.id)
  // 该设备已被显式条目占用时，这张「自动」卡本就不该存在，视为无操作
  if (entries.some((e) => e.device !== undefined && cardEntryId(e) === card.id)) {
    return [...entries]
  }
  const base = materializeKinds(entries, new Set([card.kind]), slots)
  return base.filter((e) => cardEntryId(e) !== card.id)
}

/** 把 source 这张卡移动到 target 所在位置（按设备粒度，自动条目先物化） */
export function moveCard(
  entries: readonly MonitorCardEntry[],
  source: StatCardRef,
  target: StatCardRef,
  slots: SlotProvider,
): MonitorCardEntry[] {
  if (source.id === target.id) return [...entries]
  const kinds = new Set<MonitorCardKind>()
  if (isDeviceCardKind(source.kind)) kinds.add(source.kind)
  if (isDeviceCardKind(target.kind)) kinds.add(target.kind)

  const list = materializeKinds(entries, kinds, slots)
  const from = list.findIndex((e) => cardEntryId(e) === source.id)
  const to = list.findIndex((e) => cardEntryId(e) === target.id)
  if (from < 0 || to < 0 || from === to) return [...entries]

  const next = [...list]
  const [moved] = next.splice(from, 1)
  if (!moved) return [...entries]
  next.splice(to, 0, moved)
  return next
}

/** 比较两份条目是否完全一致（避免无谓的 PATCH） */
export function sameCardEntries(
  a: readonly MonitorCardEntry[],
  b: readonly MonitorCardEntry[],
): boolean {
  if (a.length !== b.length) return false
  return a.every((e, i) => cardEntryId(e) === cardEntryId(b[i]!))
}
