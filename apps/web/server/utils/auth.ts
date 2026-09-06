import type { H3Event } from 'h3'
import { consumeAuthAttempt, createSession, sessionOwner } from '@servitas/core'
import { platformDatabase, platformOrigin } from './platform'

export const SESSION_COOKIE = 'servitas_session'

export function requireOwner(event: H3Event) {
  const owner = sessionOwner(platformDatabase(), getCookie(event, SESSION_COOKIE))
  if (!owner) throw createError({ statusCode: 401, statusMessage: 'Sign in to continue.' })
  return owner
}

export function setOwnerSession(event: H3Event) {
  const session = createSession(platformDatabase())
  setCookie(event, SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: platformOrigin().startsWith('https:'),
    sameSite: 'strict',
    path: '/',
    expires: new Date(session.expiresAt),
  })
}

export function checkAuthRate(event: H3Event, key: string) {
  const retryAfter = consumeAuthAttempt(platformDatabase(), key)
  if (retryAfter) {
    setHeader(event, 'Retry-After', retryAfter)
    throw createError({
      statusCode: 429,
      statusMessage: 'Too many attempts. Try again in 15 minutes.',
    })
  }
}
