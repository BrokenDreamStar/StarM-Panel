import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { title: '桌面' },
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

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : ''
  document.title = title ? `${title} · StarM Panel` : 'StarM Panel'
})

export default router
