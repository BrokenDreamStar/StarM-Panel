/**
 * 应用版本号。
 *
 * 唯一来源是 package.json 的 `version`：构建产物文件名（scripts/build.ts）、
 * `--version`、`/healthz`、bootstrap 与「关于」页都从这里取，
 * 避免版本号在多处硬编码后各说各话。
 *
 * JSON import 在 Bun（开发 / 单文件编译）与 Vite（前端构建）里都成立，
 * 因此放在 src/shared 下也不会破坏同构约束。
 */
import { version } from '../../package.json'

export const APP_VERSION: string = version

/**
 * 构建期注入的发布标识（GitHub Release 的 tag，如 `v0.1.0-5`）。
 *
 * 「有没有新版本」不能只看 package.json：发布 tag 是
 * `v<version>-<运行序号>`（见 .github/workflows/release.yml），
 * 同一个版本号可以发很多次，必须带上运行序号才比得出来。
 * scripts/build.ts 用 `bun build --define` 把 tag 直接写进产物；
 * 开发模式 / 前端构建没有这个常量，`typeof` 判断后回落 null。
 */
declare const __STARM_RELEASE__: string | undefined

export const RELEASE_TAG: string | null =
  typeof __STARM_RELEASE__ === 'string' && __STARM_RELEASE__ !== '' ? __STARM_RELEASE__ : null
