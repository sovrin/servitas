import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  repositoryInspectionSchema,
  parseAppConfiguration,
} from '../../packages/contracts/src/configuration'
import { createAppSchema } from '../../packages/contracts/src/index'
import {
  readRepositoryConfiguration,
  runRepositoryInspection,
} from '../../apps/worker/src/repositories'
import {
  openDatabase,
  queueRepositoryInspection,
  getRepositoryInspection,
  claimJob,
  recordRepositoryResult,
  repositoryCommit,
  createApp,
  encryptionKey,
  finishJob,
  updateApp,
  queueUpdate,
  getRevision,
  appEnvironment,
  jobEvents,
} from '../../packages/core/src/index'

const dirs: string[] = []
const databases: ReturnType<typeof openDatabase>[] = []
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'servitas-repository-'))
  dirs.push(dir)
  return dir
}
function database(dir = directory()) {
  const db = openDatabase(dir)
  databases.push(db)
  return db
}
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})
const input = repositoryInspectionSchema.parse({
  source: { type: 'git', url: 'https://example.com/app.git', revision: 'main' },
})

test('inspection validates source and path, deduplicates submissions, fences results and retains pinned commits after interruption', () => {
  const db = database()
  const inspection = queueRepositoryInspection(db, input)
  expect(queueRepositoryInspection(db, input).job.id).toBe(inspection.job.id)
  const first = claimJob(db)!
  expect(recordRepositoryResult(db, first, 'a'.repeat(40))).toBe(true)
  const second = claimJob(db, Date.now() + 31_000)!
  expect(second.job.attempts).toBe(2)
  expect(repositoryCommit(db, inspection.job.id)).toBe('a'.repeat(40))
  expect(recordRepositoryResult(db, first, 'b'.repeat(40))).toBe(false)
  expect(getRepositoryInspection(db, inspection.job.id)?.result).toBeNull()
  for (const source of [
    { ...input.source, url: 'https://user:password@example.com/app.git' },
    { ...input.source, url: 'file:///tmp/app' },
    { ...input.source, url: 'not-a-url' },
    { ...input.source, revision: '--upload-pack=evil' },
  ])
    expect(repositoryInspectionSchema.safeParse({ source }).success).toBe(false)
  for (const path of ['../servitas.yaml', '/servitas.json', '.git/servitas.yaml'])
    expect(repositoryInspectionSchema.safeParse({ ...input, path }).success).toBe(false)
})

test('a saved result completes after worker interruption without fetching the repository again', async () => {
  const db = database()
  const inspection = queueRepositoryInspection(db, input)
  const first = claimJob(db)!
  const result = {
    configuration: parseAppConfiguration(
      '{"version":1,"name":"demo","port":3000}',
      'servitas.json',
    ),
    path: 'servitas.json',
    commit: 'a'.repeat(40),
  }
  expect(recordRepositoryResult(db, first, result.commit, result)).toBe(true)
  const reclaimed = claimJob(db, Date.now() + 31_000)!
  await runRepositoryInspection(db, reclaimed)
  expect(getRepositoryInspection(db, inspection.job.id)?.job.status).toBe('succeeded')
  expect(getRepositoryInspection(db, inspection.job.id)?.result).toEqual(result)
  expect(jobEvents(db, inspection.job.id).some((event) => event.message.includes('Fetching'))).toBe(
    false,
  )
})

test('reads real Git objects without following symlinks, rejects ambiguous and oversized files, and pins imported settings', async () => {
  const dir = directory()
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  git('init', '--quiet')
  writeFileSync(join(dir, 'servitas.yaml'), 'version: 1\nname: demo\nport: 3000\n')
  const commit = () => {
    git('add', '.')
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--quiet',
      '-m',
      'Fixture',
    )
    return git('rev-parse', 'HEAD').trim()
  }
  const run = async (...args: string[]) => git(...args)
  const sha = commit()
  const result = await readRepositoryConfiguration(run, sha, input)
  expect(result.configuration.source).toEqual({ ...input.source, revision: sha })
  expect(result.configuration.access).toBe('private')
  writeFileSync(join(dir, 'servitas.json'), '{"version":1,"name":"demo","port":8080}')
  const ambiguous = commit()
  await expect(readRepositoryConfiguration(run, ambiguous, input)).rejects.toThrow('Multiple')
  expect(
    (await readRepositoryConfiguration(run, ambiguous, { ...input, path: 'servitas.json' }))
      .configuration.port,
  ).toBe(8080)
  rmSync(join(dir, 'servitas.json'))
  rmSync(join(dir, 'servitas.yaml'))
  symlinkSync('/etc/passwd', join(dir, 'servitas.yaml'))
  await expect(readRepositoryConfiguration(run, commit(), input)).rejects.toThrow('regular file')
  rmSync(join(dir, 'servitas.yaml'))
  writeFileSync(join(dir, 'servitas.yaml'), 'x'.repeat(65_537))
  await expect(readRepositoryConfiguration(run, commit(), input)).rejects.toThrow('64 KB')
  writeFileSync(
    join(dir, 'servitas.yaml'),
    'version: 1\nname: demo\nport: 3000\nsource:\n  type: image\n  image: nginx:alpine\n',
  )
  await expect(readRepositoryConfiguration(run, commit(), input)).rejects.toThrow(
    'selected Git repository',
  )
  rmSync(join(dir, 'servitas.yaml'))
  await expect(readRepositoryConfiguration(run, commit(), input)).rejects.toThrow('No Servitas')
  expect((await readRepositoryConfiguration(run, sha, input)).commit).toBe(sha)
})

test('v3 upgrade preserves candidate revisions, encrypted secrets and event references', () => {
  const dir = directory()
  const db = database(dir)
  const key = encryptionKey(dir)
  const app = createApp(
    db,
    createAppSchema.parse({
      manifest: {
        version: 1,
        name: 'demo',
        port: 80,
        source: { type: 'image', image: 'nginx:alpine' },
      },
      environment: { SECRET: 'kept' },
    }),
    key,
  ).app
  const deployment = claimJob(db)!
  updateApp(db, deployment, {
    status: 'running',
    imageId: 'old-image',
    containerId: 'old-container',
  })
  finishJob(db, deployment, 'succeeded', 'Ready')
  const update = queueUpdate(
    db,
    app.id,
    {
      manifest: app.manifest,
      environment: {},
      removeEnvironment: [],
      expectedGeneration: 0,
      confirmMaintenance: false,
    },
    key,
  )
  const revision = getRevision(db, update.id)
  db.exec(
    'DROP TABLE backup_schedules; DROP TABLE backup_operations; DROP TABLE app_backups; DROP TABLE backup_destinations; ALTER TABLE apps DROP COLUMN volume_set; DROP TABLE repository_inspections; PRAGMA user_version = 3;',
  )
  db.close()
  databases.splice(databases.indexOf(db), 1)
  const upgraded = database(dir)
  expect(getRevision(upgraded, update.id)).toEqual(revision)
  expect(appEnvironment(upgraded, app.id, key)).toEqual({ SECRET: 'kept' })
  expect(jobEvents(upgraded, update.id)).toHaveLength(1)
  expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(queueRepositoryInspection(upgraded, input).job.kind).toBe('repository.inspect')
})
