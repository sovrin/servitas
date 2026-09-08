import { getOwner, sessionOwner } from '@servitas/core'
import { SESSION_COOKIE } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'

export default defineEventHandler((event) => {
  const db = platformDatabase()
  return { setupRequired: !getOwner(db), owner: sessionOwner(db, getCookie(event, SESSION_COOKIE)) }
})
