/**
 * 编辑模式的「点击空白处退出」。
 *
 * 仅在 active 为 true 时监听 document **捕获阶段** 的 click：
 *   - 点击落在卡片、按钮、浮层等交互元素上（命中 keepSelectors）→ 不退出；
 *   - 其余（壁纸、分区空白、网格间隙等）→ 退出编辑模式。
 *
 * 用捕获阶段是为了不被卡片自身的 stopPropagation 影响；监听器在
 * 进入编辑模式那次点击**之后**才挂上（watch 在下一个微任务刷新），
 * 所以点击编辑开关本身不会立刻把自己关掉。
 */
import { onBeforeUnmount, watch, type Ref } from 'vue'

export function useEditModeDismiss(active: Ref<boolean>, keepSelectors: string): void {
  function onDocClick(event: MouseEvent): void {
    if (!active.value) return
    const target = event.target
    if (target instanceof Element && target.closest(keepSelectors)) return
    active.value = false
  }

  watch(active, (on) => {
    if (on) document.addEventListener('click', onDocClick, true)
    else document.removeEventListener('click', onDocClick, true)
  })

  onBeforeUnmount(() => document.removeEventListener('click', onDocClick, true))
}
