/**
 * 首页「系统状态」区的卡片清单。
 *
 * 只负责「有哪些卡片、什么顺序」，不做任何渲染与取数（渲染见 SystemStatCard）。
 * 全部由设置驱动：
 *   - `monitor.cards` 决定展示哪些卡片，数组顺序即展示顺序
 *   - `disk` 按挂载点展开成多张（`monitor.disks` 为空 = 全部挂载点）
 *   - `gpu` 在「静态信息与快照都没有 GPU」时整卡跳过（不留一张空卡）
 */
import { computed } from 'vue'
import { useMonitorStore } from '@/stores/monitor'
import { useSettingsStore } from '@/stores/settings'
import { readMonitorCards, type MonitorCardKind } from '@/api/settings'

export interface StatCardRef {
  kind: MonitorCardKind
  /** 仅 disk 卡：该卡对应的挂载点 */
  mount?: string
}

/** 每类卡片的默认文案与图标（disk 的标签用挂载点覆盖） */
export const STAT_CARD_META: Record<MonitorCardKind, { label: string; title: string; icon: string }> =
  {
    cpu: { label: 'CPU', title: 'CPU', icon: 'cpu' },
    memory: { label: 'RAM', title: '内存', icon: 'memory' },
    disk: { label: '/', title: '磁盘', icon: 'drive' },
    network: { label: 'NET', title: '网络', icon: 'wifi' },
    gpu: { label: 'GPU', title: 'GPU', icon: 'gpu' },
    system: { label: 'SYS', title: '系统', icon: 'server' },
  }

export function useStatCards() {
  const settings = useSettingsStore()
  const monitor = useMonitorStore()

  /**
   * 磁盘挂载点：动态快照优先，首帧未到时回落到 /api/system/info，
   * 否则刷新页面后会有一瞬间「磁盘卡不存在」的跳变。
   */
  const mounts = computed<string[]>(() => {
    const whitelist = settings.monitorDisks
    const fromSnapshot = monitor.disksFiltered(whitelist).map((d) => d.mount)
    const fromStatic = (monitor.staticInfo?.disks ?? [])
      .map((d) => d.mount)
      .filter((m) => whitelist.length === 0 || whitelist.includes(m))
    return [...new Set([...fromSnapshot, ...fromStatic])]
  })

  const hasGpu = computed(
    () => (monitor.staticInfo?.gpus.length ?? 0) > 0 || (monitor.latest?.gpus.length ?? 0) > 0,
  )

  const cards = computed<StatCardRef[]>(() => {
    const out: StatCardRef[] = []
    for (const kind of readMonitorCards(settings.raw)) {
      if (kind === 'gpu' && !hasGpu.value) continue
      if (kind === 'disk') {
        for (const mount of mounts.value) out.push({ kind, mount })
        continue
      }
      out.push({ kind })
    }
    return out
  })

  return { cards, mounts, hasGpu }
}
