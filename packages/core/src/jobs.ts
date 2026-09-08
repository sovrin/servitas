import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Job, JobEvent } from '@servitas/contracts'
import { transaction } from './database'

const fields = `id, kind, status, created_at AS createdAt, started_at AS startedAt,
  finished_at AS finishedAt, attempts, message, app_id AS appId`
export const LEASE_MS = 30_000
export interface ClaimedJob {
  job: Job
  leaseToken: string
}

export function listJobs(db: DatabaseSync, appId?: string): Job[] {
  return db
    .prepare(
      `SELECT ${fields} FROM jobs ${appId ? 'WHERE app_id = ?' : ''} ORDER BY created_at DESC, rowid DESC LIMIT 50`,
    )
    .all(...(appId ? [appId] : [])) as unknown as Job[]
}

export function getJob(db: DatabaseSync, id: string): Job | null {
  return (
    (db.prepare(`SELECT ${fields} FROM jobs WHERE id = ?`).get(id) as unknown as Job | undefined) ??
    null
  )
}

export function jobEvents(db: DatabaseSync, id: string): JobEvent[] {
  return db
    .prepare(
      'SELECT id, job_id AS jobId, message, created_at AS createdAt FROM job_events WHERE job_id = ? ORDER BY id',
    )
    .all(id) as unknown as JobEvent[]
}

function event(db: DatabaseSync, id: string, message: string, now: number) {
  db.prepare('INSERT INTO job_events (job_id, message, created_at) VALUES (?, ?, ?)').run(
    id,
    message,
    now,
  )
}

export function enqueuePlatformCheck(db: DatabaseSync, now = Date.now()): Job {
  return transaction(db, () => {
    const active = db
      .prepare(
        `SELECT ${fields} FROM jobs WHERE kind = 'platform.check' AND status IN ('queued', 'running') LIMIT 1`,
      )
      .get() as unknown as Job | undefined
    if (active) return active
    const id = randomUUID()
    const message = 'Waiting for the worker.'
    db.prepare(
      "INSERT INTO jobs (id, kind, status, created_at, message) VALUES (?, 'platform.check', 'queued', ?, ?)",
    ).run(id, now, message)
    event(db, id, message, now)
    return getJob(db, id)!
  })
}

export function claimJob(db: DatabaseSync, now = Date.now()): ClaimedJob | null {
  return transaction(db, () => {
    const expired = db
      .prepare(
        "SELECT id FROM jobs WHERE status = 'running' AND lease_until <= ? AND attempts >= 3",
      )
      .all(now) as { id: string }[]
    for (const { id } of expired) {
      const message = 'The worker was interrupted repeatedly. Retry the operation.'
      db.prepare(
        "UPDATE jobs SET status = 'failed', finished_at = ?, message = ?, lease_token = NULL, lease_until = NULL WHERE id = ?",
      ).run(now, message, id)
      event(db, id, message, now)
      db.prepare(
        `UPDATE app_revisions SET requires_recovery = CASE WHEN phase IN ('maintenance','started') AND
        (json_array_length(manifest, '$.volumes') > 0 OR json_array_length(previous, '$.manifest.volumes') > 0) THEN 1 ELSE requires_recovery END,
        phase = CASE WHEN phase = 'applied' THEN phase ELSE 'failed' END WHERE id = ?`,
      ).run(id)
      db.prepare(
        `UPDATE apps SET status = CASE WHEN EXISTS (SELECT 1 FROM backup_operations WHERE id = ? AND phase = 'applied') OR EXISTS (SELECT 1 FROM app_revisions WHERE id = ? AND
        (phase = 'applied' OR (requires_recovery = 0 AND apps.status = 'running'))) THEN status ELSE 'failed' END,
        message = ? WHERE id = (SELECT app_id FROM jobs WHERE id = ?)`,
      ).run(id, id, message, id)
    }
    // Let the worker clean up helpers from terminal operations before claiming new app work.
    if (expired.length) return null
    const next = db
      .prepare(
        `SELECT id FROM jobs WHERE status = 'queued' OR (status = 'running' AND lease_until <= ?) ORDER BY created_at LIMIT 1`,
      )
      .get(now) as { id: string } | undefined
    if (!next) return null
    const leaseToken = randomUUID()
    db.prepare(
      `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), attempts = attempts + 1,
      lease_token = ?, lease_until = ?, message = 'Worker started the operation.' WHERE id = ?`,
    ).run(now, leaseToken, now + LEASE_MS, next.id)
    event(db, next.id, 'Worker started the operation.', now)
    return { job: getJob(db, next.id)!, leaseToken }
  })
}

export function ownsLease(db: DatabaseSync, claim: ClaimedJob, now = Date.now()) {
  return !!db
    .prepare(
      "SELECT 1 FROM jobs WHERE id = ? AND lease_token = ? AND status = 'running' AND lease_until > ?",
    )
    .get(claim.job.id, claim.leaseToken, now)
}

export function renewLease(db: DatabaseSync, claim: ClaimedJob, now = Date.now()) {
  return (
    db
      .prepare(
        "UPDATE jobs SET lease_until = ? WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until > ?",
      )
      .run(now + LEASE_MS, claim.job.id, claim.leaseToken, now).changes === 1
  )
}

export function reportProgress(
  db: DatabaseSync,
  claim: ClaimedJob,
  message: string,
  now = Date.now(),
) {
  return transaction(db, () => {
    const changed =
      db
        .prepare(
          "UPDATE jobs SET message = ? WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until > ?",
        )
        .run(message, claim.job.id, claim.leaseToken, now).changes === 1
    if (changed) event(db, claim.job.id, message, now)
    return changed
  })
}

export function finishJob(
  db: DatabaseSync,
  claim: ClaimedJob,
  status: 'succeeded' | 'failed',
  message: string,
  now = Date.now(),
) {
  return transaction(db, () => {
    const changed =
      db
        .prepare(
          `UPDATE jobs SET status = ?, message = ?, finished_at = ?, lease_token = NULL, lease_until = NULL
      WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until > ?`,
        )
        .run(status, message, now, claim.job.id, claim.leaseToken, now).changes === 1
    if (changed) event(db, claim.job.id, message, now)
    return changed
  })
}

export function heartbeat(db: DatabaseSync, now = Date.now()) {
  db.prepare(
    'INSERT INTO worker_heartbeat (id, last_seen_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at',
  ).run(now)
}

export function workerStatus(db: DatabaseSync, now = Date.now()) {
  const row = db.prepare('SELECT last_seen_at FROM worker_heartbeat WHERE id = 1').get() as
    { last_seen_at: number } | undefined
  return { online: !!row && now - row.last_seen_at < 15_000, lastSeenAt: row?.last_seen_at ?? null }
}
