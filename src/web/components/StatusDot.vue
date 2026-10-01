<script setup lang="ts">
/**
 * 探测状态点：绿=可达 / 灰=不可达 / 空心=未探测。
 * 单独抽出来是因为内网/外网/自动三个按钮都要用，且语义必须一致。
 */
withDefaults(
  defineProps<{
    /** true=可达 false=不可达 undefined=未探测 */
    state?: boolean
    /** 尺寸 */
    size?: number
  }>(),
  { size: 6 },
)
</script>

<template>
  <i
    class="status-dot"
    :class="state === true ? 'ok' : state === false ? 'off' : 'unknown'"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :title="state === true ? '探测可达' : state === false ? '探测不可达' : '尚未探测'"
  />
</template>

<style scoped>
.status-dot {
  display: inline-block;
  flex: none;
  border-radius: 50%;
  background: var(--text-3);
}

.status-dot.ok {
  background: var(--ok);
}

.status-dot.off {
  background: var(--err);
  opacity: 0.9;
}

/* 未探测：用一颗更淡的实心点表示「不知道」，而不是描一个空心圈
   （去线规则下不画 1px 圆环，淡实心点在两种主题里都比空心更稳） */
.status-dot.unknown {
  background: color-mix(in srgb, var(--text-2) 42%, transparent);
}
</style>
