import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './database'

const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error ? reject(error) : resolve(result)),
    )
  })
}

export function tokensMatch(supplied: string, expected: string) {
  return timingSafeEqual(
    Buffer.from(hashToken(supplied), 'hex'),
    Buffer.from(hashToken(expected), 'hex'),
  )
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  return `scrypt:${salt}:${(await derivePassword(password, salt)).toString('hex')}`
}

export async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, encoded] = stored.split(':')
  if (algorithm !== 'scrypt' || !salt || !encoded) return false
  const actual = await derivePassword(password, salt)
  const expected = Buffer.from(encoded, 'hex')
  return expected.length === actual.length && timingSafeEqual(actual, expected)
}

export function getOwner(db: DatabaseSync): { email: string } | null {
  return (
    (db.prepare('SELECT email FROM owner WHERE id = 1').get() as { email: string } | undefined) ??
    null
  )
}

export function createOwner(db: DatabaseSync, email: string, passwordHash: string): boolean {
  return (
    db
      .prepare('INSERT OR IGNORE INTO owner (id, email, password_hash) VALUES (1, ?, ?)')
      .run(email, passwordHash).changes === 1
  )
}

export async function authenticate(db: DatabaseSync, email: string, password: string) {
  const owner = db.prepare('SELECT email, password_hash FROM owner WHERE id = 1').get() as
    { email: string; password_hash: string } | undefined
  if (!owner) return false
  const validPassword = await verifyPassword(password, owner.password_hash)
  return owner.email === email && validPassword
}

export function createSession(db: DatabaseSync, now = Date.now()) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = now + SESSION_DURATION
  transaction(db, () => {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
    db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run(
      hashToken(token),
      expiresAt,
    )
  })
  return { token, expiresAt }
}

export function sessionOwner(db: DatabaseSync, token: string | undefined, now = Date.now()) {
  if (!token || token.length > 128) return null
  const session = db
    .prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .get(hashToken(token), now)
  return session ? getOwner(db) : null
}

export function revokeSession(db: DatabaseSync, token: string | undefined) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
}

// Persist a single-owner login budget so restarts do not reset brute-force protection.
export function consumeAuthAttempt(db: DatabaseSync, key: string, now = Date.now()) {
  return transaction(db, () => {
    db.prepare('DELETE FROM rate_limits WHERE resets_at <= ?').run(now)
    const limit = db
      .prepare('SELECT attempts, resets_at FROM rate_limits WHERE key = ?')
      .get(key) as { attempts: number; resets_at: number } | undefined
    if (limit && limit.attempts >= 10) return Math.ceil((limit.resets_at - now) / 1000)
    db.prepare(
      `INSERT INTO rate_limits (key, attempts, resets_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1`,
    ).run(key, now + 15 * 60 * 1000)
    return 0
  })
}

export function resetOwner(db: DatabaseSync) {
  transaction(db, () =>
    db.exec('DELETE FROM sessions; DELETE FROM owner; DELETE FROM rate_limits;'),
  )
}
