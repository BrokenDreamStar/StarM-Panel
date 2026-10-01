/**
 * 设置读写。
 *
 * 部分设置变更需要通知后台服务重设调度（采样频率、探测周期等），
 * 否则用户改了设置要重启进程才生效。
 */
import { Hono } from 'hono'
import { jsonBody } from '../middleware/validate'
import { SettingsPatchSchema } from '@shared/schemas'
import { getAllSettings, getSetting, patchSettings } from '../services/settings'
import { monitor } from '../services/monitor'
import { probe } from '../services/probe'

/** 改动这些前缀下的键需要让对应的后台服务重新读取配置 */
const MONITOR_KEYS = /^monitor\./
const PROBE_KEYS = /^network\./

export const settingsRoutes = new Hono()
  .get('/', (c) => c.json(getAllSettings()))

  .patch('/', jsonBody(SettingsPatchSchema), (c) => {
    const patch = c.req.valid('json')
    patchSettings(patch)

    if (Object.keys(patch).some((k) => MONITOR_KEYS.test(k))) {
      monitor.applySettings({
        intervalMs: getSetting('monitor.interval'),
        hiddenIntervalMs: getSetting('monitor.hiddenInterval'),
        gpuEnabled: getSetting('monitor.gpuEnabled'),
        gpuIntervalMs: getSetting('monitor.gpuInterval'),
      })
    }

    if (Object.keys(patch).some((k) => PROBE_KEYS.test(k))) {
      probe.applySettings()
    }

    return c.json(getAllSettings())
  })
