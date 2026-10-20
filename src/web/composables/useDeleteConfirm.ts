/**
 * 危险操作的确认弹窗（Naive UI Dialog）。
 *
 * 卡片删除 / 移除的所有入口共用：APP 卡片的右键菜单 / 编辑模式移除角标 /
 * 卡片编辑器，以及「系统状态」区硬件卡片的移除角标。
 * 通用的 `confirm()` 也用于设置里退出登录 / 退出所有设备的**二级确认**
 * （一级是 NPopconfirm 气泡，见 SettingsModal.vue）。
 * 用 Promise 包一层，调用方 `if (!(await confirm(...))) return` 即可。
 * 弹窗视觉沿用全局 Naive UI 主题（App.vue 的 NDialogProvider）。
 */
import { useDialog } from 'naive-ui'
import { TEXT as T } from '@shared/text'
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
      let decided: boolean | null = null
      let settled = false
      // 点按钮只记结论，真正结算放到退场结束之后
      const decide = (value: boolean): void => {
        decided = value
      }
      /**
       * 结算放在 after-leave：调用方拿到 true 之后往往紧接着关掉自己那层弹窗
       * （卡片编辑器删除后关闭、导入完成后关闭导入弹窗）。如果点击当帧就结算，
       * 确认框还在退场时下一层弹窗已经开始退场 —— 两层各缩各的，观感像两个窗口
       * 朝不同方向散开。等它退干净再放行，两段动画就是前后脚的关系。
       */
      const settle = (): void => {
        if (settled) return
        settled = true
        resolve(decided ?? false)
      }

      dialog.warning({
        title: options.title,
        content: options.content,
        // 紧凑尺寸：默认对话框对本项目的一两句话太重，收窄并缩小按钮
        class: 'confirm-dialog',
        style: { width: '340px', maxWidth: '86vw' },
        positiveText: options.positiveText ?? T.common.delete,
        negativeText: options.negativeText ?? T.common.cancel,
        positiveButtonProps: { type: 'error', size: 'small' },
        negativeButtonProps: { size: 'small' },
        onPositiveClick: () => decide(true),
        onNegativeClick: () => decide(false),
        onClose: () => decide(false),
        onMaskClick: () => decide(false),
        onEsc: () => decide(false),
        onAfterLeave: settle,
      })
    })
  }

  /** APP 卡片删除确认（不可恢复） */
  function confirmRemove(item: Item): Promise<boolean> {
    return confirm({
      title: T.confirm.deleteTitle,
      content: T.confirm.deleteContent(item.title),
      positiveText: T.common.delete,
    })
  }

  return { confirm, confirmRemove }
}
