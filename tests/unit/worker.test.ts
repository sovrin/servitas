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
  let validCapacity = true
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/version') res.end(JSON.stringify({ Version: '29.7.2' }))
    else if (req.url === '/info')
      res.end(
        JSON.stringify(validCapacity ? { NCPU: 4, MemTotal: 2147483648 } : { NCPU: 'unknown' }),
      )
    else {
      res.statusCode = 404
      res.end()
    }
  })
  try {
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    const job = enqueuePlatformCheck(db)
    await runPlatformCheck(db, claimJob(db)!, dir, socket)
    expect(getJob(db, job.id)?.status).toBe('succeeded')
    expect(
      jobEvents(db, job.id)
        .map((event) => event.message)
        .join(' '),
    ).toContain('4 CPUs, 2048 MB memory')
    validCapacity = false
    const malformed = enqueuePlatformCheck(db)
    await runPlatformCheck(db, claimJob(db)!, dir, socket)
    expect(getJob(db, malformed.id)?.status).toBe('failed')
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
