import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { createAppSchema } from '../../packages/contracts/src/index'
import {
  appEnvironment,
  appOrigin,
  authorizeAppSession,
  claimJob,
  createApp,
  createAppGrant,
  createOwner,
  createSession,
  encryptionKey,
  enqueueAppAction,
  exchangeAppGrant,
  finishJob,
  getApp,
  jobEvents,
  openDatabase,
  redact,
  revokeSession,
  updateApp,
} from '../../packages/core/src/index'

const dirs: string[] = []
const databases: DatabaseSync[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'servitas-app-test-'))
  dirs.push(dir)
  const db = openDatabase(dir)
  databases.push(db)
  return { dir, db, key: encryptionKey(dir) }
}
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})
const input = () =>
  createAppSchema.parse({
    manifest: {
      version: 1,
      name: 'notes',
      source: { type: 'image', image: 'nginx:alpine' },
      port: 80,
      volumes: [{ name: 'data', mountPath: '/data' }],
    },
    environment: { SECRET: 'test-secret-value' },
  })

test('app creation encrypts environment values and serializes lifecycle actions', () => {
  const { db, key } = fixture()
  const { app, job } = createApp(db, input(), key)
  expect(JSON.stringify(app)).not.toContain('test-secret-value')
  expect(JSON.stringify(db.prepare('SELECT * FROM apps').all())).not.toContain('test-secret-value')
  expect(appEnvironment(db, app.id, key)).toEqual({ SECRET: 'test-secret-value' })
  expect(enqueueAppAction(db, app.id, 'deploy').id).toBe(job.id)
  expect(() => enqueueAppAction(db, app.id, 'stop')).toThrow('in progress')
  const claim = claimJob(db)!
  updateApp(db, claim, { status: 'running', containerId: 'container' })
  finishJob(db, claim, 'succeeded', 'Ready')
  expect(enqueueAppAction(db, app.id, 'stop').kind).toBe('app.stop')
  expect(getApp(db, app.id)?.desiredState).toBe('stopped')
  expect(() => updateApp(db, claim, { status: 'running' })).toThrow('lease')
})

test('app grants are single-use, app-bound, expiring, and revoked with the owner session', () => {
  const { db, key } = fixture()
  createOwner(db, 'owner@example.com', 'unused')
  const app = createApp(db, input(), key).app
  const other = createApp(
    db,
    { ...input(), manifest: { ...input().manifest, name: 'other' } },
    key,
  ).app
  const session = createSession(db, 1000)
  const grant = createAppGrant(db, app.id, session.token, 1001)
  expect(exchangeAppGrant(db, other.id, grant, 1002)).toBeNull()
  const appSession = exchangeAppGrant(db, app.id, grant, 1002)!
  expect(exchangeAppGrant(db, app.id, grant, 1003)).toBeNull()
  expect(authorizeAppSession(db, app.id, appSession.token, 1003)).toBe(true)
  expect(authorizeAppSession(db, other.id, appSession.token, 1003)).toBe(false)
  const expired = createAppGrant(db, app.id, session.token, 1004)
  expect(exchangeAppGrant(db, app.id, expired, 62_000)).toBeNull()
  revokeSession(db, session.token)
  expect(authorizeAppSession(db, app.id, appSession.token, 1005)).toBe(false)
})

test('validates the deployment boundary and redacts literal secret values', () => {
  const valid = input()
  expect(
    createAppSchema.safeParse({ ...valid, manifest: { ...valid.manifest, privileged: true } })
      .success,
  ).toBe(false)
  expect(
    createAppSchema.safeParse({
      ...valid,
      manifest: { ...valid.manifest, healthCheck: '//internal/' },
    }).success,
  ).toBe(false)
  expect(
    createAppSchema.safeParse({
      ...valid,
      manifest: {
        ...valid.manifest,
        volumes: [...valid.manifest.volumes, ...valid.manifest.volumes],
      },
    }).success,
  ).toBe(false)
  expect(redact('token=a.b*c and a.b*c', { SECRET: 'a.b*c' })).toBe(
    'token=[redacted] and [redacted]',
  )
  expect(appOrigin({ name: 'notes' }, 'https://apps.example.com')).toBe(
    'https://notes.apps.example.com',
  )
})

