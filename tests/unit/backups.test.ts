import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  backupDestinationSchema,
  backupMetadataSchema,
  restoreRequestSchema,
} from '../../packages/contracts/src/backups'
import { createAppSchema } from '../../packages/contracts/src/index'
import {
  openDatabase,
  encryptionKey,
  createApp,
  claimJob,
  finishJob,
  updateApp,
  createBackupDestination,
  listBackupDestinations,
  backupDestination,
  markDestinationChecked,
  queueAppBackup,
  queueAppRestore,
  recordAppBackup,
  listAppBackups,
  backupMetadata,
  getApp,
  activateRestoredApp,
  updateBackupOperation,
  saveBackupSchedule,
  enqueueScheduledBackups,
  listBackupSchedules,
  listJobs,
  preparePlatformRecovery,
  createOwner,
  createSession,
} from '../../packages/core/src/index'
const dirs: string[] = []
const databases: ReturnType<typeof openDatabase>[] = []
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})
const input = () =>
  backupDestinationSchema.parse({
    name: 'Offsite',
    endpoint: 'https://s3.example.com',
    bucket: 'backups',
    accessKey: 'test-access',
    secretKey: 'secret-storage-credential',
    password: 'a-long-external-recovery-password',
    confirmRecoveryPasswordSaved: true,
  })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'servitas-backup-test-'))
  dirs.push(dir)
  const db = openDatabase(dir)
  databases.push(db)
  const key = encryptionKey(dir)
  return { dir, db, key }
}
function deployed() {
  const f = fixture()
  const config = createAppSchema.parse({
    manifest: {
      version: 1,
      name: 'notes',
      source: { type: 'image', image: 'nginx:alpine' },
      port: 80,
      volumes: [{ name: 'data', mountPath: '/data' }],
    },
    environment: { SECRET: 'app-secret' },
  })
  const app = createApp(f.db, config, f.key).app
  const claim = claimJob(f.db)!
  updateApp(f.db, claim, {
    status: 'running',
    imageId: 'sha256:' + 'a'.repeat(64),
    containerId: 'old-container',
  })
  finishJob(f.db, claim, 'succeeded', 'Ready')
  const destination = createBackupDestination(f.db, input(), f.key)
  const check = claimJob(f.db)!
  markDestinationChecked(f.db, check, 'Ready', true)
  finishJob(f.db, check, 'succeeded', 'Ready')
  return { ...f, app: getApp(f.db, app.id)!, destinationId: destination.id, config }
}

