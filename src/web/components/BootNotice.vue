<script setup lang="ts">
/**
 * 首屏引导失败的兜底提示。
 *
 * 典型场景：后端还没起来就打开了页面（开发时常见），
 * 或者 /api/bootstrap 返回了错误结构。
 */
import { NButton, NSpin } from 'naive-ui'
import FaviconGlyph from './FaviconGlyph.vue'

defineProps<{
  error: string
  booting?: boolean
}>()

const emit = defineEmits<{ (e: 'retry'): void }>()
</script>

<template>
  <div class="boot-mask">
    <div class="boot-card card">
      <div class="boot-head">
        <FaviconGlyph name="cloud-off" :size="20" />
        <strong>无法加载面板数据</strong>
      </div>
      <p class="mono dim msg">{{ error }}</p>
      <p class="dim tiny">
        请确认后端已启动（默认 <span class="mono">http://127.0.0.1:3002</span>），
        然后重试。当前页面在离线状态下仍会保留本地缓存的网络模式与主题。
      </p>
      <NSpin v-if="booting" size="small" />
      <NButton size="small" type="primary" :disabled="booting" @click="emit('retry')">
        重试
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.boot-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(6px);
  padding: 20px;
}

.boot-card {
  width: min(460px, 100%);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  align-items: flex-start;
  /* 兜底遮罩要挡住后面的壁纸，用 --surface 而不是半透卡片；
     .card 在新设计语言里不再自带 padding，这里显式给。 */
  background: var(--surface);
  padding: var(--sp-5);
  box-shadow: var(--shadow-3);
}

.boot-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--err);
}

.msg {
  font-size: 12px;
  margin: 0;
  word-break: break-all;
}

.tiny {
  font-size: 12px;
  margin: 0;
}
</style>
