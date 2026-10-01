/**
 * 数据库行 → API 实体的映射。
 *
 * 集中在这里，避免 items / groups / bootstrap 三处各写一份而逐渐跑偏。
 */
import type { GroupRow, ItemRow } from './schema'
import type { Group, IconType, Item, NetworkPref } from '@shared/types'

export function toGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    sort: row.sort,
    collapsed: row.collapsed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    groupId: row.groupId,
    title: row.title,
    subtitle: row.subtitle,
    // 以下三个字段在 DB 中是自由文本，写入时已由 Zod 限定取值范围。
    // 这里做一次窄化，读出脏数据时不至于让类型系统失真。
    iconType: row.iconType as IconType,
    iconValue: row.iconValue,
    iconColor: row.iconColor,
    bgColor: row.bgColor,
    lanUrl: row.lanUrl,
    wanUrl: row.wanUrl,
    networkPref: row.networkPref as NetworkPref,
    sort: row.sort,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
