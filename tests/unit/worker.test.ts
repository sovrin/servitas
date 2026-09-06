import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  claimJob,
  enqueuePlatformCheck,
  getJob,
  jobEvents,
  openDatabase,
} from '../../packages/core/src/index'
import { runPlatformCheck } from '../../apps/worker/src/check'

test('records a successful runtime check and a recoverable connection failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-'))
  const socket = join(dir, 'docker.sock')
  const db = openDatabase(dir)
  const server = createServer((req, res) => {
    expect(req.url).toBe('/version')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ Version: '29.7.2' }))
  })
  try {
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    const job = enqueuePlatformCheck(db)
    await runPlatformCheck(db, claimJob(db)!, dir, socket)
    expect(getJob(db, job.id)?.status).toBe('succeeded')
    expect(jobEvents(db, job.id).length).toBeGreaterThan(3)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    const next = enqueuePlatformCheck(db)
    await runPlatformCheck(db, claimJob(db)!, dir, socket)
    expect(getJob(db, next.id)?.status).toBe('failed')
    expect(getJob(db, next.id)?.message).toContain('run it again')
    expect(getJob(db, next.id)?.message).not.toContain(socket)
  } finally {
    server.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
