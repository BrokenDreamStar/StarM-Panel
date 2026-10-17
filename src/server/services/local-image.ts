/**
 * 本地图片路径解析（纯函数，不碰数据库，便于脱库单测）。
 *
 * 壁纸允许直接指向本机的一张图 —— `/Users/me/Pictures/x.jpg`、`~/Pictures/x.jpg`、
 * `file:///Users/me/Pictures/x.jpg` 都认，由服务端读盘返回（见 routes/local-image.ts）。
 * 这里只负责「这个值是不是本地路径、对应哪个绝对路径」。
 */
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, resolve } from 'node:path'

/** 展开开头的 `~`（只认 `~` 与 `~/…`，不处理 ~user） */
export function expandHome(raw: string): string {
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

/**
 * 把用户填的值解析成本机绝对路径；不是本地路径时返回 null。
 *
 * 判定规则：`file://` URL，或 `/` 开头的绝对路径（`//cdn/…` 这种协议相对地址
 * 除外）。其余（`http(s)://`、`data:`、`bg/x.jpg` 等）一律返回 null —— 那些交给
 * 浏览器按 URL 处理。
 */
export function localImagePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null

  let value = raw.trim()
  if (value === '') return null

  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(new URL(value).pathname)
    } catch {
      return null
    }
  } else if (value === '~' || value.startsWith('~/')) {
    value = expandHome(value)
  } else if (!value.startsWith('/') || value.startsWith('//')) {
    return null
  }

  const expanded = expandHome(value)
  if (!isAbsolute(expanded)) return null
  return normalize(resolve(expanded))
}
