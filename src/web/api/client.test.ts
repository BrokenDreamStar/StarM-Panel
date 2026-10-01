/**
 * API 客户端的请求头构造测试。
 *
 * 这个文件存在的唯一理由是固化一条踩过的坑：
 * 对 FormData 显式设置 `content-type: application/json` 会让浏览器不再生成
 * multipart boundary，服务端解析不出任何字段，图标上传静默失效（实测 400 NO_FILE）。
 * 该 bug 曾经真实存在于 request() 里。
 */
import { describe, expect, test } from 'bun:test'
import { buildHeaders } from './client'

describe('buildHeaders', () => {
  test('字符串 body（JSON）带 application/json', () => {
    const h = buildHeaders({ method: 'POST', body: JSON.stringify({ a: 1 }) })
    expect(h['content-type']).toBe('application/json')
  })

  test('FormData body 绝不带 content-type（否则 boundary 丢失）', () => {
    const form = new FormData()
    form.append('kind', 'icon')
    const h = buildHeaders({ method: 'POST', body: form })
    expect(h['content-type']).toBeUndefined()
  })

  test('无 body 时不带 content-type', () => {
    expect(buildHeaders({ method: 'GET' })['content-type']).toBeUndefined()
    expect(buildHeaders()['content-type']).toBeUndefined()
  })

  test('调用方显式传入的 headers 优先', () => {
    const h = buildHeaders({
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/vnd.custom+json', 'x-token': 'abc' },
    })
    expect(h['content-type']).toBe('application/vnd.custom+json')
    expect(h['x-token']).toBe('abc')
  })
})
