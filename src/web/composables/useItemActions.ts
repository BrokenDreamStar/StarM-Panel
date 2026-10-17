/**
 * 卡片行为（打开 / 复制 / 删除）—— 由桌面页与卡片菜单共用。
 *
 * 打开方式是**全局设置**（ui.openMode），不是卡片字段：同一个面板里的
 * 卡片统一按同一种方式打开。
 */
import { useMessage } from 'naive-ui'
import { useItemsStore } from '@/stores/items'
import { useNetworkStore } from '@/stores/network'
import { useSettingsStore } from '@/stores/settings'
import { useDeleteConfirm } from './useDeleteConfirm'
import { TEXT as T } from '@shared/text'
import type { Item } from '@shared/types'

export interface OpenResult {
  ok: boolean
  reason?: string
  url?: string | null
}

export function useItemActions() {
  const items = useItemsStore()
  const network = useNetworkStore()
  const settings = useSettingsStore()
  const message = useMessage()
  const { confirmRemove } = useDeleteConfirm()

  /** 解析 + 按全局打开方式打开；返回结果供调用方决定是否提示 */
  function open(item: Item): OpenResult {
    const resolved = network.resolve(item)

    if (!resolved.url) {
      message.warning(T.actions.noAddress(item.title))
      return { ok: false, reason: 'no-url', url: null }
    }

    if (settings.openMode === 'self') window.location.href = resolved.url
    else window.open(resolved.url, '_blank', 'noopener,noreferrer')

    return { ok: true, url: resolved.url }
  }

  async function copyLink(item: Item): Promise<void> {
    const resolved = network.resolve(item)
    if (!resolved.url) {
      message.warning(T.actions.nothingToCopy)
      return
    }
    try {
      await navigator.clipboard.writeText(resolved.url)
      message.success(T.actions.copied)
    } catch {
      // 非安全上下文（http://内网 IP）下 Clipboard API 不可用 → 退回到旧接口
      const ta = document.createElement('textarea')
      ta.value = resolved.url
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      message[ok ? 'success' : 'error'](ok ? T.actions.copied : T.actions.copyFailed)
    }
  }

  async function remove(item: Item): Promise<boolean> {
    // 删除不可逆：先弹二级确认，用户取消则不请求接口
    if (!(await confirmRemove(item))) return false
    try {
      await items.removeItem(item.id)
      message.success(T.actions.deleted(item.title))
      return true
    } catch (e) {
      message.error(e instanceof Error ? e.message : T.common.deleteFailed)
      return false
    }
  }

  return { open, copyLink, remove }
}
