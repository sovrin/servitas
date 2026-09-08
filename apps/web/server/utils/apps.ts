import { appOrigin, getApp, encryptionKey } from '@servitas/core'
import { platformDatabase } from './platform'

export function requireApp(id: string) {
  const app = getApp(platformDatabase(), id)
  if (!app || app.status === 'removed')
    throw createError({ statusCode: 404, statusMessage: 'App not found.' })
  return app
}
export function appURL(app: { name: string }) {
  const origin = process.env.SERVITAS_APPS_ORIGIN
  if (!origin)
    throw createError({
      statusCode: 503,
      statusMessage: 'App routing must be configured in the platform installation.',
    })
  return appOrigin(app, origin)
}
export function platformKey() {
  return encryptionKey(process.env.SERVITAS_DATA_DIR!)
}
