import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { TEXT as T } from '@shared/text'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { title: T.router.homeTitle },
  },
  // 设置不再是一条路由：首页右上角齿轮直接开弹窗（components/SettingsModal.vue）。
  // 旧 /settings 书签由下方 catch-all 兜底转回首页。
  // 旧版把硬件监控做成右侧侧栏，/monitor 曾用于直接展开它。
  // 侧栏已按 §10.6 改为首页的「系统状态」卡片区，这里只保留一个转发，
  // 让旧书签不至于 404。不要再往 query 里塞 HomeView 不读的参数。
  { path: '/monitor', redirect: '/' },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

/**
 * 写标签页标题 —— 认证状态 + 当前路由一起决定。
 *
 * 为什么必须把认证状态纳进来：登录页 / 锁屏**不占路由**（见 App.vue 的门禁），
 * 而 `/` 的视图为懒加载，它的 chunk 往往比 `/api/auth/state` 更慢 ——
 * 于是导航结束时触发的纯路由标题会把登录页刚写好的标题覆盖成「桌面」，
 * 看起来像已经进面板了。这里让「锁屏」优先级高于路由标题，
 * 无论是登录页先挂载还是导航后完成，结果都一致。
 */
export function syncDocumentTitle(): void {
  let gate: 'setup' | 'login' | null = null
  try {
    const auth = useAuthStore()
    if (auth.status === 'setup') gate = 'setup'
    else if (auth.status !== 'ready') gate = 'login'
  } catch {
    // Pinia 尚未安装（理论上不会走到）：退化为纯路由标题
  }

  if (gate) {
    document.title = gate === 'setup' ? T.router.setupTitle : T.router.loginTitle
    return
  }

  const to = router.currentRoute.value
  const title = typeof to.meta.title === 'string' ? to.meta.title : ''
  document.title = title ? T.router.pageTitle(title) : T.router.brand
}

router.afterEach(() => {
  syncDocumentTitle()
})

export default router
