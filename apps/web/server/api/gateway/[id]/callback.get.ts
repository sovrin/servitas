import { APP_COOKIE, exchangeAppGrant } from '@servitas/core'
import { platformDatabase } from '../../../utils/platform'
import { appURL, requireApp } from '../../../utils/apps'

export default defineEventHandler((event) => {
  const app = requireApp(getRouterParam(event, 'id')!)
  const url = new URL(appURL(app))
  // Only the app host may receive the host-only app cookie.
  if (getHeader(event, 'host') !== url.host)
    throw createError({ statusCode: 403, statusMessage: 'Open this link on the app host.' })
  const code = getQuery(event).code
  if (typeof code !== 'string' || code.length > 128)
    throw createError({ statusCode: 400, statusMessage: 'Invalid app access link.' })
  const session = exchangeAppGrant(platformDatabase(), app.id, code)
  if (!session)
    throw createError({
      statusCode: 401,
      statusMessage: 'This app access link expired. Open the app again from Servitas.',
    })
  setCookie(event, APP_COOKIE, session.token, {
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    path: '/',
    expires: new Date(session.expiresAt),
  })
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  return sendRedirect(event, '/')
})
