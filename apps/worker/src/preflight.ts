import { lookup } from 'node:dns/promises'
import { statfs } from 'node:fs/promises'
import { runtime } from './runtime'

// Platform installation/maintenance only; hosted app management stays in the browser.
const docker = runtime(process.env.SERVITAS_DOCKER_SOCKET || '/var/run/docker.sock')
const checks: { name: string; ok: boolean; message: string }[] = []
async function check(name: string, action: () => Promise<string>) {
  try {
    checks.push({ name, ok: true, message: await action() })
  } catch (error) {
    checks.push({
      name,
      ok: false,
      message: error instanceof Error ? error.message : 'Check failed.',
    })
  }
}
await check('Container runtime', async () => {
  const info = await docker.info()
  if (info.OSType !== 'linux') throw new Error('Use a Linux Docker engine.')
  if (info.MemTotal < 1024 * 1024 * 1024)
    throw new Error('Provide at least 1 GB of engine memory; more is needed for hosted apps.')
  return `Docker ${info.ServerVersion}, Linux, ${Math.floor(info.MemTotal / 1024 / 1024)} MB memory.`
})
await check('Platform storage', async () => {
  const disk = await statfs(process.env.SERVITAS_DATA_DIR || '/data')
  const free = Math.floor((disk.bavail * disk.bsize) / 1024 / 1024)
  if (free < 1024)
    throw new Error(`Only ${free} MB free. Provide at least 1 GB before installation.`)
  return `${free} MB free on the platform data filesystem. App storage also needs capacity.`
})
for (const [name, configured] of [
  ['Platform DNS', process.env.SERVITAS_ORIGIN],
  ['App wildcard DNS', process.env.SERVITAS_APPS_ORIGIN],
] as const) {
  await check(name, async () => {
    if (!configured) throw new Error('Configure the platform and app origins first.')
    const url = new URL(configured)
    if (
      url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost') ||
      url.hostname === '127.0.0.1'
    )
      return 'Local preview selected. Public DNS and HTTPS are not checked.'
    const host =
      name === 'App wildcard DNS' ? `servitas-install-check.${url.hostname}` : url.hostname
    const addresses = await lookup(host, { all: true })
    if (!addresses.length) throw new Error(`No address found for ${host}.`)
    return `${host}: ${addresses.map((address) => address.address).join(', ')}. ${url.protocol === 'https:' ? 'Allow inbound TCP 80 and 443 for Caddy.' : 'HTTP configured; use HTTPS for public installation.'}`
  })
}
for (const check of checks)
  console.info(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.message}`)
if (checks.some((check) => !check.ok)) process.exitCode = 1
