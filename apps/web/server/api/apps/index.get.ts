import { listApps } from '@servitas/core'
import { requireOwner } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'
import { appURL } from '../../utils/apps'

export default defineEventHandler((event) => {
  requireOwner(event)
  const enabled = !!process.env.SERVITAS_APPS_ORIGIN
  return {
    enabled,
    apps: listApps(platformDatabase()).map(({ logs, ...app }) => ({
      ...app,
      url: enabled ? appURL(app) : null,
    })),
  }
})
