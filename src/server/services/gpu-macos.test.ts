/**
 * macOS IORegistry GPU 指标解析的单测。
 *
 * 覆盖两类真实形态：
 *   - Apple Silicon（AGXAccelerator）：`Device Utilization %` + `In use system memory`，
 *     统一内存没有总量；
 *   - Intel / AMD 核显独显：老驱动用 `GPU Activity(%)` + `vramUsedBytes/vramTotalBytes`；
 *   - 没有 PerformanceStatistics 的 IOAccelerator 桩服务必须被跳过（不能算一块 GPU）。
 */
import { describe, expect, test } from 'bun:test'
import { parseIoregGpuStats } from './gpu-macos'

/** 取自 Apple M2 实机输出（截断无关属性） */
const APPLE_SAMPLE = `
+-o AGXAcceleratorG14G  <class AGXAcceleratorG14G, id 0x10000044a, registered, matched, active>
    {
      "MetalPluginName" = "AGXMetalG14G"
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=6172655616,"Tiler Utilization %"=20,"Renderer Utilization %"=19,"Device Utilization %"=20,"In use system memory"=569737216}
      "model" = "Apple M2"
      "gpu-core-count" = 8
    }
`

const MULTI_SAMPLE = `
+-o AGXAcceleratorG14G  <class AGXAcceleratorG14G, id 0x1>
    {
      "PerformanceStatistics" = {"Device Utilization %"=20,"In use system memory"=569737216}
      "model" = "Apple M2"
    }
+-o AMDRadeonX6000_AmdAccelerator  <class AMDRadeonX6000_AmdAccelerator, id 0x2>
    {
      "PerformanceStatistics" = {"GPU Activity(%)"=7,"vramUsedBytes"=1048576,"vramTotalBytes"=8589934592}
      "model" = "Radeon Pro 5500M"
    }
+-o IOAccelerator  <class IOAccelerator, id 0x3>
    {
      "IOClass" = "IOAccelerator"
    }
`

describe('parseIoregGpuStats', () => {
  test('Apple Silicon：解析使用率与共享内存已用，总量为 null', () => {
    expect(parseIoregGpuStats(APPLE_SAMPLE)).toEqual([
      {
        model: 'Apple M2',
        utilization: 20,
        memoryUsed: 569737216,
        memoryTotal: null,
      },
    ])
  })

  test('多 GPU：按出现顺序返回，兼容 AMD 的别名键名', () => {
    const stats = parseIoregGpuStats(MULTI_SAMPLE)
    expect(stats).toHaveLength(2)
    expect(stats[0]).toMatchObject({ model: 'Apple M2', utilization: 20, memoryTotal: null })
    expect(stats[1]).toEqual({
      model: 'Radeon Pro 5500M',
      utilization: 7,
      memoryUsed: 1048576,
      memoryTotal: 8589934592,
    })
  })

  test('没有 PerformanceStatistics 的服务被跳过', () => {
    expect(parseIoregGpuStats(MULTI_SAMPLE)).toHaveLength(2)
  })

  test('空输入 / 垃圾输入返回空数组而不抛错', () => {
    expect(parseIoregGpuStats('')).toEqual([])
    expect(parseIoregGpuStats('not an ioreg dump')).toEqual([])
  })

  test('全 0 也是有效读数（空闲 GPU），不能当成缺失', () => {
    const idle = `
+-o AGXAcceleratorG14G  <class AGXAcceleratorG14G, id 0x1>
    {
      "PerformanceStatistics" = {"Device Utilization %"=0,"In use system memory"=0}
      "model" = "Apple M2"
    }
`
    expect(parseIoregGpuStats(idle)[0]).toMatchObject({ utilization: 0, memoryUsed: 0 })
  })
})
