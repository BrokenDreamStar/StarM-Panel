/**
 * 卡片删除 / 移除的确认弹窗（Naive UI Dialog）。
 *
 * 所有入口共用：APP 卡片的右键菜单 / 编辑模式移除角标 / 卡片编辑器，
 * 以及「系统状态」区硬件卡片的移除角标。
 * 用 Promise 包一层，调用方 `if (!(await confirm(...))) return` 即可。
 * 弹窗视觉沿用全局 Naive UI 主题（App.vue 的 NDialogProvider）。
 */
import { useDialog } from 'naive-ui'
import type { Item } from '@shared/types'

/** 通用确认弹窗参数 */
export interface ConfirmDialogOptions {
  title: string
  content: string
  /** 确认按钮文案，默认「删除」 */
  positiveText?: string
  /** 取消按钮文案，默认「取消」 */
  negativeText?: string
}

export function useDeleteConfirm() {
  const dialog = useDialog()

  /** 弹出确认框：确认返回 true；取消 / 关闭 / 按 Esc / 点遮罩均返回 false */
  function confirm(options: ConfirmDialogOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      // 关闭与取消可能同时触发，保证 Promise 只结算一次
      const settle = (value: boolean): void => {
        if (settled) return
        settled = true
        resolve(value)
      }

      dialog.warning({
        title: options.title,
        content: options.content,
        // 紧凑尺寸：默认对话框对本项目的一两句话太重，收窄并缩小按钮
        class: 'confirm-dialog',
        style: { width: '340px', maxWidth: '86vw' },
        positiveText: options.positiveText ?? '删除',
        negativeText: options.negativeText ?? '取消',
        positiveButtonProps: { type: 'error', size: 'small' },
        negativeButtonProps: { size: 'small' },
        onPositiveClick: () => settle(true),
        onNegativeClick: () => settle(false),
        onClose: () => settle(false),
        onMaskClick: () => settle(false),
        onEsc: () => settle(false),
      })
    })
  }

  /** APP 卡片删除确认（不可恢复） */
  function confirmRemove(item: Item): Promise<boolean> {
    return confirm({
      title: '删除卡片',
      content: `删除后无法恢复，确定删除「${item.title}」？`,
      positiveText: '删除',
    })
  }

  return { confirm, confirmRemove }
}
