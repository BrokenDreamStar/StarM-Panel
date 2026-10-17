<script setup lang="ts">
/**
 * 管理员登录 / 首启设置密码。
 *
 * 两种形态共用一张卡片，由 auth store 的 status 决定：
 *   - `setup`  首次启动（或 `--reset-auth` 之后）：设定管理员密码 + 确认
 *   - `locked` 已设密码：输入密码登录
 *
 * 三个刻意的设计取舍：
 *   1. **只有密码，没有用户名** —— 单实例单管理员，用户名不承载任何信息，
 *      多一个输入框只会让人以为存在多账号（见 docs/DESIGN.md §1.2）。
 *   2. 密码规则用 `@shared/schemas` 的 PasswordSchema 本地先校验，
 *      文案与后端完全一致（后端仍会再校验一次，前端只是省一次往返）。
 *   3. 设置项全部来自 localStorage 缓存（登录前拿不到服务端设置），
 *      所以标题、主题、卡片材质在登录页与登录后保持一致，不会闪一下。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NInput, NSpin } from 'naive-ui'
import { PasswordSchema } from '@shared/schemas'
import { TEXT as T } from '@shared/text'
import { syncDocumentTitle } from '@/router'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'
import FaviconGlyph from '@/components/FaviconGlyph.vue'

const auth = useAuthStore()
const settings = useSettingsStore()

const password = ref('')
const confirm = ref('')
/** 本地校验提示（与后端同一套规则 + 两次输入一致性） */
const localError = ref<string | null>(null)
const inputRef = ref<InstanceType<typeof NInput> | null>(null)

const isSetup = computed(() => auth.status === 'setup')
const title = computed(() => settings.get('ui.title') || T.router.brand)
const submitLabel = computed(() => (isSetup.value ? T.login.submitSetup : T.login.submitLogin))

/** 限流倒计时（429 之后按钮禁用，避免无效重试把窗口越推越长） */
const lockSeconds = ref(0)
let lockTimer: ReturnType<typeof setInterval> | null = null

function startLockCountdown(seconds: number): void {
  stopLockCountdown()
  lockSeconds.value = seconds
  lockTimer = setInterval(() => {
    lockSeconds.value -= 1
    if (lockSeconds.value <= 0) stopLockCountdown()
  }, 1000)
}

function stopLockCountdown(): void {
  if (lockTimer !== null) clearInterval(lockTimer)
  lockTimer = null
  lockSeconds.value = 0
}

function formatWait(seconds: number): string {
  if (seconds < 60) return T.login.waitSeconds(seconds)
  const m = Math.ceil(seconds / 60)
  return T.login.waitMinutes(m)
}

/** 限流提示：整句都来自文案表，模板里只插值一次 */
const lockNotice = computed(() => T.login.tooManyAttempts(formatWait(lockSeconds.value)))

/** 密码规则校验：直接复用后端 schema，文案不会两边漂移 */
function checkPassword(value: string): string | null {
  const result = PasswordSchema.safeParse(value)
  if (result.success) return null
  return result.error.issues[0]?.message ?? T.common.passwordInvalid
}

async function submit(): Promise<void> {
  if (auth.busy || lockSeconds.value > 0) return
  localError.value = null

  if (isSetup.value) {
    const problem = checkPassword(password.value)
    if (problem) {
      localError.value = problem
      return
    }
    if (password.value !== confirm.value) {
      localError.value = T.common.passwordMismatch
      return
    }
    if (await auth.setup(password.value)) password.value = confirm.value = ''
    return
  }

  if (!password.value) {
    localError.value = T.login.passwordRequired
    return
  }
  if (await auth.login(password.value)) password.value = ''
}

/** 输入变化即清掉上一次的报错，否则改对了还挂着红字 */
function onInput(): void {
  localError.value = null
  auth.clearError()
}

// 后端限流 → 本地倒计时（刷新页面后由 auth.lockedForSec 续上）
watch(
  () => auth.lockedForSec,
  (sec) => {
    if (sec && sec > 0) startLockCountdown(sec)
  },
  { immediate: true },
)

