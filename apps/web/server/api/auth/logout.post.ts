import { revokeSession } from '@servitas/core'
import { SESSION_COOKIE } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'

export default defineEventHandler((event) => {
  revokeSession(platformDatabase(), getCookie(event, SESSION_COOKIE))
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
  return { ok: true }
})
