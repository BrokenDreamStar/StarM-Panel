/**
 * 展示层数字格式化 —— 集中在一处，保证「首页卡片 / 详情弹窗 / 表格」口径一致。
 *
 * 刻意把两类「看起来一样、语义完全不同」的 0 分开：
 *   - 网络的 0 B/s 是「链路空闲」，要照常显示；
 *   - 磁盘的 readBps / writeBps 来自 /proc/diskstats 累计计数差分，非 Linux
 *     平台恒为 0。这时显示 0 B/s 会被误读成「磁盘没事干」，必须显示 —。
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 字节 → 人类可读。null / NaN → '—'（与「0 字节」区分开） */
export function fmtBytes(n: number | null | undefined, digits = 1): string {
  if (!isNum(n)) return '—'
  if (n === 0) return '0 B'
  const i = Math.min(Math.floor(Math.log(Math.abs(n)) / Math.log(1024)), BYTE_UNITS.length - 1)
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : digits)} ${BYTE_UNITS[i]}`
}

/** `已用/总量`，与参考图口径一致（1.6 GB/3.9 GB） */
export function fmtBytesPair(
  used: number | null | undefined,
  total: number | null | undefined,
  digits = 1,
): string {
  const a = fmtBytes(used, digits)
  const b = fmtBytes(total, digits)
  // 单位相同时只保留一个（"15.9/16.0 GB"），窄卡片里更省宽
  const ai = a.lastIndexOf(' ')
  const bi = b.lastIndexOf(' ')
  if (ai > 0 && bi > 0 && a.slice(ai + 1) === b.slice(bi + 1)) {
    return `${a.slice(0, ai)}/${b.slice(0, bi)} ${a.slice(ai + 1)}`
  }
  return `${a}/${b}`
}

/** 速率（网络）：0 是有意义的「空闲」 */
export function fmtRate(n: number | null | undefined): string {
  if (!isNum(n) || n < 0) return '—'
  return `${fmtBytes(n)}/s`
}

/** 速率（磁盘 IO）：<= 0 视为「该平台不提供」，显示 — */
export function fmtDiskRate(n: number | null | undefined): string {
  if (!isNum(n) || n <= 0) return '—'
  return `${fmtBytes(n)}/s`
}

/** 百分比 */
export function pct(n: number | null | undefined, digits = 1): string {
  if (!isNum(n)) return '—'
  return `${n.toFixed(digits)}%`
}

/** part / total → 0-100；total 非法时返回 null（无意义的比例） */
export function ratioPct(
  part: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (!isNum(part) || !isNum(total) || total <= 0) return null
  return (part / total) * 100
}

/** 进度条宽度：把任意比例夹进 0-100，避免脏数据把条撑破 */
export function clampPct(n: number | null | undefined): number {
  if (!isNum(n)) return 0
  return Math.min(100, Math.max(0, n))
}

export type BarLevel = 'ok' | 'warn' | 'err'

/** 进度条语义色：>= 90% 危险、>= 75% 警告（CPU 高负载 / 磁盘高占用都要变色） */
export function barLevel(ratio: number | null | undefined): BarLevel {
  const v = clampPct(ratio)
  if (v >= 90) return 'err'
  if (v >= 75) return 'warn'
  return 'ok'
}

/** 秒 → 运行时长 */
export function fmtUptime(seconds: number | null | undefined): string {
  if (!isNum(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m} 分`
}

/** CPU 频率：`cpu.speed` 本身就是 GHz */
export function fmtGhz(v: number | null | undefined): string {
  if (!isNum(v) || v <= 0) return '—'
  return `${v.toFixed(2)} GHz`
}

/** GPU 频率：clockCore / clockMemory 是 MHz */
export function fmtMhz(v: number | null | undefined): string {
  if (!isNum(v) || v <= 0) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(2)} GHz` : `${Math.round(v)} MHz`
}
