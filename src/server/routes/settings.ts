/**
 * 设置读写。
 *
 * 部分设置变更需要通知后台服务重设调度（如采样频率），
 * 否则用户改了设置要重启进程才生效。
 */
import { Hono } from 'hono'
import { jsonBody } from '../middleware/validate'
import { HttpError } from '../middleware/error'
import { SettingsPatchSchema } from '@shared/schemas'
import {
  getAllSettings,
  getSetting,
  patchSettings,
  reservedSettingKeys,
} from '../services/settings'
import { monitor } from '../services/monitor'

/** 改动这些前缀下的键需要让对应的后台服务重新读取配置 */
const MONITOR_KEYS = /^monitor\./

export const settingsRoutes = new Hono()
  .get('/', (c) => c.json(getAllSettings()))

  .patch('/', jsonBody(SettingsPatchSchema), (c) => {
    const patch = c.req.valid('json')

    // 认证相关键只能走 /api/auth/*（见 services/settings 的 AUTH_RESERVED_KEYS）
    const reserved = reservedSettingKeys(patch)
    if (reserved.length > 0) {
      throw new HttpError(
        400,
        'RESERVED_KEY',
        `这些设置项不能通过设置接口修改：${reserved.join('、')}`,
        { keys: reserved },
      )
    }

    patchSettings(patch)

    if (Object.keys(patch).some((k) => MONITOR_KEYS.test(k))) {
      monitor.applySettings({
        intervalMs: getSetting('monitor.interval'),
        hiddenIntervalMs: getSetting('monitor.hiddenInterval'),
      })
    }

    return c.json(getAllSettings())
  })
