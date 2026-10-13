<script setup lang="ts">
/**
 * 英雄区 —— 大号标题 + 时钟（HH:MM）与日期（9-29 星期二）。
 *
 * 标题与时钟之间不再画竖分隔线（去线留白），只用间距和字重差表达「同一组、
 * 两种信息」。时钟用 setInterval 每秒走一格；`ui.showClock` 为 false 时整块不渲染。
 * 日期刻意手写星期表，不用 toLocaleDateString —— 后者在不同浏览器 / locale
 * 下的输出格式（星期几 vs 周几）并不一致。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    title?: string
    showClock?: boolean
  }>(),
  { title: 'StarM Panel', showClock: true },
)

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

const now = ref(new Date())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    now.value = new Date()
  }, 1000)
})

onUnmounted(() => {
  if (timer !== null) clearInterval(timer)
  timer = null
})

const time = computed(() => {
  const h = String(now.value.getHours()).padStart(2, '0')
  const m = String(now.value.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
})

const date = computed(
  () => `${now.value.getMonth() + 1}-${now.value.getDate()} ${WEEKDAYS[now.value.getDay()]}`,
)

const label = computed(() => (props.title ?? '').trim() || 'StarM Panel')
</script>

<template>
  <header class="hero">
    <h1 class="hero-title">{{ label }}</h1>
    <template v-if="showClock">
      <div class="hero-clock">
        <time class="clock-time mono" :datetime="now.toISOString()">{{ time }}</time>
        <span class="clock-date">{{ date }}</span>
      </div>
    </template>
  </header>
</template>

<style scoped>
.hero {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(20px, 3vw, 34px);
  padding: clamp(56px, 10vh, 104px) 8px clamp(34px, 5.5vh, 58px);
  color: var(--wp-text);
  text-align: center;
}

.hero-title {
  font-size: clamp(30px, 4.2vw, 50px);
  font-weight: 650;
  line-height: 1.1;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
}

.hero-clock {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.14;
}

.clock-time {
  font-size: clamp(23px, 2.7vw, 34px);
  font-weight: 500;
  letter-spacing: 0.01em;
}

.clock-date {
  margin-top: 3px;
  font-size: clamp(11px, 1.2vw, 14px);
  color: var(--wp-text);
  opacity: 0.72;
}

@media (max-width: 640px) {
  .hero {
    flex-direction: column;
    gap: 14px;
  }

  .hero-clock {
    align-items: center;
  }
}
</style>
