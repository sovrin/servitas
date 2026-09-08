import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { manifestSchema } from '../../packages/contracts/src/index'
import {
  authenticate,
  claimJob,
  consumeAuthAttempt,
  createOwner,
  createSession,
  enqueuePlatformCheck,
  finishJob,
  getJob,
  hashPassword,
  jobEvents,
  LEASE_MS,
  openDatabase,
  renewLease,
  reportProgress,
  resetOwner,
  revokeSession,
  sessionOwner,
  tokensMatch,
  workerStatus,
  heartbeat,
} from '../../packages/core/src/index'

const directories: string[] = []
const databases: ReturnType<typeof openDatabase>[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'servitas-test-'))
  directories.push(dir)
  const db = openDatabase(dir)
  databases.push(db)
  return { db, dir }
}
afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.isOpen) db.close()
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('durable operations', () => {
  test('deduplicates pending requests and permits only one worker claim', () => {
    const { db, dir } = fixture()
    const second = openDatabase(dir)
    databases.push(second)
    const job = enqueuePlatformCheck(db, 1000)
    expect(enqueuePlatformCheck(second, 1001).id).toBe(job.id)
    const claim = claimJob(db, 1002)!
    expect(claimJob(second, 1003)).toBeNull()
    expect(finishJob(db, claim, 'succeeded', 'Done.', 1004)).toBe(true)
    expect(enqueuePlatformCheck(second, 1005).id).not.toBe(job.id)
    expect(jobEvents(db, job.id).map((event) => event.message)).toContain('Done.')
  })

  test('recovers after reconnecting to the database and rejects the stale worker', () => {
    const { db, dir } = fixture()
    const job = enqueuePlatformCheck(db, 1000)
    const stale = claimJob(db, 1001)!
    db.close()
    const restarted = openDatabase(dir)
    databases.push(restarted)
    const now = 1002 + LEASE_MS
    const recovered = claimJob(restarted, now)!
    expect(recovered.job.id).toBe(job.id)
    expect(recovered.job.attempts).toBe(2)
    expect(finishJob(restarted, stale, 'succeeded', 'Stale result.', now)).toBe(false)
    expect(reportProgress(restarted, stale, 'Stale progress.', now)).toBe(false)
    expect(renewLease(restarted, stale, now)).toBe(false)
    expect(finishJob(restarted, recovered, 'succeeded', 'Recovered.', now + 1)).toBe(true)
    expect(getJob(restarted, job.id)?.message).toBe('Recovered.')
  })

  test('bounds interrupted retries and expires worker health', () => {
    const { db } = fixture()
    const job = enqueuePlatformCheck(db, 0)
    claimJob(db, 1)
    claimJob(db, LEASE_MS + 2)
    claimJob(db, LEASE_MS * 2 + 3)
    expect(claimJob(db, LEASE_MS * 3 + 4)).toBeNull()
    expect(getJob(db, job.id)?.status).toBe('failed')
    heartbeat(db, 1000)
    expect(workerStatus(db, 1001).online).toBe(true)
    expect(workerStatus(db, 17000).online).toBe(false)
  })
})

describe('owner access', () => {
  test('hashes credentials, protects singleton ownership, revokes and expires sessions', async () => {
    const { db } = fixture()
    const password = 'a sufficiently long passphrase'
    const hash = await hashPassword(password)
    expect(hash).not.toContain(password)
    expect(createOwner(db, 'owner@example.com', hash)).toBe(true)
    expect(createOwner(db, 'another@example.com', hash)).toBe(false)
    expect(await authenticate(db, 'owner@example.com', password)).toBe(true)
    expect(await authenticate(db, 'owner@example.com', 'incorrect password')).toBe(false)
    expect(await authenticate(db, 'other@example.com', password)).toBe(false)
    const session = createSession(db, 1000)
    expect(sessionOwner(db, session.token, 1001)?.email).toBe('owner@example.com')
    expect(JSON.stringify(db.prepare('SELECT * FROM sessions').all())).not.toContain(session.token)
    expect(sessionOwner(db, session.token, session.expiresAt)).toBeNull()
    revokeSession(db, session.token)
    expect(sessionOwner(db, session.token, 1001)).toBeNull()
    const second = createSession(db, 1002)
    resetOwner(db)
    expect(sessionOwner(db, second.token, 1003)).toBeNull()
  })

  test('limits attempts across connections and compares installation keys', () => {
    const { db, dir } = fixture()
    for (let attempt = 0; attempt < 10; attempt++)
      expect(consumeAuthAttempt(db, 'login', 1000)).toBe(0)
    const second = openDatabase(dir)
    databases.push(second)
    expect(consumeAuthAttempt(second, 'login', 1001)).toBeGreaterThan(0)
    expect(consumeAuthAttempt(second, 'login', 901001)).toBe(0)
    expect(tokensMatch('a'.repeat(32), 'a'.repeat(32))).toBe(true)
    expect(tokensMatch('a', 'b'.repeat(64))).toBe(false)
  })
})

test('validates manifests and rejects unsupported permissions and unsafe paths', () => {
  const input = {
    version: 1,
    name: 'my-app',
    source: { type: 'image', image: 'nginx:alpine' },
    port: 80,
  }
  const valid = manifestSchema.parse(input)
  expect(valid.access).toBe('private')
  expect(valid.resources.memoryMb).toBe(256)
  expect(manifestSchema.safeParse({ ...input, privileged: true }).success).toBe(false)
  expect(manifestSchema.safeParse({ ...input, port: 0 }).success).toBe(false)
  expect(
    manifestSchema.safeParse({
      ...input,
      source: {
        type: 'git',
        url: 'https://example.com/app.git',
        revision: 'main',
        dockerfile: '../../Dockerfile',
      },
    }).success,
  ).toBe(false)
  expect(
    manifestSchema.safeParse({ ...input, volumes: [{ name: 'data', mountPath: '/data/../etc' }] })
      .success,
  ).toBe(false)
})
