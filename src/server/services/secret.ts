/**
 * 应用密钥（`data/secret.key`）—— 会话 Cookie 的签名密钥。
 *
 * 设计要点（见 docs/DESIGN.md §8.10）：
 *   - 首次使用时生成 32 随机字节，以 base64 存单行文本，权限 0600。
 *   - 与数据库分离存放：`app.db` 可以被随手拷走/分享，密钥文件不应该跟着走。
 *   - **密钥一旦轮换，所有已登录会话立即失效**（不是安全事件，只是要重新登录），
 *     因此文件损坏时重建是安全的降级选择，但必须打日志说明原因。
 *   - 不放进 settings 表：那张表会被导出到备份 JSON 里（routes/backup.ts），
 *     把签名密钥写进可分享的备份文件是明确的错误。
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig } from '../env'

/** 密钥长度下限（字节）。短于此长度视为文件损坏，拒绝使用 */
const MIN_KEY_BYTES = 32

export const SECRET_PATH = join(getConfig().dataDir, 'secret.key')

let cached: Buffer | null = null

function readExisting(path: string): Buffer | null {
  const raw = readFileSync(path, 'utf8').trim()
  if (!raw) return null
  // 优先按 base64 解析；解析不出来时退回「文件本身就是原始字节」的形态，
  // 这样手工用 `head -c 32 /dev/urandom > secret.key` 生成的密钥也能用。
  const decoded = Buffer.from(raw, 'base64')
  if (decoded.length >= MIN_KEY_BYTES) return decoded
  const plain = Buffer.from(raw, 'utf8')
  if (plain.length >= MIN_KEY_BYTES) return plain
  return null
}

function create(): Buffer {
  const key = randomBytes(32)
  // mode 只在新文件上生效，且会被 umask 削；随后显式 chmod 保证 0600
  writeFileSync(SECRET_PATH, `${key.toString('base64')}\n`, { mode: 0o600 })
  try {
    chmodSync(SECRET_PATH, 0o600)
  } catch {
    // Windows 等平台不支持 POSIX 权限位 —— 不是致命问题，忽略
  }
  return key
}

/** 取会话签名密钥（进程内单例，惰性创建文件） */
export function getSecret(): Buffer {
  if (cached) return cached

  if (existsSync(SECRET_PATH)) {
    const existing = readExisting(SECRET_PATH)
    if (existing) {
      cached = existing
      return cached
    }
    console.warn(
      `[auth] 密钥文件内容不可用，已重新生成：${SECRET_PATH}\n` +
        '       所有已登录会话将失效，需要用管理员密码重新登录。',
    )
  }

  cached = create()
  return cached
}

/** 仅供测试：丢弃进程内缓存（改文件后重新读取） */
export function resetSecretCache(): void {
  cached = null
}