test('destination credentials are encrypted, hidden from responses and require an externally saved password', () => {
  const { db, key } = fixture()
  const { id } = createBackupDestination(db, input(), key)
  expect(JSON.stringify(listBackupDestinations(db))).not.toContain('secret-storage-credential')
  expect(JSON.stringify(db.prepare('SELECT * FROM backup_destinations').all())).not.toContain(
    'a-long-external-recovery-password',
  )
  expect(backupDestination(db, id, key).secretKey).toBe(input().secretKey)
  expect(
    backupDestinationSchema.safeParse({ ...input(), endpoint: 'http://storage.example.com' })
      .success,
  ).toBe(false)
  expect(backupDestinationSchema.safeParse({ ...input(), endpoint: 'not-a-url' }).success).toBe(
    false,
  )
  expect(
    backupDestinationSchema.safeParse({ ...input(), confirmRecoveryPasswordSaved: false }).success,
  ).toBe(false)
})
test('backups serialize app operations, seal saved secrets and restore only the confirmed app generation', () => {
  const { db, key, app, destinationId, config } = deployed()
  const job = queueAppBackup(db, app.id, destinationId)
  expect(() => queueAppBackup(db, app.id, destinationId)).toThrow('in progress')
  const claim = claimJob(db)!
  const metadata = backupMetadataSchema.parse({
    version: 1,
    appId: app.id,
    backupId: job.id,
    createdAt: Date.now(),
    configuration: config,
    imageId: app.imageId,
    commit: null,
  })
  recordAppBackup(db, claim, 'b'.repeat(64), metadata, key)
  finishJob(db, claim, 'succeeded', 'Saved')
  expect(JSON.stringify(listAppBackups(db, key))).not.toContain('app-secret')
  expect(JSON.stringify(db.prepare('SELECT metadata FROM app_backups').all())).not.toContain(
    'app-secret',
  )
  expect(backupMetadata(db, job.id, key).configuration.environment.SECRET).toBe('app-secret')
  const restore = {
    backupId: job.id,
    expectedGeneration: 0,
    confirmName: app.name,
    confirmOverwrite: true as const,
  }
  expect(restoreRequestSchema.safeParse({ ...restore, confirmOverwrite: false }).success).toBe(
    false,
  )
  expect(() => queueAppRestore(db, app.id, { ...restore, confirmName: 'other' }, key)).toThrow(
    'Confirm',
  )
  expect(() => queueAppRestore(db, app.id, { ...restore, expectedGeneration: 5 }, key)).toThrow(
    'changed',
  )
  queueAppRestore(db, app.id, restore, key)
  const restoring = claimJob(db)!
  const candidate = {
    ...app,
    volumeSet: restoring.job.id,
    containerId: 'restored-container',
    containerName: 'restored-name',
  }
  updateBackupOperation(db, restoring, {
    phase: 'starting',
    containerId: candidate.containerId,
    imageId: candidate.imageId,
  })
  activateRestoredApp(db, restoring, candidate, metadata, key)
  activateRestoredApp(db, restoring, candidate, metadata, key)
  expect(getApp(db, app.id)?.volumeSet).toBe(restoring.job.id)
  expect(getApp(db, app.id)?.generation).toBe(1)
  const now = Date.now()
  claimJob(db, now + 31_000)
  claimJob(db, now + 62_000)
  claimJob(db, now + 93_000)
  expect(getApp(db, app.id)?.status).toBe('running')
  expect(() => activateRestoredApp(db, restoring, candidate, metadata, key)).toThrow('lease')
})
test('daily schedules advance atomically with job acceptance and keep busy apps due', () => {
  const { db, app, destinationId } = deployed()
  saveBackupSchedule(db, app.id, { destinationId, enabled: true, hourUTC: 3 })
  const due = listBackupSchedules(db)[0]!.nextRunAt
  enqueueScheduledBackups(db, due)
  enqueueScheduledBackups(db, due)
  expect(listJobs(db).filter((job) => job.kind === 'app.backup')).toHaveLength(1)
  expect(listBackupSchedules(db)[0]!.nextRunAt).toBe(due + 86_400_000)
  enqueueScheduledBackups(db, due + 86_400_000)
  expect(listBackupSchedules(db)[0]!.nextRunAt).toBe(due + 86_400_000)
})
test('offline recovery keeps accounts and backup settings but revokes sessions, pauses schedules and prevents empty-volume starts', () => {
  const { db, app, destinationId } = deployed()
  createOwner(db, 'owner@example.com', 'hash')
  createSession(db)
  saveBackupSchedule(db, app.id, { destinationId, enabled: true, hourUTC: 3 })
  queueAppBackup(db, app.id, destinationId)
  preparePlatformRecovery(db)
  expect(db.prepare('SELECT email FROM owner').get()?.email).toBe('owner@example.com')
  expect(db.prepare('SELECT * FROM sessions').all()).toHaveLength(0)
  expect(getApp(db, app.id)?.status).toBe('removed')
  expect(listJobs(db).some((job) => ['queued', 'running'].includes(job.status))).toBe(false)
  expect(listBackupSchedules(db)[0]?.enabled).toBe(false)
  expect(listBackupDestinations(db)).toHaveLength(1)
})

test('v4 upgrade preserves app state, secrets and owner records while adding backup storage', () => {
  const { db, dir, key } = fixture()
  createOwner(db, 'existing@example.com', 'existing-hash')
  const app = createApp(
    db,
    createAppSchema.parse({
      manifest: {
        version: 1,
        name: 'existing',
        source: { type: 'image', image: 'nginx:alpine' },
        port: 80,
      },
      environment: { SECRET: 'existing-secret' },
    }),
    key,
  ).app
  const claim = claimJob(db)!
  updateApp(db, claim, {
    status: 'running',
    imageId: 'sha256:' + 'a'.repeat(64),
    containerId: 'existing-container',
  })
  finishJob(db, claim, 'succeeded', 'Ready')
  db.exec(
    'DROP TABLE backup_schedules; DROP TABLE backup_operations; DROP TABLE app_backups; DROP TABLE backup_destinations; ALTER TABLE apps DROP COLUMN volume_set; PRAGMA user_version=4;',
  )
  db.close()
  databases.splice(databases.indexOf(db), 1)
  const upgraded = openDatabase(dir)
  databases.push(upgraded)
  expect(getApp(upgraded, app.id)?.containerId).toBe('existing-container')
  expect(getApp(upgraded, app.id)?.volumeSet).toBeNull()
  expect(upgraded.prepare('SELECT email FROM owner').get()?.email).toBe('existing@example.com')
  expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(createBackupDestination(upgraded, input(), key).job.kind).toBe('backup.check')
})
