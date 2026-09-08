import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { request } from 'node:http'
import { setTimeout } from 'node:timers/promises'
import type { AuthStatus, Job, HostedApp } from '../packages/contracts/src/index'
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { repositoryFixture } from './repository-fixture'

// Every run owns a unique Compose project. Cleanup cannot delete the user's platform data.
const project = `servitas-test-${randomBytes(5).toString('hex')}`
const token = randomBytes(32).toString('hex')
const repository = await repositoryFixture()
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
  SERVITAS_APPS_ORIGIN: `http://apps.localhost:${httpPort}`,
  SERVITAS_HTTP_BIND: `127.0.0.1:${httpPort}`,
  SERVITAS_HTTPS_BIND: `127.0.0.1:${httpsPort}`,
}
async function compose(...args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'docker',
      ['compose', '-p', project, '-f', 'compose.yaml', '-f', repository.override, ...args],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
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
async function eventually(check: () => Promise<boolean>, message: string, timeout = 30_000) {
  // Count completed polling intervals so laptop suspension does not consume the test budget.
  for (let attempt = 0; attempt < Math.ceil(timeout / 500); attempt++) {
    try {
      if (await check()) return
    } catch {
      /* Service may still be starting. */
    }
    await setTimeout(500)
  }
  throw new Error(message)
}

async function dockerCommand(...args: string[]) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(output))))
  })
}

async function waitForApp(id: string, expected: HostedApp['status'], timeout: number) {
  for (let attempt = 0; attempt < Math.ceil(timeout / 1000); attempt++) {
    const response = await api(`/api/apps/${id}`)
    if (response.ok) {
      const { app } = (await response.json()) as { app: HostedApp }
      if (app.status === expected) return
      if (app.status === 'failed') throw new Error(app.message)
    }
    await setTimeout(1000)
  }
  throw new Error(`App ${id} did not reach ${expected}.`)
}

async function waitForOperation(id: string, expected: 'succeeded' | 'failed' = 'succeeded') {
  let lastJob: Job | undefined
  for (let attempt = 0; attempt < 840; attempt++) {
    const { job } = (await (await api(`/api/jobs/${id}`)).json()) as { job: Job }
    lastJob = job
    if (attempt > 0 && attempt % 120 === 0) console.info(`Waiting for ${job.kind}: ${job.message}`)
    if (['succeeded', 'failed'].includes(job.status)) {
      assert.equal(job.status, expected, job.message)
      return
    }
    await setTimeout(500)
  }
  throw new Error(`Operation did not complete: ${JSON.stringify(lastJob)}`)
}

