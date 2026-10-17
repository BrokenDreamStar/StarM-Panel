/**
 * 统一错误处理。
 *
 * HttpError 用于在业务代码里抛出带状态码与错误码的异常；
 * 其余未捕获异常一律 500 且不泄漏堆栈给客户端（只打日志）。
 */
import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import type { ApiError } from '@shared/types'
import { ZodError } from 'zod'

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    /** 需要一并写回的响应头（如 429 的 Retry-After） */
    public readonly headers?: Record<string, string>,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function body(code: string, message: string, details?: unknown): ApiError {
  return { error: { code, message, ...(details !== undefined && { details }) } }
}

export const onError: ErrorHandler = (err, c: Context) => {
  if (err instanceof HttpError) {
    for (const [name, value] of Object.entries(err.headers ?? {})) c.header(name, value)
    return c.json(body(err.code, err.message, err.details), err.status as 400)
  }

  if (err instanceof ZodError) {
    return c.json(
      body(
        'VALIDATION_ERROR',
        '请求参数校验失败',
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      ),
      400,
    )
  }

  // 未知异常：记录完整堆栈，但不外泄
  console.error('[error]', err)
  return c.json(body('INTERNAL_ERROR', '服务端内部错误，请查看服务端日志'), 500)
}

export const notFound: NotFoundHandler = (c) =>
  c.json(body('NOT_FOUND', `没有匹配的路由：${c.req.path}`), 404)
