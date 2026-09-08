import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  repositoryInspectionSchema,
  type RepositoryInspectionInput,
  type RepositoryInspection,
  type RepositoryConfiguration,
} from '@servitas/contracts/configuration'
import { transaction } from './database'
import { getJob, ownsLease, type ClaimedJob } from './jobs'
import { getApp } from './apps'

export function queueRepositoryInspection(db: DatabaseSync, input: RepositoryInspectionInput) {
  const request = repositoryInspectionSchema.parse(input)
  return transaction(db, () => {
    if (request.appId && !getApp(db, request.appId)) throw new Error('App not found.')
    const serialized = JSON.stringify(request)
    const active = db
      .prepare(
        `SELECT i.id FROM repository_inspections i JOIN jobs j ON j.id = i.id
      WHERE i.request = ? AND j.status IN ('queued','running')`,
      )
      .get(serialized) as { id: string } | undefined
    if (active) return getRepositoryInspection(db, active.id)!
    const id = randomUUID()
    const now = Date.now()
    const message = 'Waiting to read repository configuration.'
    db.prepare(
      `INSERT INTO jobs (id, kind, status, created_at, message) VALUES (?, 'repository.inspect', 'queued', ?, ?)`,
    ).run(id, now, message)
    db.prepare('INSERT INTO job_events (job_id, message, created_at) VALUES (?, ?, ?)').run(
      id,
      message,
      now,
    )
    db.prepare('INSERT INTO repository_inspections (id, request) VALUES (?, ?)').run(id, serialized)
    return getRepositoryInspection(db, id)!
  })
}

export function getRepositoryInspection(db: DatabaseSync, id: string): RepositoryInspection | null {
  const row = db
    .prepare('SELECT request, result FROM repository_inspections WHERE id = ?')
    .get(id) as { request: string; result: string | null } | undefined
  if (!row) return null
  return {
    job: getJob(db, id)!,
    request: JSON.parse(row.request),
    result: row.result ? JSON.parse(row.result) : null,
  }
}

export function repositoryCommit(db: DatabaseSync, id: string): string | null {
  return (
    db.prepare('SELECT source_commit FROM repository_inspections WHERE id = ?').get(id) as {
      source_commit: string | null
    }
  ).source_commit
}

export function recordRepositoryResult(
  db: DatabaseSync,
  claim: ClaimedJob,
  commit: string,
  result?: RepositoryConfiguration,
) {
  return transaction(db, () => {
    if (!ownsLease(db, claim)) return false
    db.prepare('UPDATE repository_inspections SET source_commit = ?, result = ? WHERE id = ?').run(
      commit,
      result ? JSON.stringify(result) : null,
      claim.job.id,
    )
    return true
  })
}