test('upgrades a v1 database without losing accounts, jobs, or event references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'servitas-migration-'))
  dirs.push(dir)
  const old = new DatabaseSync(join(dir, 'servitas.sqlite'))
  old.exec(`
    CREATE TABLE owner (id INTEGER PRIMARY KEY, email TEXT, password_hash TEXT);
    INSERT INTO owner VALUES (1, 'existing@example.com', 'existing-hash');
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE rate_limits (key TEXT PRIMARY KEY, attempts INTEGER, resets_at INTEGER);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT, status TEXT, created_at INTEGER, started_at INTEGER, finished_at INTEGER, attempts INTEGER, lease_token TEXT, lease_until INTEGER, message TEXT);
    INSERT INTO jobs VALUES ('old-job', 'platform.check', 'succeeded', 1, 2, 3, 1, NULL, NULL, 'Done');
    CREATE TABLE job_events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT REFERENCES jobs(id), message TEXT, created_at INTEGER);
    INSERT INTO job_events VALUES (1, 'old-job', 'Done', 3);
    CREATE TABLE worker_heartbeat (id INTEGER PRIMARY KEY, last_seen_at INTEGER);
    PRAGMA user_version = 1;
  `)
  old.close()
  const db = openDatabase(dir)
  databases.push(db)
  expect(db.prepare('SELECT email FROM owner').get()?.email).toBe('existing@example.com')
  expect(jobEvents(db, 'old-job')[0]?.message).toBe('Done')
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

test('update acceptance preserves active settings, merges secrets, and rejects stale or unsafe updates', async () => {
  const { queueUpdate, getRevision, revisionEnvironment, updateRevision, activateRevision } =
    await import('../../packages/core/src/index')
  const { db, key } = fixture()
  const app = createApp(db, input(), key).app
  const initial = claimJob(db)!
  updateApp(db, initial, { status: 'running', containerId: 'old-container', imageId: 'old-image' })
  finishJob(db, initial, 'succeeded', 'Ready')
  const update = {
    manifest: { ...input().manifest, port: 8080 },
    environment: { NEW: 'new-secret' },
    removeEnvironment: ['SECRET'],
    expectedGeneration: 0,
    confirmMaintenance: false,
  }
  expect(() => queueUpdate(db, app.id, update, key)).toThrow('maintenance')
  const job = queueUpdate(db, app.id, { ...update, confirmMaintenance: true }, key)
  expect(getApp(db, app.id)?.manifest.port).toBe(80)
  expect(appEnvironment(db, app.id, key)).toEqual(input().environment)
  expect(revisionEnvironment(db, job.id, key)).toEqual({ NEW: 'new-secret' })
  expect(JSON.stringify(getRevision(db, job.id))).not.toContain('new-secret')
  expect(JSON.stringify(db.prepare('SELECT * FROM app_revisions').all())).not.toContain(
    'new-secret',
  )
  expect(() => queueUpdate(db, app.id, { ...update, confirmMaintenance: true }, key)).toThrow(
    'in progress',
  )
  const claim = claimJob(db)!
  updateRevision(db, claim, {
    containerId: 'new-container',
    containerName: 'new-name',
    imageId: 'new-image',
    phase: 'started',
  })
  activateRevision(db, claim)
  activateRevision(db, claim)
  expect(getApp(db, app.id)?.generation).toBe(1)
  expect(getApp(db, app.id)?.manifest.port).toBe(8080)
  expect(appEnvironment(db, app.id, key)).toEqual({ NEW: 'new-secret' })
  finishJob(db, claim, 'succeeded', 'Updated')
  expect(() => updateRevision(db, claim, { phase: 'failed' })).toThrow('lease')
  expect(() => queueUpdate(db, app.id, { ...update, confirmMaintenance: true }, key)).toThrow(
    'changed',
  )
})

test('stateful recovery requires compatibility confirmation and retains the pinned previous image', async () => {
  const { queueUpdate, queuePreviousVersion, getRevision, updateRevision, revisionEnvironment } =
    await import('../../packages/core/src/index')
  const { db, key } = fixture()
  const app = createApp(db, input(), key).app
  const initial = claimJob(db)!
  updateApp(db, initial, {
    status: 'running',
    containerId: 'old-container',
    imageId: 'sha256:previous',
  })
  finishJob(db, initial, 'succeeded', 'Ready')
  queueUpdate(
    db,
    app.id,
    {
      manifest: input().manifest,
      environment: { SECRET: 'replacement' },
      removeEnvironment: [],
      expectedGeneration: 0,
      confirmMaintenance: true,
    },
    key,
  )
  const claim = claimJob(db)!
  updateRevision(db, claim, { phase: 'failed', requiresRecovery: true })
  updateApp(db, claim, { status: 'failed' })
  finishJob(db, claim, 'failed', 'Health check failed')
  expect(() => enqueueAppAction(db, app.id, 'start')).toThrow('compatibility')
  expect(() =>
    queuePreviousVersion(db, app.id, key, {
      confirmDataCompatibility: false,
      revisionId: claim.job.id,
      expectedGeneration: 0,
    }),
  ).toThrow('migrations')
  const recovery = queuePreviousVersion(db, app.id, key, {
    confirmDataCompatibility: true,
    revisionId: claim.job.id,
    expectedGeneration: 0,
  })
  expect(getRevision(db, recovery.id)?.imageId).toBe('sha256:previous')
  expect(revisionEnvironment(db, recovery.id, key)).toEqual(input().environment)
})

test('repeated worker interruption of a stateless update preserves the running version', async () => {
  const { queueUpdate, queueRetryUpdate, getRevision } =
    await import('../../packages/core/src/index')
  const { db, key } = fixture()
  const config = { ...input(), manifest: { ...input().manifest, volumes: [] } }
  const app = createApp(db, config, key).app
  const initial = claimJob(db)!
  updateApp(db, initial, { status: 'running', containerId: 'old-container', imageId: 'old-image' })
  finishJob(db, initial, 'succeeded', 'Ready')
  const job = queueUpdate(
    db,
    app.id,
    {
      manifest: config.manifest,
      environment: {},
      removeEnvironment: [],
      expectedGeneration: 0,
      confirmMaintenance: false,
    },
    key,
  )
  const now = Date.now()
  claimJob(db, now)
  claimJob(db, now + 31_000)
  claimJob(db, now + 62_000)
  expect(claimJob(db, now + 93_000)).toBeNull()
  expect(getApp(db, app.id)?.status).toBe('running')
  expect(getRevision(db, job.id)?.phase).toBe('failed')
  expect(queueRetryUpdate(db, app.id, key).kind).toBe('app.update')
})

test('upgrades saved v2 app settings and encrypted environment without losing history', () => {
  const { db, dir, key } = fixture()
  const { app, job } = createApp(db, input(), key)
  // Reproduce v2 storage: requiredEnv held every saved variable name; v3 separates them.
  db.exec(`
    DROP TABLE backup_schedules; DROP TABLE backup_operations; DROP TABLE app_backups; DROP TABLE backup_destinations; ALTER TABLE apps DROP COLUMN volume_set; DROP TABLE repository_inspections;
    DROP TABLE app_revisions;
    UPDATE apps SET manifest = json_set(manifest, '$.requiredEnv', json('["SECRET"]'));
    ALTER TABLE apps DROP COLUMN environment_names;
    ALTER TABLE apps DROP COLUMN container_name;
    ALTER TABLE apps DROP COLUMN generation;
    PRAGMA user_version = 2;
  `)
  db.close()
  databases.splice(databases.indexOf(db), 1)
  const upgraded = openDatabase(dir)
  databases.push(upgraded)
  const saved = getApp(upgraded, app.id)!
  expect(saved.name).toBe('notes')
  expect(saved.manifest.volumes).toEqual(input().manifest.volumes)
  expect(saved.environmentNames).toEqual(['SECRET'])
  expect(saved.generation).toBe(0)
  expect(appEnvironment(upgraded, app.id, key)).toEqual(input().environment)
  expect(jobEvents(upgraded, job.id)).toHaveLength(1)
  expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})
