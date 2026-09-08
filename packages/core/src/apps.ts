import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CreateAppInput, HostedApp, Job } from '@servitas/contracts'
import { transaction } from './database'
import { getJob, ownsLease, type ClaimedJob } from './jobs'
import { openEnvironment, sealEnvironment } from './secrets'

const fields = `id, name, manifest, environment_names AS environmentNames, status, desired_state AS desiredState, created_at AS createdAt,
container_id AS containerId, container_name AS containerName, volume_set AS volumeSet, generation, image_id AS imageId, source_commit AS "commit", message, logs, logs_at AS logsAt, last_seen_at AS lastSeenAt`
type AppRow = Omit<HostedApp, 'manifest' | 'environmentNames'> & {
  manifest: string
  environmentNames: string
}
function parseApp(row: AppRow): HostedApp {
  const manifest = JSON.parse(row.manifest)
  return { ...row, manifest, environmentNames: JSON.parse(row.environmentNames) }
}
export function listApps(db: DatabaseSync, includeRemoved = false): HostedApp[] {
  return (
    db
      .prepare(
        `SELECT ${fields} FROM apps ${includeRemoved ? '' : "WHERE status != 'removed'"} ORDER BY created_at DESC`,
      )
      .all() as unknown as AppRow[]
  ).map(parseApp)
}
export function getApp(db: DatabaseSync, id: string): HostedApp | null {
  const row = db.prepare(`SELECT ${fields} FROM apps WHERE id = ?`).get(id) as unknown as
    AppRow | undefined
  return row ? parseApp(row) : null
}
export function appEnvironment(db: DatabaseSync, id: string, key: Buffer) {
  const row = db.prepare('SELECT environment FROM apps WHERE id = ?').get(id) as
    { environment: string } | undefined
  if (!row) throw new Error('App not found.')
  return openEnvironment(row.environment, key)
}
export function insertAppJob(db: DatabaseSync, appId: string, kind: Job['kind'], now: number) {
  const id = randomUUID()
  db.prepare(
    "INSERT INTO jobs (id, kind, status, created_at, message, app_id) VALUES (?, ?, 'queued', ?, 'Waiting for the worker.', ?)",
  ).run(id, kind, now, appId)
  db.prepare('INSERT INTO job_events (job_id, message, created_at) VALUES (?, ?, ?)').run(
    id,
    'Operation queued.',
    now,
  )
  return getJob(db, id)!
}
export function createApp(db: DatabaseSync, input: CreateAppInput, key: Buffer, now = Date.now()) {
  return transaction(db, () => {
    if (db.prepare('SELECT id FROM apps WHERE name = ?').get(input.manifest.name))
      throw new Error('An app with this name already exists, including retained data.')
    if (
      (
        db.prepare("SELECT COUNT(*) AS count FROM apps WHERE status != 'removed'").get() as {
          count: number
        }
      ).count >= 50
    )
      throw new Error('This platform supports up to 50 apps.')
    const id = randomUUID()
    const manifest = input.manifest
    db.prepare(
      'INSERT INTO apps (id, name, manifest, environment, environment_names, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      manifest.name,
      JSON.stringify(manifest),
      sealEnvironment(input.environment, key),
      JSON.stringify(Object.keys(input.environment)),
      now,
    )
    return { app: getApp(db, id)!, job: insertAppJob(db, id, 'app.deploy', now) }
  })
}
export function enqueueAppAction(
  db: DatabaseSync,
  appId: string,
  action: 'deploy' | 'start' | 'stop' | 'remove' | 'restart',
  now = Date.now(),
) {
  return transaction(db, () => {
    const app = getApp(db, appId)
    if (!app || app.status === 'removed') throw new Error('App not found.')
    const active = db
      .prepare("SELECT id, kind FROM jobs WHERE app_id = ? AND status IN ('queued','running')")
      .get(appId) as { id: string; kind: string } | undefined
    if (active) {
      if (active.kind === `app.${action}`) return getJob(db, active.id)!
      throw new Error('An operation is already in progress for this app.')
    }
    if (
      ['deploy', 'start', 'restart'].includes(action) &&
      db
        .prepare(
          'SELECT 1 FROM app_revisions WHERE app_id = ? AND requires_recovery = 1 ORDER BY rowid DESC LIMIT 1',
        )
        .get(appId)
    )
      throw new Error(
        'Review data compatibility and use Recover previous version before starting this app.',
      )
    if (action === 'deploy' && !['failed', 'pending', 'unknown'].includes(app.status))
      throw new Error(
        'Retry deployment is available for failed installations. Use Update app to change a version.',
      )
    if (['start', 'restart'].includes(action) && !app.containerId)
      throw new Error('Retry deployment before starting this app.')
    const desired = action === 'remove' ? 'removed' : action === 'stop' ? 'stopped' : 'running'
    db.prepare('UPDATE apps SET desired_state = ? WHERE id = ?').run(desired, appId)
    return insertAppJob(db, appId, `app.${action}`, now)
  })
}
export function updateApp(
  db: DatabaseSync,
  claim: ClaimedJob,
  changes: Partial<
    Pick<
      HostedApp,
      | 'status'
      | 'containerName'
      | 'containerId'
      | 'imageId'
      | 'commit'
      | 'message'
      | 'logs'
      | 'logsAt'
    >
  >,
) {
  return transaction(db, () => {
    if (!ownsLease(db, claim)) throw new Error('The operation lease has expired.')
    const columns = {
      status: 'status',
      containerId: 'container_id',
      containerName: 'container_name',
      imageId: 'image_id',
      commit: 'source_commit',
      message: 'message',
      logs: 'logs',
      logsAt: 'logs_at',
    }
    const entries = Object.entries(changes) as [keyof typeof columns, string | number | null][]
    if (entries.length)
      db.prepare(
        `UPDATE apps SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')} WHERE id = ?`,
      ).run(...entries.map(([, value]) => value), claim.job.appId!)
  })
}
export function recordAppObservation(
  db: DatabaseSync,
  id: string,
  status: HostedApp['status'],
  logs: string,
  now = Date.now(),
) {
  db.prepare(
    `UPDATE apps SET status = ?, logs = ?, logs_at = ?, last_seen_at = ? WHERE id = ? AND status IN ('running','stopped','unknown')
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE app_id = ? AND status IN ('queued','running'))`,
  ).run(status, logs, now, now, id, id)
}
export function appOrigin(app: Pick<HostedApp, 'name'>, base: string) {
  const url = new URL(base)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !/^[a-z0-9.-]+$/.test(url.hostname)
  )
    throw new Error('Configure a valid app base origin.')
  url.hostname = `${app.name}.${url.hostname}`
  return url.origin
}