// Node fetch replaces an explicit Host header; use HTTP directly to test local virtual hosts.
async function appRequest(host: string, appCookie = '') {
  return await new Promise<{ status: number; location?: string; body: string }>(
    (resolve, reject) => {
      const req = request(
        origin,
        { headers: { host, cookie: appCookie }, timeout: 5000 },
        (response) => {
          let body = ''
          response.on('data', (chunk) => {
            body += chunk
          })
          response.on('end', () =>
            resolve({ status: response.statusCode!, location: response.headers.location, body }),
          )
        },
      )
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('App request timed out.')))
      req.end()
    },
  )
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
    password: 'compose-browser-test-passphrase',
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
  console.info('Exercising app installation and private access through the browser…')
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext()
    context.setDefaultTimeout(30_000)
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(origin)
    await page.getByLabel('Email', { exact: true }).fill('compose@example.com')
    await page.getByLabel('Password', { exact: true }).fill('compose-browser-test-passphrase')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('link', { name: 'Install app', exact: true }).click()
    await page.getByLabel('Import configuration', { exact: true }).setInputFiles({
      name: 'servitas.yaml',
      mimeType: 'application/yaml',
      buffer: Buffer.from(
        'version: 1\nname: private-demo\nsource:\n  type: image\n  image: traefik/whoami:v1.11.0\nport: 80\nrequiredEnv: [SECRET]\n',
      ),
    })
    assert.equal(await page.getByLabel('App name', { exact: true }).inputValue(), 'private-demo')
    assert.equal(await page.getByLabel('HTTP port', { exact: true }).inputValue(), '80')
    await page.getByText('Environment, storage, and health checks', { exact: true }).click()
    await page.getByLabel('Environment variables').fill('SECRET=do-not-print-this-secret')
    await page.getByRole('button', { name: 'Add volume' }).click()
    await page.getByLabel('Volume name', { exact: true }).fill('data')
    await page.getByLabel('Mount path', { exact: true }).fill('/data')
    await page.getByRole('button', { name: 'Install app', exact: true }).click()
    await page.waitForURL(/\/apps\/[a-f0-9-]{36}$/)
    const appId = page.url().split('/').at(-1)!
    await waitForApp(appId, 'running', 180_000)
    const appData = (await (await api(`/api/apps/${appId}`)).json()) as {
      app: { url: string; containerId: string }
    }
    assert(!JSON.stringify(appData).includes('do-not-print-this-secret'))
    const appURL = new URL(appData.app.url)
    const anonymous = await appRequest(appURL.host)
    assert.equal(anonymous.status, 302)
    assert.equal(anonymous.location, `${origin}/open/${appId}`)
    const popupPromise = context.waitForEvent('page')
    await page.getByRole('link', { name: 'Open app', exact: true }).click()
    const appPage = await popupPromise
    await appPage.waitForURL((url) => url.hostname === appURL.hostname && url.pathname === '/')
    await appPage.waitForFunction(() => document.body.innerText.includes('Hostname:'))
    assert(!(await appPage.locator('body').innerText()).includes('servitas_app_session='))
    await context.addCookies([{ name: 'app-preference', value: 'kept', url: appURL.origin }])
    await appPage.reload()
    assert((await appPage.locator('body').innerText()).includes('app-preference=kept'))
    const info = JSON.parse(await dockerCommand('inspect', appData.app.containerId))[0]
    assert.equal(info.HostConfig.Privileged, false)
    assert.equal(info.HostConfig.Memory, 256 * 1024 * 1024)
    assert.equal(Object.keys(info.HostConfig.PortBindings || {}).length, 0)
    assert.equal(
      info.Mounts.some(
        (mount: { Destination: string }) => mount.Destination === '/var/run/docker.sock',
      ),
      false,
    )
    const volume = info.Mounts.find(
      (mount: { Destination: string }) => mount.Destination === '/data',
    ).Name
    // Fixture-only file writes verify data contents, not merely volume existence.
    const marker = `retained-${appId}`
    await dockerCommand(
      'run',
      '--rm',
      '--label',
      `dev.servitas.instance=${project}`,
      '--label',
      `dev.servitas.app=${appId}`,
      '-v',
      `${volume}:/data`,
      'alpine:3.23',
      'sh',
      '-c',
      'printf %s "$1" > /data/marker',
      '--',
      marker,
    )
    console.info('Editing app settings, secrets and access in the browser…')
    await page.getByRole('link', { name: 'Update app', exact: true }).click()
    await page.getByText('Environment, storage, and health checks', { exact: true }).click()
    assert.equal(await page.getByLabel('Environment variables').inputValue(), '')
    await page.getByLabel('Import configuration', { exact: true }).setInputFiles({
      name: 'servitas.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          version: 1,
          name: 'private-demo',
          port: 80,
          access: 'public',
          resources: { memoryMb: 320, cpu: 1 },
          volumes: [{ name: 'data', mountPath: '/data' }],
          requiredEnv: ['NEW_SECRET'],
        }),
      ),
    })
    await page.getByLabel('Remove SECRET', { exact: true }).check()
    await page.getByLabel('Environment variables').fill('NEW_SECRET=replacement-secret-value')
    await page.getByLabel('Memory (MB)', { exact: true }).fill('320')
    await page.getByRole('radio', { name: /^Public/ }).check()
    await page.getByRole('button', { name: 'Review update', exact: true }).click()
    assert(await page.getByRole('button', { name: 'Deploy update', exact: true }).isDisabled())
    await page
      .getByLabel('I understand this update needs a maintenance window and may change app data.', {
        exact: true,
      })
      .check()
    const updateResponse = page.waitForResponse(
      (r) => r.url().endsWith(`/apps/${appId}/updates`) && r.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Deploy update', exact: true }).click()
    await waitForOperation((await (await updateResponse).json()).id)
    await page.waitForURL(`${origin}/apps/${appId}`)
    let updated = (await (await api(`/api/apps/${appId}`)).json()).app
    assert(!JSON.stringify(updated).includes('replacement-secret-value'))
    assert.notEqual(updated.containerId, appData.app.containerId)
    const updatedInfo = JSON.parse(await dockerCommand('inspect', updated.containerId))[0]
    assert.equal(updatedInfo.HostConfig.Memory, 320 * 1024 * 1024)
    assert(updatedInfo.Config.Env.includes('NEW_SECRET=replacement-secret-value'))
    assert(!updatedInfo.Config.Env.some((value: string) => value.startsWith('SECRET=')))
    assert.equal((await appRequest(appURL.host)).status, 200)
    const restartResponse = page.waitForResponse(
      (r) => r.url().endsWith(`/apps/${appId}/actions`) && r.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Restart app', exact: true }).click()
    await waitForOperation((await (await restartResponse).json()).id)
    console.info('Checking stateful update failure and explicit recovery…')
    const target = {
      manifest: { ...updated.manifest, port: 1 },
      expectedGeneration: updated.generation,
      confirmMaintenance: true,
    }
    const refused = await api(`/api/apps/${appId}/updates`, {
      ...target,
      confirmMaintenance: false,
    })
    assert.equal(refused.status, 409)
    const badUpdate = await api(`/api/apps/${appId}/updates`, target)
    assert.equal(badUpdate.status, 202)
    await waitForOperation((await badUpdate.json()).id, 'failed')
    assert.equal((await appRequest(appURL.host)).status, 503)
    assert.equal((await api(`/api/apps/${appId}/actions`, { action: 'start' })).status, 409)
    await page.reload()
    await page.getByRole('button', { name: 'Recover previous version', exact: true }).click()
    assert(await page.getByRole('button', { name: 'Recover version', exact: true }).isDisabled())
    await page
      .getByLabel('I have checked that the previous version can use the current app data.', {
        exact: true,
      })
      .check()
    const recoveryResponse = page.waitForResponse(
      (r) => r.url().endsWith(`/apps/${appId}/rollback`) && r.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Recover version', exact: true }).click()
    await waitForOperation((await (await recoveryResponse).json()).id)
    await page.reload()
    assert.equal((await appRequest(appURL.host)).status, 200)
    assert.equal(
      await dockerCommand(
        'run',
        '--rm',
        '--label',
        `dev.servitas.instance=${project}`,
        '--label',
        `dev.servitas.app=${appId}`,
        '-v',
        `${volume}:/data:ro`,
        'alpine:3.23',
        'cat',
        '/data/marker',
      ),
      marker,
    )
    console.info('Checking browser stop/start and persistent data…')
    await page.getByRole('button', { name: 'Stop app', exact: true }).click()
    await page.getByRole('button', { name: 'Start app', exact: true }).waitFor({ timeout: 30_000 })
    assert.equal(
      (
        await appRequest(
          appURL.host,
          `servitas_app_session=${(await context.cookies(appURL.origin)).find((c) => c.name === 'servitas_app_session')!.value}`,
        )
      ).status,
      503,
    )
    await page.getByRole('button', { name: 'Start app', exact: true }).click()
    await page.getByRole('link', { name: 'Open app', exact: true }).waitFor({ timeout: 30_000 })
    console.info('Replacing platform services while an app is running…')
    await compose(
      'up',
      '-d',
      '--force-recreate',
      '--wait',
      '--wait-timeout',
      '90',
      'web',
      'worker',
      'caddy',
    )
    await eventually(
      async () =>
        (
          await appRequest(
            appURL.host,
            `servitas_app_session=${(await context.cookies(appURL.origin)).find((c) => c.name === 'servitas_app_session')!.value}`,
          )
        ).status === 200,
      'App route did not recover after platform replacement.',
    )
    await page.reload()
    await page.getByRole('button', { name: 'Runtime logs', exact: true }).click()
    mkdirSync('.context/screenshots', { recursive: true })
    await page.screenshot({ path: '.context/screenshots/app-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: '.context/screenshots/app-mobile.png', fullPage: true })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    await page.getByRole('button', { name: 'Remove app', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Remove app', exact: true })
      .click()
    await page.waitForURL(origin + '/', { timeout: 30_000 })
    assert.equal(JSON.parse(await dockerCommand('volume', 'inspect', volume))[0].Name, volume)
    assert.equal(
      await dockerCommand(
        'run',
        '--rm',
        '--label',
        `dev.servitas.instance=${project}`,
        '--label',
        `dev.servitas.app=${appId}`,
        '-v',
        `${volume}:/data:ro`,
        'alpine:3.23',
        'cat',
        '/data/marker',
      ),
      marker,
    )
    console.info('Building a public Git app through the browser…')
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.getByRole('link', { name: 'Install app', exact: true }).click()
    await page.getByRole('radio', { name: 'Git repository', exact: true }).check()
    await page.getByLabel('Repository URL', { exact: true }).fill(repository.url)
    await compose('stop', 'worker')
    await page.getByRole('button', { name: 'Read repository configuration', exact: true }).click()
    await page.waitForURL(/configurationJob=/)
    const inspectionURL = page.url()
    const inspectionId = new URL(inspectionURL).searchParams.get('configurationJob')!
    assert.equal(
      (await (await api(`/api/repositories/${inspectionId}`)).json()).job.status,
      'queued',
    )
    await page.reload()
    await compose('start', 'worker')
    await waitForOperation(inspectionId)
    await page.getByRole('button', { name: 'Apply configuration', exact: true }).click()
    assert.equal(await page.getByLabel('App name', { exact: true }).inputValue(), 'git-demo')
    assert.equal(
      await page.getByLabel('Branch, tag, or commit', { exact: true }).inputValue(),
      repository.commit,
    )
    assert.equal(await page.getByLabel('HTTP port', { exact: true }).inputValue(), '3000')
    assert.equal(
      (await (await api('/api/apps')).json()).apps.filter(
        (app: HostedApp) => app.name === 'git-demo',
      ).length,
      0,
    )
    await page.getByRole('link', { name: 'View repository operation', exact: true }).click()
    await page.getByRole('link', { name: 'Review repository configuration', exact: true }).click()
    await page.getByRole('button', { name: 'Apply configuration', exact: true }).click()
    await page.screenshot({ path: '.context/screenshots/repository-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    await page.screenshot({ path: '.context/screenshots/repository-mobile.png', fullPage: true })
    // A failed lookup leaves the current form untouched and can be retried in place.
    await page
      .getByLabel('Configuration path (optional)', { exact: true })
      .fill('missing/servitas.yaml')
    const failure = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/repositories') && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Read repository configuration', exact: true }).click()
    await waitForOperation((await (await failure).json()).job.id, 'failed')
    await page.getByText('No Servitas configuration found.', { exact: false }).waitFor()
    assert.equal(await page.getByLabel('App name', { exact: true }).inputValue(), 'git-demo')
    await page
      .getByLabel('Configuration path (optional)', { exact: true })
      .fill('alternate/servitas.json')
    const alternate = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/repositories') && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Read repository configuration', exact: true }).click()
    await waitForOperation((await (await alternate).json()).job.id)
    await page.getByRole('button', { name: 'Apply configuration', exact: true }).click()
    assert(await page.getByRole('radio', { name: /^Private/ }).isChecked())
    await page.getByRole('radio', { name: /^Public/ }).check()
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.getByRole('button', { name: 'Install app', exact: true }).click()
    await page.waitForURL(/\/apps\/[a-f0-9-]{36}$/)
    const gitId = page.url().split('/').at(-1)!
    await waitForApp(gitId, 'running', 360_000)
    const gitApp = (await (await api(`/api/apps/${gitId}`)).json()).app
    assert.equal(gitApp.commit, repository.commit)
    assert(repository.fetches >= 4)
    assert.equal((await appRequest(new URL(gitApp.url).host)).status, 200)
    console.info('Checking that a failed stateless update keeps serving the current version…')
    const badStateless = await api(`/api/apps/${gitId}/updates`, {
      manifest: {
        ...gitApp.manifest,
        source: { type: 'image', image: 'traefik/whoami:v1.11.0' },
        port: 1,
      },
      expectedGeneration: gitApp.generation,
    })
    assert.equal(badStateless.status, 202)
    const badStatelessId = (await badStateless.json()).id
    await setTimeout(4000)
    assert.equal((await appRequest(new URL(gitApp.url).host)).status, 200)
    await eventually(
      async () => (await (await api(`/api/apps/${gitId}`)).json()).revisions[0].phase === 'started',
      'Replacement did not reach its health check.',
    )
    console.info('Interrupting an update and checking that its candidate is reused…')
    await compose('kill', '-s', 'SIGKILL', 'worker')
    await compose('up', '-d', 'worker')
    await waitForOperation(badStatelessId, 'failed')
    const retriedUpdate = (await (await api(`/api/jobs/${badStatelessId}`)).json()).job
    assert.equal(retriedUpdate.attempts, 2)
    const updateContainers = await dockerCommand(
      'ps',
      '-aq',
      '--filter',
      `label=dev.servitas.instance=${project}`,
      '--filter',
      `label=dev.servitas.app=${gitId}`,
    )
    assert.equal(updateContainers.split('\n').filter(Boolean).length, 2)
    const retained = (await (await api(`/api/apps/${gitId}`)).json()).app
    assert.equal(retained.containerId, gitApp.containerId)
    assert.equal(retained.status, 'running')
    assert.equal((await appRequest(new URL(gitApp.url).host)).status, 200)
    console.info('Checking failed health checks and browser recovery controls…')
    const failed = await api('/api/apps', {
      manifest: {
        version: 1,
        name: 'bad-health',
        source: { type: 'image', image: 'traefik/whoami:v1.11.0' },
        port: 1,
      },
    })
    assert.equal(failed.status, 202)
    const failedId = (await failed.json()).id
    await eventually(
      async () => !!(await (await api(`/api/apps/${failedId}`)).json()).app.containerId,
      'Failed-health fixture did not start.',
    )
    console.info('Interrupting the worker during a deployment to verify lease recovery…')
    await compose('kill', '-s', 'SIGKILL', 'worker')
    await compose('up', '-d', 'worker')
    await waitForApp(failedId, 'failed', 150_000)
    const recovered = await (await api(`/api/apps/${failedId}`)).json()
    assert.equal(recovered.jobs[0].attempts, 2)
    const matches = await dockerCommand(
      'ps',
      '-aq',
      '--filter',
      `label=dev.servitas.instance=${project}`,
      '--filter',
      `label=dev.servitas.app=${failedId}`,
    )
    assert.equal(matches.split('\n').filter(Boolean).length, 1)
    await page.goto(`${origin}/apps/${failedId}`)
    await page.getByRole('button', { name: 'Retry deployment', exact: true }).waitFor()
    assert.match(await page.locator('main [role="status"]').innerText(), /health check/)
    const failedApp = (await (await api(`/api/apps/${failedId}`)).json()).app
    assert.equal(
      JSON.parse(await dockerCommand('inspect', failedApp.containerId))[0].State.Running,
      false,
    )
    await page.getByRole('button', { name: 'Remove app', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Remove app', exact: true })
      .click()
    await page.waitForURL(origin + '/')
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'))
    await context.close()
  } finally {
    await browser.close()
  }
  console.info(
    'Compose passed: durable HTTPS Git configuration discovery, TypeScript Git deployment, JSON/YAML imports, image/Git installs, settings/secrets/access updates, stateful recovery, stateless failure isolation, restart, data retention, and interrupted deployment/update recovery.',
  )
} catch (error) {
  try {
    const listing = await (await api('/api/apps')).json()
    for (const app of listing.apps || []) {
      const detail = await (await api(`/api/apps/${app.id}`)).json()
      console.error(
        JSON.stringify({
          app: app.name,
          status: app.status,
          jobs: detail.jobs,
          events: detail.events?.slice(-8),
          revisions: detail.revisions?.map(
            (r: { id: string; phase: string; containerId: string; requiresRecovery: boolean }) => ({
              id: r.id,
              phase: r.phase,
              containerId: r.containerId,
              requiresRecovery: r.requiresRecovery,
            }),
          ),
        }),
      )
    }
  } catch {
    /* The API may be unavailable during a failing startup check. */
  }
  console.error(await dockerCommand('compose', '-p', project, 'logs', '--tail', '60'))
  throw error
} finally {
  await compose('down', '--volumes', '--remove-orphans')
  const filters = [
    '--filter',
    `label=dev.servitas.instance=${project}`,
    '--filter',
    'label=dev.servitas.app',
  ]
  for (const id of (await dockerCommand('ps', '-aq', ...filters)).split('\n').filter(Boolean))
    await dockerCommand('rm', '-f', id)
  for (const id of (await dockerCommand('network', 'ls', '-q', ...filters))
    .split('\n')
    .filter(Boolean))
    await dockerCommand('network', 'rm', id)
  for (const id of (await dockerCommand('volume', 'ls', '-q', ...filters))
    .split('\n')
    .filter(Boolean))
    await dockerCommand('volume', 'rm', id)
  for (const id of (await dockerCommand('image', 'ls', '-q', ...filters))
    .split('\n')
    .filter(Boolean))
    await dockerCommand('image', 'rm', id)
  await repository.close()
  console.info('Removed isolated test containers and volumes.')
}
