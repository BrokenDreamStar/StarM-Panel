/**
 * 运行时长格式化的单测。
 *
 * 两种口径必须分开：卡片用 fmtUptime（省秒、只给量级），
 * 关于页用 fmtUptimeFull（保留秒、只吞高位 0 段）。
 * 边界集中在「进位」和「脏数据」两处：59/60 秒、23/24 小时都要落在正确的段上。
 */
import { describe, expect, test } from 'bun:test'
import { fmtUptime, fmtUptimeFull } from './format'

describe('fmtUptime（卡片：省秒）', () => {
  test('按量级取最长的两段', () => {
    expect(fmtUptime(45)).toBe('0 分')
    expect(fmtUptime(600)).toBe('10 分')
    expect(fmtUptime(5207)).toBe('1 小时 26 分')
    expect(fmtUptime(90061)).toBe('1 天 1 小时')
  })

  test('脏数据给 —', () => {
    expect(fmtUptime(null)).toBe('—')
    expect(fmtUptime(undefined)).toBe('—')
    expect(fmtUptime(Number.NaN)).toBe('—')
    expect(fmtUptime(-1)).toBe('—')
  })
})

describe('fmtUptimeFull（关于：天时分秒）', () => {
  test('用户报的 5207 秒', () => {
    expect(fmtUptimeFull(5207)).toBe('1 小时 26 分 47 秒')
  })

  test('高位为 0 的段不补位，秒始终保留', () => {
    expect(fmtUptimeFull(0)).toBe('0 秒')
    expect(fmtUptimeFull(47)).toBe('47 秒')
    expect(fmtUptimeFull(60)).toBe('1 分 0 秒')
    expect(fmtUptimeFull(3600)).toBe('1 小时 0 分 0 秒')
  })

  test('跨天时四段齐全', () => {
    expect(fmtUptimeFull(86400)).toBe('1 天 0 小时 0 分 0 秒')
    expect(fmtUptimeFull(90061)).toBe('1 天 1 小时 1 分 1 秒')
    expect(fmtUptimeFull(3 * 86400 + 5 * 3600)).toBe('3 天 5 小时 0 分 0 秒')
  })

  test('边界进位', () => {
    expect(fmtUptimeFull(59)).toBe('59 秒')
    expect(fmtUptimeFull(3599)).toBe('59 分 59 秒')
    expect(fmtUptimeFull(86399)).toBe('23 小时 59 分 59 秒')
  })

  test('小数向下取整，脏数据给 —', () => {
    expect(fmtUptimeFull(59.9)).toBe('59 秒')
    expect(fmtUptimeFull(null)).toBe('—')
    expect(fmtUptimeFull(undefined)).toBe('—')
    expect(fmtUptimeFull(Number.NaN)).toBe('—')
    expect(fmtUptimeFull(-1)).toBe('—')
  })
})
