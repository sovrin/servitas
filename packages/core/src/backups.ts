import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  backupDestinationSchema,
  backupMetadataSchema,
  type BackupDestinationInput,
  type BackupDestination,
  type BackupMetadata,
  type AppBackup,
  type BackupOperation,
  type BackupSchedule,
} from '@servitas/contracts/backups'
import type { HostedApp, Job } from '@servitas/contracts'
import { transaction } from './database'
import { getJob, ownsLease, type ClaimedJob } from './jobs'
import { getApp, insertAppJob } from './apps'
import { openEnvironment, sealEnvironment } from './secrets'

export function listBackupDestinations(db: DatabaseSync): BackupDestination[] {
  return (
    db
      .prepare(
        'SELECT id, configuration, checked_at AS checkedAt, message FROM backup_destinations ORDER BY rowid',
      )
      .all() as { id: string; configuration: string; checkedAt: number | null; message: string }[]
  ).map(({ configuration, ...row }) => ({ ...JSON.parse(configuration), ...row }))
}
export function backupDestination(db: DatabaseSync, id: string, key: Buffer) {
  const destination = listBackupDestinations(db).find((item) => item.id === id)
  if (!destination) throw new Error('Backup destination not found.')
  const row = db.prepare('SELECT secrets FROM backup_destinations WHERE id = ?').get(id) as {
    secrets: string
  }
  return { ...destination, ...openEnvironment(row.secrets, key) } as BackupDestination & {
    accessKey: string
    secretKey: string
    password: string
  }
}
export function createBackupDestination(
  db: DatabaseSync,
  input: BackupDestinationInput,
  key: Buffer,
) {
  const { accessKey, secretKey, password, confirmRecoveryPasswordSaved, ...configuration } =
    backupDestinationSchema.parse(input)
  return transaction(db, () => {
    if (listBackupDestinations(db).length >= 10)
      throw new Error('Use at most 10 backup destinations.')
    const id = randomUUID()
    db.prepare('INSERT INTO backup_destinations (id, configuration, secrets) VALUES (?, ?, ?)').run(
      id,
      JSON.stringify(configuration),
      sealEnvironment({ accessKey, secretKey, password }, key),
    )
    return { id, job: insertBackupOperation(db, id, 'backup.check') }
  })
}
export function replaceBackupCredentials(
  db: DatabaseSync,
  id: string,
  secrets: { accessKey: string; secretKey: string; password: string },
  key: Buffer,
) {
  return transaction(db, () => {
    if (
      db
        .prepare(
          "SELECT 1 FROM backup_operations o JOIN jobs j ON j.id=o.id WHERE o.destination_id=? AND j.status IN ('queued','running')",
        )
        .get(id)
    )
      throw new Error('Wait for this destination’s operations to finish.')
    if (
      !db.prepare('UPDATE backup_destinations SET secrets=?, checked_at=NULL WHERE id=?').run(
        sealEnvironment(
          {
            accessKey: secrets.accessKey,
            secretKey: secrets.secretKey,
            password: secrets.password,
          },
          key,
        ),
        id,
      ).changes
    )
      throw new Error('Destination not found.')
    return insertBackupOperation(db, id, 'backup.check')
  })
}
function insertBackupOperation(
  db: DatabaseSync,
  destinationId: string,
  kind: Job['kind'],
  app?: HostedApp,
  backupId?: string,
) {
  if (!db.prepare('SELECT 1 FROM backup_destinations WHERE id = ?').get(destinationId))
    throw new Error('Backup destination not found.')
  let job: Job
  if (app) job = insertAppJob(db, app.id, kind, Date.now())
  else {
    const id = randomUUID()
    const now = Date.now()
    db.prepare(
      "INSERT INTO jobs (id,kind,status,created_at,message) VALUES (?,?,'queued',?,'Waiting for the worker.')",
    ).run(id, kind, now)
    db.prepare('INSERT INTO job_events(job_id,message,created_at) VALUES (?,?,?)').run(
      id,
      'Backup operation queued.',
      now,
    )
    job = getJob(db, id)!
  }
  db.prepare(
    'INSERT INTO backup_operations (id,destination_id,backup_id,previous) VALUES (?,?,?,?)',
  ).run(job.id, destinationId, backupId || null, app ? JSON.stringify({ ...app, logs: '' }) : null)
  return job
}
export function queueDestinationOperation(
  db: DatabaseSync,
  id: string,
  kind: 'backup.check' | 'platform.backup',
) {
  return transaction(db, () => {
    const active = db
      .prepare(
        "SELECT j.id FROM jobs j JOIN backup_operations o ON o.id=j.id WHERE o.destination_id=? AND j.kind=? AND j.status IN ('queued','running')",
      )
      .get(id, kind) as { id: string } | undefined
    return active ? getJob(db, active.id)! : insertBackupOperation(db, id, kind)
  })
}
function requireIdleApp(db: DatabaseSync, id: string) {
  const app = getApp(db, id)
  if (!app) throw new Error('App not found.')
  if (db.prepare("SELECT 1 FROM jobs WHERE app_id=? AND status IN ('queued','running')").get(id))
    throw new Error('An operation is already in progress for this app.')
  return app
}
export function queueAppBackup(db: DatabaseSync, appId: string, destinationId: string) {
  return transaction(db, () => insertAppBackup(db, appId, destinationId))
}
function insertAppBackup(db: DatabaseSync, appId: string, destinationId: string) {
  const app = requireIdleApp(db, appId)
  if (!['running', 'stopped'].includes(app.status) || !app.imageId)
    throw new Error('Back up a deployed app that is running or stopped.')
  if (
    !db
      .prepare('SELECT 1 FROM backup_destinations WHERE id=? AND checked_at IS NOT NULL')
      .get(destinationId)
  )
    throw new Error('Check the backup destination first.')
  return insertBackupOperation(db, destinationId, 'app.backup', app)
}
export function backupMetadata(db: DatabaseSync, id: string, key: Buffer): BackupMetadata {
  const row = db.prepare('SELECT metadata FROM app_backups WHERE id=?').get(id) as
    { metadata: string } | undefined
  if (!row) throw new Error('Backup not found.')
  return backupMetadataSchema.parse(JSON.parse(openEnvironment(row.metadata, key).metadata!))
}
export function listAppBackups(db: DatabaseSync, key: Buffer, appId?: string): AppBackup[] {
  return (
    db
      .prepare(
        `SELECT id,app_id AS appId,destination_id AS destinationId,snapshot_id AS snapshotId,created_at AS createdAt FROM app_backups ${appId ? 'WHERE app_id=?' : ''} ORDER BY created_at DESC LIMIT 500`,
      )
      .all(...(appId ? [appId] : [])) as Omit<AppBackup, 'manifest' | 'commit' | 'appName'>[]
  ).map((row) => {
    const metadata = backupMetadata(db, row.id, key)
    return {
      ...row,
      appName: metadata.configuration.manifest.name,
      manifest: metadata.configuration.manifest,
      commit: metadata.commit,
    }
  })
}
export function recordAppBackup(
  db: DatabaseSync,
  claim: ClaimedJob,
  snapshotId: string,
  metadata: BackupMetadata,
  key: Buffer,
) {
  const parsed = backupMetadataSchema.parse(metadata)
  return transaction(db, () => {
    if (!ownsLease(db, claim)) throw new Error('The operation lease has expired.')
    const op = getBackupOperation(db, claim.job.id)!
    db.prepare(
      'INSERT INTO app_backups (id,app_id,destination_id,snapshot_id,created_at,metadata) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
    ).run(
      parsed.backupId,
      parsed.appId,
      op.destinationId,
      snapshotId,
      parsed.createdAt,
      sealEnvironment({ metadata: JSON.stringify(parsed) }, key),
    )
  })
}
export function queueAppRestore(
  db: DatabaseSync,
  appId: string,
  input: {
    backupId: string
    expectedGeneration: number
    confirmName: string
    confirmOverwrite: true
  },
  key: Buffer,
) {
  return transaction(db, () => {
    const metadata = backupMetadata(db, input.backupId, key)
    if (
      metadata.appId !== appId ||
      metadata.configuration.manifest.name !== input.confirmName ||
      !input.confirmOverwrite
    )
      throw new Error('Confirm the app name and replacement of its data and settings.')
    let app = getApp(db, appId)
    if (!app) {
      if (input.expectedGeneration !== 0) throw new Error('App changed. Reload before restoring.')
      if (db.prepare('SELECT 1 FROM apps WHERE name=?').get(input.confirmName))
        throw new Error('Another app is using this name.')
      db.prepare(
        "INSERT INTO apps (id,name,manifest,environment,environment_names,status,desired_state,created_at) VALUES (?,?,?,?,?,'removed','stopped',?)",
      ).run(
        appId,
        input.confirmName,
        JSON.stringify(metadata.configuration.manifest),
        sealEnvironment(metadata.configuration.environment, key),
        JSON.stringify(Object.keys(metadata.configuration.environment)),
        Date.now(),
      )
      app = getApp(db, appId)!
    }
    app = requireIdleApp(db, appId)
    if (app.generation !== input.expectedGeneration)
      throw new Error('App changed. Reload before restoring.')
    const row = db
      .prepare('SELECT destination_id FROM app_backups WHERE id=?')
      .get(input.backupId) as { destination_id: string }
    return insertBackupOperation(db, row.destination_id, 'app.restore', app, input.backupId)
  })
}
export function getBackupOperation(db: DatabaseSync, id: string): BackupOperation | null {
  const row = db
    .prepare(
      'SELECT destination_id AS destinationId,backup_id AS backupId,phase,previous,snapshot_id AS snapshotId,container_id AS containerId,container_name AS containerName,image_id AS imageId FROM backup_operations WHERE id=?',
    )
    .get(id) as
    (Omit<BackupOperation, 'job' | 'previous'> & { previous: string | null }) | undefined
  return row
    ? { ...row, job: getJob(db, id)!, previous: row.previous ? JSON.parse(row.previous) : null }
    : null
}
export function updateBackupOperation(
  db: DatabaseSync,
  claim: ClaimedJob,
  changes: Partial<
    Pick<BackupOperation, 'phase' | 'snapshotId' | 'containerId' | 'containerName' | 'imageId'>
  >,
) {
  return transaction(db, () => {
    if (!ownsLease(db, claim)) throw new Error('The operation lease has expired.')
    const columns = {
      phase: 'phase',
      snapshotId: 'snapshot_id',
      containerId: 'container_id',
      containerName: 'container_name',
      imageId: 'image_id',
    }
    const entries = Object.entries(changes) as [keyof typeof columns, string | null][]
    if (entries.length)
      db.prepare(
        `UPDATE backup_operations SET ${entries.map(([key]) => columns[key] + '=?').join(',')} WHERE id=?`,
      ).run(...entries.map(([, value]) => value), claim.job.id)
  })
}
export function markDestinationChecked(
  db: DatabaseSync,
  claim: ClaimedJob,
  message: string,
  success: boolean,
) {
  if (!ownsLease(db, claim)) return
  db.prepare(
    'UPDATE backup_destinations SET checked_at=?,message=? WHERE id=(SELECT destination_id FROM backup_operations WHERE id=?)',
  ).run(success ? Date.now() : null, message, claim.job.id)
}
export function activateRestoredApp(
  db: DatabaseSync,
  claim: ClaimedJob,
  app: HostedApp,
  metadata: BackupMetadata,
  key: Buffer,
) {
  return transaction(db, () => {
    if (!ownsLease(db, claim)) throw new Error('The operation lease has expired.')
    if (getBackupOperation(db, claim.job.id)?.phase === 'applied') return
    if (!app.containerId || !app.imageId || app.volumeSet !== claim.job.id)
      throw new Error('Restored app is not ready.')
    db.prepare(
      "UPDATE apps SET manifest=?,environment=?,environment_names=?,container_id=?,container_name=?,image_id=?,source_commit=?,volume_set=?,generation=generation+1,status='running',desired_state='running',message='Backup restored.' WHERE id=?",
    ).run(
      JSON.stringify(metadata.configuration.manifest),
      sealEnvironment(metadata.configuration.environment, key),
      JSON.stringify(Object.keys(metadata.configuration.environment)),
      app.containerId,
      app.containerName,
      app.imageId,
      metadata.commit,
      app.volumeSet,
      app.id,
    )
    db.prepare('UPDATE app_revisions SET requires_recovery=0 WHERE app_id=?').run(app.id)
    db.prepare('DELETE FROM app_sessions WHERE app_id=?').run(app.id)
    db.prepare('DELETE FROM app_grants WHERE app_id=?').run(app.id)
    db.prepare("UPDATE backup_operations SET phase='applied' WHERE id=?").run(claim.job.id)
  })
}
export function listBackupSchedules(db: DatabaseSync): BackupSchedule[] {
  return (
    db
      .prepare(
        'SELECT app_id AS appId,destination_id AS destinationId,enabled,hour_utc AS hourUTC,next_run_at AS nextRunAt FROM backup_schedules',
      )
      .all() as (Omit<BackupSchedule, 'enabled'> & { enabled: number })[]
  ).map((row) => ({ ...row, enabled: !!row.enabled }))
}
function nextDaily(hourUTC: number, now: number) {
  const date = new Date(now)
  date.setUTCHours(hourUTC, 0, 0, 0)
  if (date.getTime() <= now) date.setUTCDate(date.getUTCDate() + 1)
  return date.getTime()
}
export function saveBackupSchedule(
  db: DatabaseSync,
  appId: string,
  input: { destinationId: string; enabled: boolean; hourUTC: number },
) {
  if (!getApp(db, appId)) throw new Error('App not found.')
  if (
    !listBackupDestinations(db).some(
      (destination) => destination.id === input.destinationId && destination.checkedAt,
    )
  )
    throw new Error('Check this destination before scheduling backups.')
  db.prepare(
    'INSERT INTO backup_schedules (app_id,destination_id,enabled,hour_utc,next_run_at) VALUES (?,?,?,?,?) ON CONFLICT(app_id) DO UPDATE SET destination_id=excluded.destination_id,enabled=excluded.enabled,hour_utc=excluded.hour_utc,next_run_at=excluded.next_run_at',
  ).run(
    appId,
    input.destinationId,
    Number(input.enabled),
    input.hourUTC,
    nextDaily(input.hourUTC, Date.now()),
  )
}
export function enqueueScheduledBackups(db: DatabaseSync, now = Date.now()) {
  transaction(db, () => {
    for (const schedule of listBackupSchedules(db).filter(
      (schedule) => schedule.enabled && schedule.nextRunAt <= now,
    )) {
      const app = getApp(db, schedule.appId)
      if (!app || !['running', 'stopped'].includes(app.status)) continue
      try {
        insertAppBackup(db, schedule.appId, schedule.destinationId)
        db.prepare('UPDATE backup_schedules SET next_run_at=? WHERE app_id=?').run(
          nextDaily(schedule.hourUTC, now),
          schedule.appId,
        )
      } catch {
        /* Busy apps and unavailable destinations keep their saved due time. */
      }
    }
  })
}
