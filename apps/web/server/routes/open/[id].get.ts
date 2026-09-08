import { createAppGrant, sessionOwner } from '@servitas/core'
import { SESSION_COOKIE } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'
import { appURL, requireApp } from '../../utils/apps'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  const id = getRouterParam(event, 'id')!
  const token = getCookie(event, SESSION_COOKIE)
  const db = platformDatabase()
  if (!sessionOwner(db, token))
    return sendRedirect(event, `/login?next=${encodeURIComponent(`/open/${id}`)}`)
  const app = requireApp(id)
  if (app.manifest.access === 'public') return sendRedirect(event, appURL(app))
  const code = createAppGrant(db, id, token!)
  return sendRedirect(event, `${appURL(app)}/_servitas/callback?code=${code}`)
})
