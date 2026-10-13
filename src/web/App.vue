<script setup lang="ts">
/**
 * 应用外壳。
 *
 * 职责：
 *   1. 首屏 bootstrap（一次请求拿全 groups / items / settings / version）
 *   2. Naive UI 主题同步 —— 深色模式下必须传 darkTheme，否则控件是白底
 *   3. CSS 变量（--accent）+ <html data-theme> 的落地
 *   4. 壁纸层、监控 SSE 数据流、全局消息宿主
 *
 * 首页布局不再有常驻顶栏与监控侧栏：硬件信息在 HomeView 里以卡片形式
 * 和 App 卡片并列（见 components/SystemStatusSection.vue）。
 * 监控数据流提到外壳层启动，页面切换时不会反复断开重连。
 *
 * 主题初始值刻意先读 localStorage 缓存（settings store 初始化时已做）：
 * bootstrap 是异步的，不这样做深色用户会先看到一帧浅色界面。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import {
  darkTheme,
  dateZhCN,
  NConfigProvider,
  NDialogProvider,
  NGlobalStyle,
  NMessageProvider,
  NNotificationProvider,
  zhCN,
} from 'naive-ui'
import type { GlobalThemeOverrides } from 'naive-ui'
import { api } from '@/api/client'
import { useItemsStore } from '@/stores/items'
import { useNetworkStore } from '@/stores/network'
import { useSettingsStore } from '@/stores/settings'
import { useMonitorStore } from '@/stores/monitor'
import { useMonitorStream } from '@/composables/useMonitorStream'
import BootNotice from '@/components/BootNotice.vue'
import { useGlassTheme } from '@/composables/useGlassTheme'

const items = useItemsStore()
const settings = useSettingsStore()
const network = useNetworkStore()
const monitor = useMonitorStore()
const { start: startMonitorStream } = useMonitorStream()

const bootError = ref<string | null>(null)
const booted = ref(false)

// ── 主题 ─────────────────────────────────────────────────────

/* isDark（生效的明暗状态）在 settings store 里，因为 ThemeSwitch 也要读它；
   这里用 storeToRefs 保住响应式，别写成 settings.isDark 那样的一次性快照。 */
const { isDark } = storeToRefs(settings)

const theme = computed(() => (isDark.value ? darkTheme : null))

/**
 * Naive UI 主题覆盖 —— 只负责「控件内部」的那套语言，页面本体在 styles/main.css。
 *
 * 关键手法是把 common.borderColor / dividerColor 设成 transparent：Naive 各组件的
 * 1px 边框与分割线都是从这两个源头变量派生的，一次性去掉比逐个组件打补丁可靠。
 * 去掉线之后控件不能变成「空气」，所以同时给 inputColor / cardColor 一档色块，
 * 层次改由 色块 + 留白 + 阴影 表达（focus 环仍保留，那是可达性不是装饰）。
 */
const themeOverrides = computed<GlobalThemeOverrides>(() => ({
  common: {
    borderRadius: '6px',
    borderRadiusSmall: '4px',
    fontFamily:
      "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    fontSize: '14px',
    primaryColor: settings.accent,
    primaryColorHover: settings.accent,
    primaryColorPressed: settings.accent,
    primaryColorSuppl: settings.accent,
    borderColor: 'transparent',
    dividerColor: 'transparent',
    placeholderColor: isDark.value ? 'rgba(238,242,248,.36)' : 'rgba(20,25,36,.38)',
    iconColor: isDark.value ? 'rgba(238,242,248,.52)' : 'rgba(20,25,36,.48)',
  },
  Card: {
    borderRadius: '10px',
    paddingMedium: '20px 22px',
    paddingSmall: '16px 18px',
  },
  Modal: { borderRadius: '10px' },
  Popover: { borderRadius: '8px' },
  Dropdown: { borderRadius: '8px', padding: '5px' },
  Input: { paddingSmall: '0 10px', paddingMedium: '0 12px' },
  InternalSelection: {
    paddingSmall: '0 10px',
    paddingMedium: '0 12px',
    menuBoxShadow: '0 20px 48px -20px rgba(0,0,0,.5)',
  },
  Button: { fontWeight: '500', borderRadiusMedium: '6px', borderRadiusSmall: '6px' },
  Tag: { borderRadius: '4px' },
  Alert: { borderRadius: '6px' },
  Form: { labelSpace: '6px', labelFontSizeMedium: '12px' },
  Progress: { borderRadius: '4px' },
  Divider: { color: 'transparent' },
  Scrollbar: { width: '7px', borderRadius: '4px', color: 'rgba(128,138,155,.32)' },
}))

