import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const dataDir = resolve(process.env.SERVITAS_DATA_DIR || '.data')
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
const tokenPath = resolve(dataDir, 'bootstrap-token')
if (!process.env.SERVITAS_BOOTSTRAP_TOKEN && !existsSync(tokenPath))
  writeFileSync(tokenPath, randomBytes(32).toString('base64url'), { mode: 0o600 })
let socketPath = process.env.SERVITAS_DOCKER_SOCKET
if (!socketPath) {
  try {
    const endpoint = execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    if (endpoint.startsWith('unix://')) socketPath = endpoint.slice(7)
  } catch {
    /* The dashboard can run without Docker; platform checks report its availability. */
  }
}
const env = {
  ...process.env,
  SERVITAS_DATA_DIR: dataDir,
  // Hosted apps need the containerized worker and gateway from Compose.
  SERVITAS_APPS_ORIGIN: '',
  SERVITAS_ORIGIN: process.env.SERVITAS_ORIGIN || 'http://localhost:3000',
  SERVITAS_BOOTSTRAP_TOKEN:
    process.env.SERVITAS_BOOTSTRAP_TOKEN || readFileSync(tokenPath, 'utf8').trim(),
  SERVITAS_DOCKER_SOCKET: socketPath || '/var/run/docker.sock',
}
console.info(`Servitas dashboard development: ${env.SERVITAS_ORIGIN}`)
console.info('Use Docker Compose for app deployment and routing; see README.md.')
console.info(
  `Initial setup key: ${process.env.SERVITAS_BOOTSTRAP_TOKEN ? 'configured in environment' : tokenPath}`,
)
const children = ['@servitas/web', '@servitas/worker'].map((name) =>
  spawn('pnpm', ['--filter', name, 'dev'], { env, stdio: 'inherit' }),
)
let stopping = false
function stop(code: number) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) child.kill('SIGTERM')
}
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
for (const child of children) {
  child.on('error', () => stop(1))
  child.on('exit', (code) => stop(code ?? 0))
}
