import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout } from 'node:timers/promises'
import type { AuthStatus, Job } from '../packages/contracts/src/index'

// Every run owns a unique Compose project. Cleanup cannot delete the user's platform data.
const project = `servitas-test-${randomBytes(5).toString('hex')}`
const token = randomBytes(32).toString('hex')
async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}
const httpPort = await freePort()
const httpsPort = await freePort()
const origin = `http://127.0.0.1:${httpPort}`
const env = {
  ...process.env,
  SERVITAS_BOOTSTRAP_TOKEN: token,
  SERVITAS_ORIGIN: origin,
  SERVITAS_ADDRESS: ':80',
  SERVITAS_HTTP_BIND: `127.0.0.1:${httpPort}`,
  SERVITAS_HTTPS_BIND: `127.0.0.1:${httpsPort}`,
}
async function compose(...args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['compose', '-p', project, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-10000)
    })
    child.stderr.on('data', (chunk) => {
      output = (output + chunk).slice(-10000)
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(output))))
  })
}
let cookie = ''
async function api(path: string, body?: unknown) {
  return fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
}
async function eventually(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch {
      /* Service may still be starting. */
    }
    await setTimeout(500)
  }
  throw new Error(message)
}

try {
  console.info('Building and starting an isolated Compose platform…')
  await compose('up', '-d', '--build', '--wait', '--wait-timeout', '90')
  await eventually(
    async () => (await api('/api/health')).ok,
    'Caddy did not reach the web service.',
  )
  assert.equal((await api('/api/platform')).status, 401)
  const setup = await api('/api/auth/setup', {
    email: 'compose@example.com',
    password: randomBytes(24).toString('hex'),
    token,
  })
  assert.equal(setup.status, 201, await setup.text())
  cookie = setup.headers.getSetCookie()[0]!.split(';')[0]!

  await compose('stop', 'worker')
  const queued = await api('/api/jobs', { kind: 'platform.check' })
  assert.equal(queued.status, 202)
  const job = (await queued.json()) as Job
  assert.equal(job.status, 'queued')
  console.info('Recreating services to verify session and queued-job persistence…')
  await compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90', 'web', 'worker')
  await eventually(async () => {
    const response = await api(`/api/jobs/${job.id}`)
    if (!response.ok) return false
    const data = (await response.json()) as { job: Job }
    if (data.job.status === 'failed') throw new Error(data.job.message)
    return data.job.status === 'succeeded'
  }, 'The persisted job did not complete successfully through Docker.')
  const auth = (await (await api('/api/auth/status')).json()) as AuthStatus
  assert.equal(auth.owner?.email, 'compose@example.com')
  console.info(
    'Compose passed: Caddy routing, owner session, Docker check, and job persistence after container replacement.',
  )
} finally {
  await compose('down', '--volumes', '--remove-orphans')
  console.info('Removed isolated test containers and volumes.')
}
