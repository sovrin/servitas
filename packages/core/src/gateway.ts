import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './database'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const APP_COOKIE = 'servitas_app_session'
export function createAppGrant(
  db: DatabaseSync,
  appId: string,
  ownerToken: string,
  now = Date.now(),
) {
  return transaction(db, () => {
    const session = db
      .prepare('SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?')
      .get(hash(ownerToken), now)
    if (!session) throw new Error('Sign in to open this app.')
    db.prepare('DELETE FROM app_grants WHERE expires_at <= ?').run(now)
    const token = randomBytes(32).toString('base64url')
    db.prepare('INSERT INTO app_grants VALUES (?, ?, ?, ?)').run(
      hash(token),
      appId,
      hash(ownerToken),
      now + 60_000,
    )
    return token
  })
}
export function exchangeAppGrant(db: DatabaseSync, appId: string, code: string, now = Date.now()) {
  return transaction(db, () => {
    const grant = db
      .prepare(
        'DELETE FROM app_grants WHERE token_hash = ? AND app_id = ? AND expires_at > ? RETURNING session_hash',
      )
      .get(hash(code), appId, now) as { session_hash: string } | undefined
    if (!grant) return null
    const ownerSession = db
      .prepare('SELECT expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?')
      .get(grant.session_hash, now) as { expires_at: number } | undefined
    if (!ownerSession) return null
    const token = randomBytes(32).toString('base64url')
    const expiresAt = Math.min(ownerSession.expires_at, now + 24 * 60 * 60 * 1000)
    db.prepare('DELETE FROM app_sessions WHERE expires_at <= ?').run(now)
    db.prepare('INSERT INTO app_sessions VALUES (?, ?, ?, ?)').run(
      hash(token),
      appId,
      grant.session_hash,
      expiresAt,
    )
    return { token, expiresAt }
  })
}
export function authorizeAppSession(
  db: DatabaseSync,
  appId: string,
  token: string | undefined,
  now = Date.now(),
) {
  if (!token || token.length > 128) return false
  return !!db
    .prepare(
      `SELECT 1 FROM app_sessions a JOIN sessions s ON s.token_hash = a.session_hash WHERE a.token_hash = ? AND a.app_id = ? AND a.expires_at > ? AND s.expires_at > ?`,
    )
    .get(hash(token), appId, now, now)
}
