/**
 * API 客户端的请求头构造测试。
 *
 * 这个文件存在的唯一理由是固化一条踩过的坑：
 * 对 FormData 显式设置 `content-type: application/json` 会让浏览器不再生成
 * multipart boundary，服务端解析不出任何字段，图标上传静默失效（实测 400 NO_FILE）。
 * 该 bug 曾经真实存在于 request() 里。
 *
 * 备份文件名解析也放在这里：它同样是「格式上的坑」，且是纯函数。
 */
import { describe, expect, test } from 'bun:test'
import { buildHeaders, parseDispositionFilename } from './client'

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

describe('parseDispositionFilename', () => {
  test('普通 filename 形式', () => {
    expect(
      parseDispositionFilename('attachment; filename="starm-panel-backup-2025-01-01.json"'),
    ).toBe('starm-panel-backup-2025-01-01.json')
  })

  test('filename 不带引号也认', () => {
    expect(parseDispositionFilename('attachment; filename=backup.json')).toBe('backup.json')
  })

  test('RFC 5987 的 filename* 会解码', () => {
    expect(
      parseDispositionFilename(
        "attachment; filename*=UTF-8''starm-panel-%E5%A4%87%E4%BB%BD.json",
      ),
    ).toBe('starm-panel-备份.json')
  })

  test('缺响应头 / 缺字段时返回 null，由调用方兜底', () => {
    expect(parseDispositionFilename(null)).toBeNull()
    expect(parseDispositionFilename('attachment')).toBeNull()
    expect(parseDispositionFilename('')).toBeNull()
  })

  test('编码损坏时不抛异常（回落到普通形式或 null）', () => {
    expect(parseDispositionFilename("attachment; filename*=UTF-8''%E4%B8")).toBeNull()
  })
})
