<script setup lang="ts">
/**
 * 日夜主题开关 —— 移植自 WpfGorgeousThemeSwitch（MIT）的 ToggleButton 样式。
 *
 * 本体是一片会换天的天空，不是一个图标：
 *   日间 = #4685C0 蓝天 + 白云 + 太阳（球停在左）
 *   夜间 = #171E33 夜空 + 星星 + 月亮（球滑到右）
 * 太阳和月亮共用同一颗球，靠各自横向滑入滑出完成替换；球的位移带一点过冲，
 * 对应原版 66→63 的关键帧（撞到边界后回弹 settle）。
 *
 * 颜色在这里是刻意写死的：它们画的是真实的白天与夜晚，不跟随 --accent
 * 也不跟随明暗令牌。这是全项目唯一不套 main.css 设计令牌的地方。
 */
import { computed } from 'vue'
import { useSettingsStore } from '@/stores/settings'

/** 原版的凹边 4 角星，viewBox 100×100 */
const SPARKLE =
  'M100 50C72.39 50 50 72.39 50 100 50 72.39 27.61 50 0 50 27.61 50 50 27.61 50 0 50 27.61 72.39 50 100 50Z'

/**
 * 星星位置从原版 100×40 画布按 58×30 换算（x ×0.58、y ×0.75），刻意只铺左半片
 * —— 右半边是月亮的位置。tw 是闪烁延迟（秒），0 表示这颗不参与闪烁。
 */
const STARS = [
  { x: 6.7, y: 19.9, s: 2.9, tw: 0 },
  { x: 14.3, y: 19.9, s: 2.9, tw: 1.1 },
  { x: 23, y: 22.1, s: 2.9, tw: 1.5 },
  { x: 12, y: 4.1, s: 4.1, tw: 0.7 },
  { x: 27, y: 7.5, s: 4.1, tw: 0.9 },
  { x: 18.7, y: 9.4, s: 2.2, tw: 0 },
  { x: 13.7, y: 13.5, s: 2.2, tw: 0 },
  { x: 19.7, y: 18, s: 2.2, tw: 0 },
  { x: 27.3, y: 16.9, s: 2.2, tw: 0 },
  { x: 22.9, y: 6, s: 2.2, tw: 0 },
  { x: 5.8, y: 8.3, s: 2.2, tw: 1.3 },
]

const settings = useSettingsStore()

/** 用生效的明暗状态而不是 themeMode：system 模式下也要显示真实的那片天 */
const night = computed(() => settings.isDark)

const title = computed(() => {
  const current = settings.themeMode === 'system' ? '跟随系统' : night.value ? '深色' : '浅色'
  return `当前主题：${current}（点击切换浅色 / 深色）`
})

function toggle(): void {
  void settings.patch({ 'theme.mode': night.value ? 'light' : 'dark' })
}
</script>

<template>
  <button
    class="theme-switch"
    type="button"
    role="switch"
    :aria-checked="night"
    :class="{ night }"
    :title="title"
    aria-label="切换浅色 / 深色主题"
    @click="toggle"
  >
    <span class="sky">
      <span class="stars" aria-hidden="true">
        <svg
          v-for="(st, i) in STARS"
          :key="i"
          class="star"
          :class="{ twinkle: st.tw > 0 }"
          viewBox="0 0 100 100"
          :style="{
            left: `${st.x}px`,
            top: `${st.y}px`,
            width: `${st.s}px`,
            height: `${st.s}px`,
            animationDelay: st.tw ? `${st.tw}s` : undefined,
          }"
        >
          <path :d="SPARKLE" fill="#fff" />
        </svg>
      </span>

      <span class="clouds" aria-hidden="true">
        <span class="cloud cloud-a" />
        <span class="cloud cloud-b" />
      </span>

      <span class="orb">
        <span class="face">
          <span class="sun" />
          <span class="moon">
            <i class="crater c1" />
            <i class="crater c2" />
            <i class="crater c3" />
          </span>
        </span>
      </span>
    </span>
  </button>
</template>

<style scoped>
/* 尺寸对齐同组的 .ctl（30px 高），所以浮动组不会因为换了控件而改变高度。
   不做「idle 收成圆、hover 展开成胶囊」—— 原版那是 WPF 标题栏省横空间的办法，
   在这里会让胶囊浮到 NetworkSwitch 上面去。 */
