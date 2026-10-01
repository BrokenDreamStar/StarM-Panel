/**
 * Linux /proc/diskstats 解析 —— 用于按设备计算真实磁盘 IO 速率。
 *
 * systeminformation 的 si.disksIO() 只提供系统级聚合值，
 * 无法按挂载点拆分。这里直接读 /proc/diskstats（字段含义见内核文档
 * Documentation/admin-guide/iostats.rst）自行差分。
 *
 * 非 Linux 平台返回空 Map，调用方据此让速率保持 0。
 */
import { readFile } from 'node:fs/promises'

export interface DiskCounters {
  readBytes: number
  writeBytes: number
}

/** 每个扇区固定 512 字节（内核 iostats 的约定，与设备实际扇区大小无关） */
const SECTOR_BYTES = 512

/**
 * 读取所有块设备（含分区）的累计读写字节数。
 * 返回的 key 是内核设备名，例如 `sda`、`sda1`、`nvme0n1p2`。
 */
export async function readDiskCounters(): Promise<Map<string, DiskCounters>> {
  const out = new Map<string, DiskCounters>()
  if (process.platform !== 'linux') return out

  let text: string
  try {
    text = await readFile('/proc/diskstats', 'utf8')
  } catch {
    return out
  }

  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    // 最少需要到 sectors_written（索引 9）
    if (f.length < 10) continue

    const name = f[2]
    if (!name) continue

    // 跳过 ram/loop 等虚拟设备
    if (/^(ram|loop|fd|sr|dm-|md)/.test(name)) continue

    const sectorsRead = Number(f[5])
    const sectorsWritten = Number(f[9])
    if (!Number.isFinite(sectorsRead) || !Number.isFinite(sectorsWritten)) continue

    out.set(name, {
      readBytes: sectorsRead * SECTOR_BYTES,
      writeBytes: sectorsWritten * SECTOR_BYTES,
    })
  }

  return out
}

/**
 * 从 fsSize 的 `fs` 字段（如 `/dev/sda1`）推导出 diskstats 里的设备名。
 * 依次尝试：完整设备名 → 去掉 /dev/ 前缀 → 父设备（去掉分区后缀）。
 */
export function lookupDiskCounters(
  counters: Map<string, DiskCounters>,
  fs: string,
): DiskCounters | undefined {
  if (!fs.startsWith('/dev/')) return undefined

  const dev = fs.slice('/dev/'.length)

  const direct = counters.get(dev)
  if (direct) return direct

  // /dev/mapper/vg-lv → dm-0 无法直接映射，跳过
  if (dev.includes('/')) return undefined

  // 分区 → 父设备：sda1 → sda，nvme0n1p2 → nvme0n1，mmcblk0p1 → mmcblk0
  const parent = dev
    .replace(/p\d+$/, '')
    .replace(/\d+$/, '')
  if (parent && parent !== dev) return counters.get(parent)

  return undefined
}
