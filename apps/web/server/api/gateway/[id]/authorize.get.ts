import { APP_COOKIE, authorizeAppSession } from '@servitas/core'
import { platformDatabase, platformOrigin } from '../../../utils/platform'
import { requireApp } from '../../../utils/apps'

export default defineEventHandler((event) => {
  const app = requireApp(getRouterParam(event, 'id')!)
  if (authorizeAppSession(platformDatabase(), app.id, getCookie(event, APP_COOKIE)))
    return { allowed: true }
  return sendRedirect(event, `${platformOrigin()}/open/${app.id}`)
})