.theme-switch {
  position: relative;
  display: inline-flex;
  flex: none;
  width: 58px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 15px;
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.sky {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: 15px;
  background: #4685c0;
  box-shadow: 0 3px 10px -4px rgba(0, 0, 0, 0.5);
  transition: background-color 0.62s ease-in-out;
}

.night .sky {
  background: #171e33;
}

/* ── 星星：整片从天空上方坠入，落到位之后错峰闪烁 ───────────── */
.stars {
  position: absolute;
  inset: 0;
  transform: translateY(-26px);
  transition: transform 0.62s cubic-bezier(0.34, 1.4, 0.55, 1);
}

.night .stars {
  transform: translateY(0);
}

.star {
  position: absolute;
  transform-origin: 50% 50%;
}

/* scaleX 压到 0 再放回：凹边星会先瘦成一条光，就是原版的眨一下眼。
   动画只挂在 .night 上，所以每次入夜都重新播一次，白天则完全不占资源。 */
.night .star.twinkle {
  animation: twinkle 1.2s ease-in-out both;
}

@keyframes twinkle {
  0%,
  100% {
    transform: scaleX(1);
  }
  50% {
    transform: scaleX(0);
  }
}

/* ── 云：外层管日夜的上下进出，内层管白天的漂移 ─────────────── */
.clouds {
  position: absolute;
  inset: 0;
  transition: transform 0.9s cubic-bezier(0.3, 1.05, 0.5, 1);
}

.night .clouds {
  transform: translateY(26px);
}

.cloud {
  position: absolute;
  border-radius: 999px;
}

.cloud::before,
.cloud::after {
  content: '';
  position: absolute;
  background: inherit;
  border-radius: 50%;
}

/* 原版 cloud1 是半透明白、cloud2 是实白并压得更低。
   两朵都刻意只占天空的下缘一小条：做大了就不像云，像一坨浆糊。 */
.cloud-a {
  left: 2px;
  bottom: 1px;
  width: 22px;
  height: 5px;
  background: rgba(255, 255, 255, 0.53);
}

.cloud-a::before {
  left: 3px;
  top: -5px;
  width: 9px;
  height: 9px;
}

.cloud-a::after {
  right: 3px;
  top: -2px;
  width: 6px;
  height: 6px;
}

.cloud-b {
  left: 20px;
  bottom: -3px;
  width: 26px;
  height: 6px;
  background: #fff;
}

.cloud-b::before {
  left: 5px;
  top: -6px;
  width: 11px;
  height: 11px;
}

.cloud-b::after {
  right: 5px;
  top: -3px;
  width: 7px;
  height: 7px;
}

.theme-switch:not(.night) .cloud-a {
  animation: drift 7s ease-in-out infinite;
}

.theme-switch:not(.night) .cloud-b {
  animation: drift 9s ease-in-out infinite reverse;
}

@keyframes drift {
  0%,
  100% {
    transform: translateX(0);
  }
  50% {
    transform: translateX(3px);
  }
}

/* ── 球：滑动带过冲，外圈一圈柔光（白天是日冕，夜里是月晕） ─── */
.orb {
  position: absolute;
  left: 3px;
  top: 3px;
  width: 24px;
  height: 24px;
  overflow: hidden;
  border-radius: 50%;
  /* 光晕只用模糊、不用描边式 spread：硬圈会被天空裁断，看着像破图 */
  box-shadow:
    0 0 10px 3px rgba(255, 255, 255, 0.3),
    0 2px 6px rgba(0, 0, 0, 0.28);
  transition: transform 0.62s cubic-bezier(0.34, 1.45, 0.55, 1);
}

.night .orb {
  transform: translateX(26px);
}

/* 原版 hover 时整颗球转 30°，高光跟着走 */
.face {
  position: absolute;
  inset: 0;
  transition: transform 0.5s cubic-bezier(0.3, 0.7, 0.2, 1);
}

.theme-switch:hover .face {
  transform: rotate(26deg);
}

.sun,
.moon {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  transition: transform 0.5s ease-in-out;
}

.sun {
  background: radial-gradient(circle at 32% 28%, #ffe08a, #f3c62b 62%, #dda91a);
}

.night .sun {
  transform: translateX(-104%);
}

.moon {
  background: radial-gradient(circle at 34% 30%, #eef1f7, #c4c9d4 68%, #b0b6c4);
  transform: translateX(104%);
}

.night .moon {
  transform: translateX(0);
}

/* 环形山用内阴影起边，不描线 —— 和整套「去线留白」保持一致 */
.crater {
  position: absolute;
  border-radius: 50%;
  background: #a7adbd;
  box-shadow: inset 0 1px 1.5px rgba(0, 0, 0, 0.18);
}

.c1 {
  left: 5px;
  top: 10px;
  width: 7px;
  height: 7px;
}

.c2 {
  left: 9px;
  top: 4px;
  width: 5px;
  height: 5px;
}

.c3 {
  left: 15px;
  top: 13px;
  width: 5px;
  height: 5px;
}
</style>
