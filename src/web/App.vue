<script setup lang="ts">
/**
 * 应用外壳。
 *
 * 职责：
 *   1. 认证门禁 —— 先问 `/api/auth/state`，未登录只渲染登录页，
 *      登录成功后才 bootstrap（一次请求拿全 groups / items / settings / version）
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
 * 登录页同样吃这份缓存，所以锁屏与登录后的观感是一致的。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
import { AUTH_REQUIRED_EVENT, api } from '@/api/client'
import { syncDocumentTitle } from '@/router'
import { useAuthStore } from '@/stores/auth'
import { useItemsStore } from '@/stores/items'
import { useNetworkStore } from '@/stores/network'
import { useSettingsStore } from '@/stores/settings'
import { useMonitorStore } from '@/stores/monitor'
import { useMonitorStream } from '@/composables/useMonitorStream'
import { toWallpaperCssUrl, isGatedWallpaper } from '@/utils/wallpaper-url'
import BootNotice from '@/components/BootNotice.vue'
import LoginView from '@/views/LoginView.vue'
import { useGlassTheme } from '@/composables/useGlassTheme'

const items = useItemsStore()
const settings = useSettingsStore()
const network = useNetworkStore()
const monitor = useMonitorStore()
const auth = useAuthStore()
const { start: startMonitorStream, stop: stopMonitorStream } = useMonitorStream()

const bootError = ref<string | null>(null)
const booted = ref(false)
/** 面板数据是否已就绪（登录后才会 bootstrap） */
const appStarted = ref(false)

/** 门禁放行（已登录，或显式关闭了登录保护）才渲染桌面 */
const unlocked = computed(() => auth.status === 'ready')

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
  /**
   * 图片类壁纸的地址都在鉴权门禁后面（`/bg/*`、`/api/wallpaper/bing`、
   * `/api/local-image`）。登录页上的设置来自 localStorage 缓存，如果这时就把
   * 地址写进 DOM，浏览器会先发一次必然 401 的请求；**同一个 URL 失败之后不会再
   * 被重试** —— 登录后 computed 重新算出来的地址没变，属性也没变，图片就一直空着，
   * 直到手动刷新页面（新的一次页面加载才有机会用带会话的 Cookie 重新请求）。
   *
   * 判据用 settings.hydrated（服务端设置已到位 ⇒ 已过门禁）而不是 unlocked：
   * 会话过期退回锁屏时，已经加载好的壁纸不该突然消失。
   */
  if (isGatedWallpaper(type) && !settings.hydrated) return style
  switch (type) {
    case 'solid':
      style.background = value || 'var(--bg)'
      break
    case 'asset': {
      // 本机路径要转成服务端地址（/Users/… 直接写会被浏览器当面板域下的路径）
      const url = toWallpaperCssUrl(value)
      if (url) style.backgroundImage = `url("${url}")`
      break
    }
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
    // 放开 appStarted，让 BootNotice 的「重试」能真的再跑一遍 bootstrap
    appStarted.value = false
  } finally {
    booted.value = true
  }
}

/** 通过门禁之后才拉数据 + 开监控流（幂等：登录事件与 watch 会各触发一次） */
async function enterApp(): Promise<void> {
  if (appStarted.value) return
  appStarted.value = true
  // 登录页改写过标签页标题（登录不经过路由变化），这里交还给路由
  syncDocumentTitle()
  // 监控 SSE 在外壳层启动：设置页 / 首页都能拿到实时数据，切换路由不重连
  startMonitorStream()
  await bootstrap()
}

/** 会话失效（过期 / 改密码 / 退出所有设备）：立刻断开数据流并回到登录页 */
function onAuthRequired(): void {
  stopMonitorStream()
  appStarted.value = false
  bootError.value = null
  auth.lock()
}

/** 引导失败（后端未启动等）—— 认证状态未知时也算失败，否则会停在空白页 */
const noticeError = computed(() =>
  bootError.value ?? (auth.status === 'loading' ? auth.error : null),
)
const noticeBooting = computed(() => !booted.value || auth.status === 'loading')

async function retryBoot(): Promise<void> {
  bootError.value = null
  if (auth.status === 'loading') await auth.load()
  if (auth.status === 'ready') await enterApp()
}

/** 登录成功（门禁放行）→ 拉数据 + 开监控流；门禁关回去 → 立刻断开 */
watch(unlocked, (ready) => {
  if (ready) {
    void enterApp()
    return
  }
  // 登出 / 「退出所有设备」不会产生 401，必须在这里主动收摊：
  // 否则已建立的 SSE 会继续把数据推给一个已经登出的页面，
  // 而且 appStarted 卡在 true 会让下次登录跳过 bootstrap。
  stopMonitorStream()
  appStarted.value = false
})

onMounted(async () => {
  window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
  await auth.load()
})

onUnmounted(() => {
  window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
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

            <!-- 门禁之后才挂载桌面：未登录时不渲染任何面板内容，也不发数据请求 -->
            <div v-if="unlocked" class="pane main-pane">
              <router-view />
            </div>
            <LoginView v-else-if="auth.status === 'locked' || auth.status === 'setup'" />

            <!-- 引导失败的兜底遮罩 -->
            <BootNotice
              v-if="noticeError"
              :error="noticeError"
              :booting="noticeBooting"
              @retry="retryBoot"
            />
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
