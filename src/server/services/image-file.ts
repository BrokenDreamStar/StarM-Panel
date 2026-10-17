/**
 * 图片文件的 ETag 与响应头（`/bg/<名>` 与 `/api/local-image` 共用）。
 *
 * ETag 里必须带**内容头部哈希**，不能只用「大小 + mtime」：
 *   - 同名换图很常见，而换上去的图大小常常一模一样；
 *   - mtime 在部分文件系统上只有 1 秒精度，同一秒内替换会被误判成「没变」，
 *     浏览器就会一直显示旧图。
 * 取前 16KB 求哈希：足以区分「换了另一张图」，代价只是一次很小的读。
 */

/** 参与 ETag 哈希的头部字节数 */
export const HEAD_BYTES = 16 * 1024

export function imageEtag(head: Uint8Array, size: number, mtimeMs: number): string {
  const digest = new Bun.CryptoHasher('sha256').update(head).digest('hex').slice(0, 16)
  return `"${size}-${Math.round(mtimeMs)}-${digest}"`
}

/** 图片响应的公共头：`no-cache` + ETag；SVG 额外加 CSP（防内嵌脚本执行） */
export function imageHeaders(mime: string, etag: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': mime,
    // 文件名不是内容哈希，文件随时可能被换掉 —— 只能协商缓存
    'cache-control': 'no-cache',
    etag,
  }
  if (mime === 'image/svg+xml') {
    headers['content-security-policy'] =
      "default-src 'none'; style-src 'unsafe-inline'; sandbox"
  }
  return headers
}
