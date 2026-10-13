/**
 * macOS GPU 动态指标采集。
 *
 * 背景（见 docs/DESIGN.md §7.3）：`systeminformation` 在 macOS 上只给静态信息
 * （vendor / model / vramDynamic），`utilizationGpu`、`memoryUsed` 等动态字段
 * 一律缺失，于是面板里 GPU 卡片永远只显示型号。实际上 macOS 的 IOAccelerator
 * 驱动在 IORegistry 里就暴露了 `PerformanceStatistics`：
 *
 *   "PerformanceStatistics" = {
 *     "Device Utilization %"=20, "Renderer Utilization %"=19, "Tiler Utilization %"=20,
 *     "In use system memory"=569737216, "Alloc system memory"=6172655616, ...
 *   }
 *
 * Apple Silicon（AGXAccelerator*）与 Intel / AMD 核显独显都走同一套键名，
 * 少量老驱动用 `GPU Activity(%)` / `vramUsedBytes` 这类别名，这里都做兼容。
 * `ioreg` 是系统自带命令、约 30ms，GPU 采样间隔 3s，开销可忽略。
 */
import { existsSync } from 'node:fs'

/** ioreg 的绝对路径 —— 面板进程的 PATH 未必含 /usr/sbin */
const IOREG_BIN = '/usr/sbin/ioreg'

/** 单块 GPU 的动态指标（缺失即 null） */
export interface MacGpuStat {
  /** IORegistry 里的 "model"，用于与 si.graphics() 的控制器对齐 */
  model: string | null
  /** 0-100 (%) */
  utilization: number | null
  /** bytes */
  memoryUsed: number | null
  /** bytes，Apple Silicon 为统一内存，通常没有固定上限 */
  memoryTotal: number | null
}

/** 使用率键名：按优先级排列（Device 是 Activity Monitor 展示的那个） */
const UTILIZATION_KEYS = [
  'Device Utilization %',
  'GPU Activity(%)',
  'GPU Activity %',
  'Renderer Utilization %',
  'Tiler Utilization %',
] as const

const MEMORY_USED_KEYS = [
  'In use system memory',
  'In use system memory (driver)',
  'vramUsedBytes',
  'vramUsed',
] as const

const MEMORY_TOTAL_KEYS = ['vramTotalBytes', 'vramTotal'] as const

function firstNumber(
  stats: Record<string, number>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = stats[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/**
 * 解析 `"PerformanceStatistics" = { k=v, ... }` 的内容。
 * 键可能带引号、空格、`%`、括号；值都是十进制数字。
 */
function parsePerformanceStatistics(body: string): Record<string, number> {
  const out: Record<string, number> = {}
  const re = /"?([^"=,{}]+?)"?\s*=\s*"?(-?\d+(?:\.\d+)?)"?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const key = m[1]?.trim()
    const value = Number(m[2])
    if (key && Number.isFinite(value)) out[key] = value
  }
  return out
}

/**
 * 从 `ioreg -r -d 1 -w 0 -c IOAccelerator` 的文本输出里提取每块 GPU 的动态指标。
 *
 * `-d 1` 保证每个匹配到的 IOAccelerator 服务各占一个 `+-o` 块，按出现顺序排列，
 * 与 `si.graphics()` 的 controllers 顺序一致。
 */
export function parseIoregGpuStats(output: string): MacGpuStat[] {
  const stats: MacGpuStat[] = []
  // 用「行首的 +-o」切块；-d 1 下不会有嵌套块
  for (const block of output.split(/^(?=\s*\+-o\s)/m)) {
    const perfAt = block.indexOf('"PerformanceStatistics" = {')
    if (perfAt < 0) continue
    const open = block.indexOf('{', perfAt)
    const close = block.indexOf('}', open)
    if (open < 0 || close < 0) continue

    const ps = parsePerformanceStatistics(block.slice(open + 1, close))
    const model = /"model"\s*=\s*"([^"]*)"/.exec(block)?.[1] ?? null

    stats.push({
      model: model || null,
      utilization: firstNumber(ps, UTILIZATION_KEYS),
      memoryUsed: firstNumber(ps, MEMORY_USED_KEYS),
      memoryTotal: firstNumber(ps, MEMORY_TOTAL_KEYS),
    })
  }
  return stats
}

/**
 * 读取本机所有 GPU 的动态指标。
 * 非 macOS、ioreg 缺失或执行失败时返回空数组（调用方静默降级为纯静态信息）。
 */
export function readMacGpuStats(): MacGpuStat[] {
  if (process.platform !== 'darwin') return []
  if (!existsSync(IOREG_BIN)) return []

  try {
    const proc = Bun.spawnSync([IOREG_BIN, '-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (proc.exitCode !== 0) return []
    return parseIoregGpuStats(proc.stdout.toString())
  } catch {
    return []
  }
}
