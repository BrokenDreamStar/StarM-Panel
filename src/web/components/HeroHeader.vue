<script setup lang="ts">
/**
 * 英雄区 —— 大号标题 + 时钟（HH:MM）与日期（9-29 星期二）。
 *
 * 标题与时钟之间用一条细竖线分隔（参考 sun-panel：线高约等于时钟数字高度，
 * 上下留白，线宽 2px），配合间距与字重差表达「同一组、两种信息」。竖线只在
 * 时钟渲染时出现（`ui.showClock` 为 false 时整块不渲染），窄屏上下堆叠时隐藏。
 * 时钟用 setInterval 每秒走一格。
 * 日期刻意手写星期表，不用 toLocaleDateString —— 后者在不同浏览器 / locale
 * 下的输出格式（星期几 vs 周几）并不一致。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { TEXT as T } from '@shared/text'

const props = withDefaults(
  defineProps<{
    title?: string
    showClock?: boolean
  }>(),
  { title: T.router.brand, showClock: true },
)

const WEEKDAYS = T.header.weekdays

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
      <span class="hero-divider" aria-hidden="true" />
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
  /* 三件套：标题 │ 时钟，两侧间距由竖线居中摊开，故比无竖线时更紧 */
  gap: clamp(11px, 1.2vw, 15px);
  padding: clamp(56px, 10vh, 104px) 8px clamp(34px, 5.5vh, 58px);
  color: var(--wp-text);
  text-align: center;
}

.hero-title {
  /* 下限抬到 40px：vw 项在 ≤950px 就跌破下限了，之前窄窗口的标题只有 30px，
     既和手机上（≤640px 会放大一档）接不上，本身也偏小 */
  font-size: clamp(40px, 4.2vw, 50px);
  font-weight: 650;
  line-height: 1.1;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
}

/* 竖分隔线：字号跟随时钟缩放，高度 ≈ 时钟数字高（0.72em），
   两端齐平不渐隐，颜色取壁纸直排文字色并略降透明度 */
.hero-divider {
  flex: none;
  align-self: center;
  width: 2px;
  height: 0.72em;
  font-size: clamp(30px, 2.7vw, 34px);
  border-radius: 1px;
  background: currentColor;
  opacity: 0.85;
}

.hero-clock {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.14;
}

.clock-time {
  /* 与标题同一档下限：时钟是这一区的第二主角，缩到 23px 时只剩装饰性 */
  font-size: clamp(30px, 2.7vw, 34px);
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

  /* 上下堆叠时竖线没有分隔意义，直接隐藏 */
  .hero-divider {
    display: none;
  }

  .hero-clock {
    align-items: center;
  }

  /*
   * 手机上反而要放大一档：上面几处 clamp 的中间项是 vw，窄屏时会一路掉到下限
   * （390px 上标题只有 30px、时钟 23px），而竖排之后旁边没有分隔线和时钟挤占
   * 宽度，字号完全放得下。这里按视口宽度给一档更大的区间，320px 起就有 36px。
   */
  .hero-title {
    font-size: clamp(36px, 10vw, 46px);
  }

  .clock-time {
    font-size: clamp(30px, 8.4vw, 38px);
  }

  .clock-date {
    margin-top: 4px;
    font-size: 13px;
  }
}
</style>