/** 壁纸层样式 */
const wallpaperStyle = computed(() => {
  const type = settings.wallpaperType
  const value = typeof settings.wallpaperValue === 'string' ? settings.wallpaperValue : ''
  const style: Record<string, string> = {}
  switch (type) {
    case 'solid':
      style.background = value || 'var(--bg)'
      break
    case 'asset':
      if (value) style.backgroundImage = `url("${value}")`
      break
    case 'bing':
      // 由服务端代理 Bing 官方接口，避免依赖不稳定的第三方中转
      style.backgroundImage = 'url("/api/wallpaper/bing")'
      break
    default:
      break
  }
  return style
})

function applyDocumentTheme(): void {
  const root = document.documentElement
  root.dataset.theme = isDark.value ? 'dark' : 'light'
  root.style.setProperty('--accent', settings.accent)
  // 壁纸直排文字颜色：auto 时不带 data-wpt，交回主题
  if (settings.wallpaperText === 'auto') root.removeAttribute('data-wpt')
  else root.dataset.wpt = settings.wallpaperText
  // 让滚动条等原生控件也跟随主题
  root.style.colorScheme = isDark.value ? 'dark' : 'light'
}

watch(
  [isDark, () => settings.accent, () => settings.wallpaperText],
  applyDocumentTheme,
  {
    immediate: true,
  },
)

// ── 首屏 ─────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  try {
    const payload = await api.bootstrap()
    items.hydrate(payload)
    settings.hydrate(payload.settings)
    // 启动顺序：localStorage 先渲染 → 服务端值覆盖（不一致时以服务端为准）
    network.syncFromServer(payload.settings['network.mode'])
    await monitor.loadStaticInfo()
    bootError.value = null
  } catch (e) {
    bootError.value = e instanceof Error ? e.message : String(e)
  } finally {
    booted.value = true
  }
}

onMounted(() => {
  // 监控 SSE 在外壳层启动：设置页 / 首页都能拿到实时数据，切换路由不重连
  startMonitorStream()
  void bootstrap()
})

// 卡片玻璃风格（毛玻璃 / 液态玻璃）跟随设置实时切换
useGlassTheme()
</script>

<template>
  <NConfigProvider
    :theme="theme"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
    class="app-frame"
  >
    <NGlobalStyle />
    <NMessageProvider :max="3" placement="bottom-right">
      <NDialogProvider>
        <NNotificationProvider :max="3">
          <div class="app-shell">
            <!-- 壁纸层只负责铺底；模糊只属于卡片，壁纸本身永远清晰 -->
            <div
              class="wallpaper"
              :class="`wp-${settings.wallpaperType}`"
              :style="wallpaperStyle"
            />

            <div class="pane main-pane">
              <router-view />
            </div>

            <!-- 引导失败的兜底遮罩 -->
            <BootNotice v-if="bootError" :error="bootError" :booting="!booted" @retry="bootstrap" />
          </div>
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped>
/* NConfigProvider 会渲染一层自己的 wrapper div；它没有高度的话，
   下层 app-shell → main-pane → 页面的整条 height:100% 链全部失效，
   长内容只会被 body 的 overflow:hidden 裁掉、哪里都滚不到。 */
.app-frame {
  height: 100%;
}

.app-shell {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.wallpaper {
  position: fixed;
  inset: 0;
  z-index: 0;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  pointer-events: none;
}

.wp-gradient {
  /* 色斑强度由 --wp-* 变量按主题提供（见 styles/main.css）：
     深色底需要高得多的不透明度才看得见，浅色底则要压下去。 */
  background-image:
    radial-gradient(1100px 620px at 12% -8%, var(--wp-1), transparent 62%),
    radial-gradient(900px 520px at 88% 4%, var(--wp-2), transparent 60%),
    radial-gradient(760px 520px at 50% 106%, var(--wp-3), transparent 62%),
    radial-gradient(800px 560px at 96% 102%, var(--wp-4), transparent 64%);
}

.pane {
  min-height: 0;
  min-width: 0;
}

.main-pane {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
}
</style>
