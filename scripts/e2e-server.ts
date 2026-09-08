import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const dataDir = mkdtempSync(join(tmpdir(), 'servitas-e2e-'))
let socket = process.env.SERVITAS_DOCKER_SOCKET || '/var/run/docker.sock'
try {
  const endpoint = execFileSync(
    'docker',
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim()
  if (!process.env.SERVITAS_DOCKER_SOCKET && endpoint.startsWith('unix://'))
    socket = endpoint.slice(7)
} catch {
  /* Runtime availability is reported by the check. */
}
const env = {
  ...process.env,
  SERVITAS_DATA_DIR: dataDir,
  SERVITAS_APPS_ORIGIN: '',
  SERVITAS_ORIGIN: 'http://127.0.0.1:3100',
  SERVITAS_BOOTSTRAP_TOKEN: 'test-installation-key-not-for-production',
  SERVITAS_DOCKER_SOCKET: socket,
  PORT: '3100',
  HOST: '127.0.0.1',
}
const children = [
  spawn('node', ['apps/web/.output/server/index.mjs'], { env, stdio: 'inherit' }),
  spawn('node', ['apps/worker/dist/index.js'], { env, stdio: 'inherit' }),
]
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) =>
          child.exitCode !== null ? resolve(null) : child.once('exit', resolve),
        ),
    ),
  ).then(() => {
    rmSync(dataDir, { recursive: true, force: true })
    process.exit(0)
  })
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
for (const child of children)
  child.on('error', (error) => {
    console.error(error)
    stop()
  })
