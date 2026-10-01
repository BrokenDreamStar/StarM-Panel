/**
 * 校验中间件。
 *
 * 不直接用 `@hono/zod-validator` 的默认行为：它失败时自行返回
 * `{ success: false, error: ZodError }`，绕过了 middleware/error.ts 的统一
 * 错误格式。这里包一层，把校验失败转成 HttpError，让全局 onError 统一出参。
 */
import { zValidator } from '@hono/zod-validator'
import type { ZodType } from 'zod'
import { HttpError } from './error'

export function jsonBody<T extends ZodType>(schema: T) {
  return zValidator('json', schema, (result) => {
    if (!result.success) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        '请求参数校验失败',
        result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      )
    }
  })
}