const shownError = computed(() => localError.value ?? auth.error)

/**
 * 标签页标题：登录 / 锁屏不经过路由变化，路由的 afterEach 不会主动触发，
 * 所以这里自己同步一次（标题规则统一在 router 的 syncDocumentTitle 里）。
 */
watch(isSetup, () => syncDocumentTitle(), { immediate: true })

onMounted(async () => {
  await nextTick()
  inputRef.value?.focus()
})

onUnmounted(stopLockCountdown)
</script>

<template>
  <div class="lock-mask">
    <!-- 登录页的装饰光斑：不依赖任何需要鉴权的资源（壁纸接口也在门禁之后） -->
    <div class="glow" aria-hidden="true" />

    <form class="lock-card" @submit.prevent="submit">
      <!-- 卡片头只有标题：不配图标，也不写任何说明文案 —— 图标和
           「保持 7 天 / 请输入密码」之类的旁白都只会分走对输入框的注意力 -->
      <h1 class="app-title">{{ title }}</h1>

      <label class="field-label" for="starm-password">
        {{ isSetup ? T.login.newPasswordLabel : T.login.passwordLabel }}
      </label>
      <NInput
        id="starm-password"
        ref="inputRef"
        v-model:value="password"
        type="password"
        show-password-on="click"
        size="large"
        :maxlength="128"
        :disabled="lockSeconds > 0"
        :placeholder="isSetup ? T.login.passwordSetupPlaceholder : T.login.passwordPlaceholder"
        @input="onInput"
        @keyup.enter="submit"
      />

      <template v-if="isSetup">
        <label class="field-label" for="starm-password-confirm">{{ T.login.confirmLabel }}</label>
        <NInput
          id="starm-password-confirm"
          v-model:value="confirm"
          type="password"
          show-password-on="click"
          size="large"
          :maxlength="128"
          :placeholder="T.login.confirmPlaceholder"
          @input="onInput"
          @keyup.enter="submit"
        />
      </template>

      <p v-if="shownError" class="err" role="alert">
        <FaviconGlyph name="close-circle" :size="14" />
        <span>{{ shownError }}</span>
      </p>
      <p v-else-if="lockSeconds > 0" class="err" role="alert">
        {{ lockNotice }}
      </p>

      <NButton
        class="submit"
        type="primary"
        size="large"
        attr-type="submit"
        :loading="auth.busy"
        :disabled="lockSeconds > 0"
        @click="submit"
      >
        {{ lockSeconds > 0 ? T.login.waiting(lockSeconds) : submitLabel }}
      </NButton>

      <NSpin v-if="auth.status === 'loading'" size="small" class="foot-spin" />
    </form>
  </div>
</template>

<style scoped>
/* 铺满整屏、盖住后面的桌面（未登录时桌面本来也没数据，但避免闪一下骨架屏） */
.lock-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
}

/* 装饰光斑：纯 CSS，不请求任何鉴权资源 */
.glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    radial-gradient(760px 420px at 20% 10%, color-mix(in srgb, var(--accent) 26%, transparent), transparent 62%),
    radial-gradient(680px 420px at 84% 92%, var(--wp-3), transparent 64%);
}

.lock-card {
  position: relative;
  width: min(400px, 100%);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-6) var(--sp-6) var(--sp-5);
  border-radius: var(--r-xl);
  background: var(--surface);
  backdrop-filter: var(--glass);
  box-shadow: var(--shadow-3);
}

.app-title {
  margin: 0 0 var(--sp-2);
  font-size: 28px;
  font-weight: 650;
  line-height: 1.1;
  letter-spacing: -0.02em;
  text-align: center;
  color: var(--text);
}

.field-label {
  margin-top: var(--sp-2);
  font-size: 12px;
  color: var(--text-2);
}

.err {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: var(--sp-3) 0 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  font-size: 12px;
  color: var(--err);
  background: color-mix(in srgb, var(--err) 14%, transparent);
}

.submit {
  margin-top: var(--sp-4);
}

.foot-spin {
  align-self: center;
  margin-top: var(--sp-2);
}
</style>
