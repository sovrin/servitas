import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(resolve(dataDir, 'servitas.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  transaction(db, () => {
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    if (version > 1) throw new Error('This database requires a newer version of Servitas.')
    if (version === 1) return
    db.exec(`
      CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK (id = 1), email TEXT NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, resets_at INTEGER NOT NULL);
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind = 'platform.check'),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER,
        message TEXT NOT NULL
      );
      CREATE INDEX jobs_pending ON jobs(status, created_at);
      CREATE TABLE job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
        message TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE worker_heartbeat (id INTEGER PRIMARY KEY CHECK (id = 1), last_seen_at INTEGER NOT NULL);
      PRAGMA user_version = 1;
    `)
  })
  return db
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
