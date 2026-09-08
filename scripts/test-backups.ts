import assert from 'node:assert/strict'
import { testBetaApps } from './beta-apps'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout } from 'node:timers/promises'
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from '@playwright/test'
import { repositoryFixture } from './repository-fixture'
import { runRestic, ResticError, cleanupBackupHelpers } from '../apps/worker/src/backup-runtime'
import { runtime } from '../apps/worker/src/runtime'
import type { HostedApp, Job } from '../packages/contracts/src/index'
import type { AppBackup, BackupOperation } from '../packages/contracts/src/backups'

const suffix = randomBytes(5).toString('hex')
const originalProject = `servitas-backup-test-${suffix}`
const recoveredProject = `servitas-recovery-test-${suffix}`
let project = originalProject
const storage = `servitas-storage-test-${suffix}`
const repository = await repositoryFixture()
async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
const port = await freePort()
const tlsPort = await freePort()
const origin = `http://127.0.0.1:${port}`
const storageAccess = `fixture-${suffix}`
const storageSecret = randomBytes(24).toString('hex')
const recoveryPassword = randomBytes(32).toString('hex')
const env = {
  ...process.env,
  SERVITAS_BOOTSTRAP_TOKEN: randomBytes(32).toString('hex'),
  SERVITAS_ORIGIN: origin,
  SERVITAS_ADDRESS: ':80',
  SERVITAS_APPS_ORIGIN: `http://apps.localhost:${port}`,
  SERVITAS_HTTP_BIND: `127.0.0.1:${port}`,
  SERVITAS_HTTPS_BIND: `127.0.0.1:${tlsPort}`,
  MINIO_ROOT_USER: storageAccess,
  MINIO_ROOT_PASSWORD: storageSecret,
  RESTIC_PASSWORD: recoveryPassword,
  AWS_ACCESS_KEY_ID: storageAccess,
  AWS_SECRET_ACCESS_KEY: storageSecret,
  AWS_DEFAULT_REGION: 'us-east-1',
  RESTIC_REPOSITORY: '',
}
async function docker(...args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => (output = (output + chunk).slice(-100000)))
    child.stderr.on('data', (chunk) => (output = (output + chunk).slice(-100000)))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(output))))
  })
}
const compose = (...args: string[]) =>
  docker('compose', '-p', project, '-f', 'compose.yaml', '-f', repository.override, ...args)
let cookie = ''
async function api(path: string, body?: unknown) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  return response
}
async function waitJob(id: string, expected = 'succeeded') {
  for (let i = 0; i < 420; i++) {
    const response = await api(`/api/jobs/${id}`)
    if (response.ok) {
      const { job } = (await response.json()) as { job: Job }
      if (['succeeded', 'failed'].includes(job.status)) {
        assert.equal(job.status, expected, job.message)
        return job
      }
    }
    await setTimeout(1000)
  }
  throw new Error(`Backup job ${id} did not finish.`)
}
async function waitReady() {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await api('/api/health')).ok) return
    } catch {}
    await setTimeout(1000)
  }
  throw new Error('Platform did not start.')
}
async function waitApp(id: string) {
  for (let i = 0; i < 240; i++) {
    const { app } = (await (await api(`/api/apps/${id}`)).json()) as { app: HostedApp }
    if (app.status === 'running') return app
    if (app.status === 'failed') throw new Error(app.message)
    await setTimeout(1000)
  }
  throw new Error('App did not start.')
}
async function clickJob(page: Page, name: string, path: string) {
  const response = page.waitForResponse(
    (response) => response.url().endsWith(path) && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name, exact: true }).click()
  const data = await (await response).json()
  return data.job?.id || data.id
}
async function interruptWorkerDuringHelper(jobId: string, command: 'backup' | 'restore') {
  let helper = ''
  for (let attempt = 0; attempt < 1200; attempt++) {
    const ids = (await docker('ps', '-q', '--filter', `label=dev.servitas.backup-job=${jobId}`))
      .split('\n')
      .filter(Boolean)
    for (const id of ids) {
      const info = JSON.parse(await docker('inspect', id))[0]
      if (
        !info.Config.Cmd.includes(command) ||
        (command === 'backup' && !info.Config.Cmd.includes('/volumes'))
      )
        continue
      try {
        await docker('pause', id)
        helper = id
        break
      } catch {
        /* Command may already have exited. */
      }
    }
    if (helper) break
    await setTimeout(100)
  }
  assert(helper, 'Could not intercept the data-transfer helper.')
  await compose('kill', '-s', 'SIGKILL', 'worker')
  await compose('start', 'worker')
  for (let attempt = 0; attempt < 90; attempt++) {
    const { job } = (await (await api(`/api/jobs/${jobId}`)).json()) as { job: Job }
    if (job.attempts >= 2) break
    await setTimeout(1000)
  }
  const { job } = (await (await api(`/api/jobs/${jobId}`)).json()) as { job: Job }
  assert.equal(job.attempts, 2)
  await docker('unpause', helper)
}
async function ownedCleanup(instance: string) {
  const filters = ['--filter', `label=dev.servitas.instance=${instance}`]
  for (const id of (await docker('ps', '-aq', ...filters)).split('\n').filter(Boolean))
    await docker('rm', '-f', id)
  for (const kind of ['network', 'volume', 'image'])
    for (const id of new Set(
      (await docker(kind, 'ls', '-q', ...filters)).split('\n').filter(Boolean),
    ))
      await docker(kind, 'rm', id)
}
const resticEnvironment = [
  '-e',
  'RESTIC_REPOSITORY',
  '-e',
  'RESTIC_PASSWORD',
  '-e',
  'AWS_ACCESS_KEY_ID',
  '-e',
  'AWS_SECRET_ACCESS_KEY',
  '-e',
  'AWS_DEFAULT_REGION',
]
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  console.info('Starting isolated platform and S3-compatible storage…')
  await docker(
    'run',
    '-d',
    '--name',
    storage,
    '--label',
    `dev.servitas.instance=${storage}`,
    '-e',
    'MINIO_ROOT_USER',
    '-e',
    'MINIO_ROOT_PASSWORD',
    '--entrypoint',
    '/bin/sh',
    'minio/minio:RELEASE.2025-09-07T16-13-09Z',
    '-c',
    'mkdir -p /data/backups && exec minio server /data',
  )
  const storageIP = JSON.parse(await docker('inspect', storage))[0].NetworkSettings.Networks.bridge
    .IPAddress as string
  assert.match(storageIP, /^\d+\.\d+\.\d+\.\d+$/)
  env.RESTIC_REPOSITORY = `s3:http://${storageIP}:9000/backups/servitas`
  await compose('up', '-d', '--build', '--wait', '--wait-timeout', '90')
  await waitReady()
  const preflight = await compose(
    'run',
    '--rm',
    '--no-deps',
    '-l',
    'dev.servitas.role=preflight',
    'worker',
    'node',
    'dist/preflight.js',
  )
  assert(preflight.includes('PASS Container runtime'))
  assert.equal((await api('/api/backups')).status, 401)
  const setup = await api('/api/auth/setup', {
    email: 'backups@example.com',
    password: 'backup-browser-test-passphrase',
    token: env.SERVITAS_BOOTSTRAP_TOKEN,
  })
  assert.equal(setup.status, 201)
  cookie = setup.headers.getSetCookie()[0]!.split(';')[0]!
  assert.equal((await api('/api/backups/destinations', {})).status, 400)
  browser = await chromium.launch()
  let context = await browser.newContext()
  let page = await context.newPage()
  page.setDefaultTimeout(30000)
  const browserErrors: string[] = []
  page.on('pageerror', (error) => browserErrors.push(error.message))
  async function login() {
    await page.goto(origin)
    await page.getByLabel('Email', { exact: true }).fill('backups@example.com')
    await page.getByLabel('Password', { exact: true }).fill('backup-browser-test-passphrase')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.waitForURL(origin + '/')
  }
  await login()
  await page.getByRole('link', { name: 'Backups', exact: true }).click()
  await page.getByText('Add storage destination', { exact: true }).click()
  await page.getByLabel('Destination name', { exact: true }).fill('Test offsite storage')
  await page.getByLabel('S3 endpoint', { exact: true }).fill(`http://${storageIP}:9000`)
  await page.getByLabel('Bucket', { exact: true }).fill('backups')
  await page.getByLabel('Access key', { exact: true }).fill(storageAccess)
  await page.getByLabel('Secret key', { exact: true }).fill(storageSecret)
  await page.getByLabel('Recovery password', { exact: true }).fill(recoveryPassword)
  await page
    .getByLabel('I saved the recovery password outside this server.', { exact: true })
    .check()
  await page.getByLabel('Allow unencrypted HTTP to this endpoint.', { exact: false }).check()
  await waitJob(await clickJob(page, 'Save and check destination', '/api/backups/destinations'))
  let listing = await (await api('/api/backups')).json()
  const destinationId = listing.destinations[0].id as string
  assert(listing.destinations[0].checkedAt)
  assert(!JSON.stringify(listing).includes(storageSecret))
  assert(!JSON.stringify(listing).includes(recoveryPassword))
  if (process.argv.includes('--beta')) {
    await testBetaApps({ page, origin, destinationId, api, waitJob, clickJob })
  } else {
    console.info('Installing the stateful TypeScript fixture and backing it up in the browser…')
    await page.goto(origin + '/apps/new')
    await page.getByLabel('Import configuration', { exact: true }).setInputFiles({
      name: 'servitas.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          version: 1,
          name: 'backup-demo',
          source: {
            type: 'git',
            url: repository.url,
            revision: repository.commit,
            dockerfile: 'Dockerfile',
          },
          port: 3000,
          healthCheck: '/health',
          access: 'public',
          volumes: [{ name: 'data', mountPath: '/data' }],
          requiredEnv: ['MESSAGE'],
        }),
      ),
    })
    await page.getByText('Environment, storage, and health checks', { exact: true }).click()
    await page
      .getByLabel('Environment variables', { exact: true })
      .fill('MESSAGE=Saved backup message')
    await page.getByRole('button', { name: 'Install app', exact: true }).click()
    await page.waitForURL(/\/apps\/[a-f0-9-]{36}$/)
    const appId = page.url().split('/').at(-1)!
    await waitApp(appId)
    const appPage = await context.newPage()
    await appPage.goto(`http://backup-demo.apps.localhost:${port}`)
    assert((await appPage.locator('body').innerText()).includes('Visits saved on disk: 1'))
    await page.getByRole('link', { name: 'Backups', exact: true }).last().click()
    await page.getByLabel('App', { exact: true }).selectOption(appId)
    await page.getByLabel('Backup destination', { exact: true }).selectOption(destinationId)
    await page
      .getByLabel('Allow this app to pause for manual and scheduled backups.', { exact: true })
      .check()
    // Fixture-only bulk data keeps transfer active long enough to interrupt the worker reliably.
    const installed = await waitApp(appId)
    const installedInfo = JSON.parse(await docker('inspect', installed.containerId!))[0]
    await docker(
      'run',
      '--rm',
      '-v',
      `${installedInfo.Mounts[0].Name}:/data`,
      'alpine:3.23',
      'dd',
      'if=/dev/urandom',
      'of=/data/payload.bin',
      'bs=1048576',
      'count=64',
    )
    const backupJob = await clickJob(page, 'Back up app', `/api/apps/${appId}/backups`)
    await interruptWorkerDuringHelper(backupJob, 'backup')
    await page.reload()
    await waitJob(backupJob)
    listing = await (await api('/api/backups')).json()
    const saved = listing.backups[0] as AppBackup
    assert(saved.snapshotId)
    assert(!JSON.stringify(listing).includes('Saved backup message'))
    console.info('Checking that incomplete snapshots never become restore points…')
    const partialId = randomUUID()
    const socketPath = (
      await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}')
    ).replace(/^unix:\/\//, '')
    const engine = runtime(socketPath)
    try {
      await runRestic(
        engine,
        storage,
        partialId,
        'incomplete',
        {
          ...listing.destinations[0],
          accessKey: storageAccess,
          secretKey: storageSecret,
          password: recoveryPassword,
        },
        ['backup', '--tag', 'servitas-pending', '/metadata', '/missing-volume'],
        () => {},
        {
          metadata: JSON.stringify({
            version: 1,
            appId,
            backupId: partialId,
            createdAt: Date.now(),
            configuration: {
              manifest: installed.manifest,
              environment: { MESSAGE: 'Saved backup message' },
            },
            imageId: installed.imageId,
            imageReference: null,
            commit: installed.commit,
          }),
        },
      )
      assert.fail('Expected an incomplete transfer.')
    } catch (error) {
      assert(error instanceof ResticError && error.exitCode === 3)
    } finally {
      await cleanupBackupHelpers(engine, storage, partialId)
    }
    await waitJob(
      await clickJob(page, 'Check and load backups', `/api/backups/destinations/${destinationId}`),
    )
    assert.equal((await (await api('/api/backups')).json()).backups.length, 1)
    await appPage.reload()
    assert((await appPage.locator('body').innerText()).includes('Visits saved on disk: 2'))
    await appPage.reload()
    const before = await waitApp(appId)
    console.info('Restoring into new volumes and preserving the previous data…')
    await page.getByRole('button', { name: 'Restore backup', exact: true }).first().click()
    assert(
      await page.getByRole('button', { name: 'Restore selected backup', exact: true }).isDisabled(),
    )
    await page.getByLabel('Type the app name to confirm', { exact: true }).fill('backup-demo')
    await page
      .getByLabel('Replace current app data and settings with this backup.', { exact: true })
      .check()
    const restoreJob = await clickJob(page, 'Restore selected backup', `/api/apps/${appId}/restore`)
    await interruptWorkerDuringHelper(restoreJob, 'restore')
    await waitJob(restoreJob)
    const restored = await waitApp(appId)
    assert.notEqual(restored.volumeSet, before.volumeSet)
    assert.notEqual(restored.containerId, before.containerId)
    const oldContainer = JSON.parse(await docker('inspect', before.containerId!))[0]
    assert.equal(oldContainer.State.Running, false)
    await appPage.reload()
    assert((await appPage.locator('body').innerText()).includes('Visits saved on disk: 2'))
    assert((await appPage.locator('body').innerText()).includes('Saved backup message'))
    const mounts = oldContainer.Mounts
    const retained = await docker(
      'run',
      '--rm',
      '-v',
      `${mounts[0].Name}:/data:ro`,
      'alpine:3.23',
      'cat',
      '/data/visits.txt',
    )
    assert.equal(retained, '3')
    console.info('Checking wrong-password failure and browser credential recovery…')
    async function credentials(password: string, expected = 'succeeded') {
      await page.getByRole('button', { name: 'Update credentials', exact: true }).click()
      await page.getByLabel('Replacement access key', { exact: true }).fill(storageAccess)
      await page.getByLabel('Replacement secret key', { exact: true }).fill(storageSecret)
      await page.getByLabel('Existing recovery password', { exact: true }).fill(password)
      await page
        .getByLabel('I have the recovery password saved outside this server.', { exact: true })
        .check()
      const job = await waitJob(
        await clickJob(
          page,
          'Save credentials',
          `/api/backups/destinations/${destinationId}/credentials`,
        ),
        expected,
      )
      if (expected === 'failed') assert.match(job.message, /Update the destination credentials/)
    }
    await credentials('wrong-recovery-password-for-test', 'failed')
    await page.getByRole('button', { name: 'Restore backup', exact: true }).first().click()
    await page.getByLabel('Type the app name to confirm', { exact: true }).fill('backup-demo')
    await page
      .getByLabel('Replace current app data and settings with this backup.', { exact: true })
      .check()
    await waitJob(
      await clickJob(page, 'Restore selected backup', `/api/apps/${appId}/restore`),
      'failed',
    )
    const unchanged = await waitApp(appId)
    assert.equal(unchanged.containerId, restored.containerId)
    assert.equal(unchanged.volumeSet, restored.volumeSet)
    await appPage.reload()
    assert((await appPage.locator('body').innerText()).includes('Visits saved on disk: 3'))
    await credentials(recoveryPassword)
    await page.getByText('Daily schedule', { exact: true }).click()
    await page
      .getByLabel('Allow this app to pause for manual and scheduled backups.', { exact: true })
      .check()
    await page.getByLabel('Enable daily backups', { exact: true }).check()
    await page.getByRole('button', { name: 'Save schedule', exact: true }).click()
    await page.getByText('Daily backup settings saved.', { exact: true }).waitFor()
    listing = await (await api('/api/backups')).json()
    assert(listing.schedules[0].enabled)
    mkdirSync('.context/screenshots', { recursive: true })
    await page.screenshot({ path: '.context/screenshots/backups-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    await page.screenshot({ path: '.context/screenshots/backups-mobile.png', fullPage: true })
    const platformJob = await clickJob(
      page,
      'Back up platform',
      `/api/backups/destinations/${destinationId}`,
    )
    await waitJob(platformJob)
    listing = await (await api('/api/backups')).json()
    const checkpoint = (listing.operations as BackupOperation[]).find(
      (operation) => operation.job.id === platformJob,
    )!.snapshotId!
    assert.match(checkpoint, /^[a-f0-9]{64}$/)
    console.info('Recovering platform metadata and app data into a fresh installation…')
    await context.close()
    await compose('down', '--volumes', '--remove-orphans')
    await ownedCleanup(originalProject)
    project = recoveredProject
    await compose('create', '--build', 'web', 'worker', 'caddy')
    await docker(
      'run',
      '--rm',
      ...resticEnvironment,
      '-v',
      `${project}_platform-data:/restore`,
      'restic/restic:0.19.1',
      'restore',
      `${checkpoint}:/platform`,
      '--target',
      '/restore',
      '--verify',
    )
    await compose(
      'run',
      '--rm',
      '--no-deps',
      'worker',
      'node',
      'dist/recover-platform.js',
      '--confirm-offline-recovery',
    )
    await compose('up', '-d', '--wait', '--wait-timeout', '90')
    await waitReady()
    cookie = ''
    const loginResponse = await api('/api/auth/login', {
      email: 'backups@example.com',
      password: 'backup-browser-test-passphrase',
    })
    assert.equal(loginResponse.status, 200)
    cookie = loginResponse.headers.getSetCookie()[0]!.split(';')[0]!
    listing = await (await api('/api/backups')).json()
    assert.equal(listing.apps[0].status, 'removed')
    assert.equal(listing.schedules[0].enabled, false)
    assert.equal(listing.backups[0].snapshotId, saved.snapshotId)
    context = await browser.newContext()
    page = await context.newPage()
    page.setDefaultTimeout(30000)
    page.on('pageerror', (error) => browserErrors.push(error.message))
    await login()
    await page.getByRole('link', { name: 'Backups', exact: true }).click()
    await waitJob(
      await clickJob(page, 'Check and load backups', `/api/backups/destinations/${destinationId}`),
    )
    await page.getByRole('button', { name: 'Restore backup', exact: true }).first().click()
    await page.getByLabel('Type the app name to confirm', { exact: true }).fill('backup-demo')
    await page
      .getByLabel('Replace current app data and settings with this backup.', { exact: true })
      .check()
    await waitJob(await clickJob(page, 'Restore selected backup', `/api/apps/${appId}/restore`))
    await waitApp(appId)
    const recoveredPage = await context.newPage()
    await recoveredPage.goto(`http://backup-demo.apps.localhost:${port}`)
    assert((await recoveredPage.locator('body').innerText()).includes('Visits saved on disk: 2'))
    assert((await recoveredPage.locator('body').innerText()).includes('Saved backup message'))
    assert.deepEqual(browserErrors, [])
    console.info(
      'Backups passed: browser destination setup, encrypted S3 snapshots, incomplete-snapshot exclusion, interrupted backup/restore recovery, wrong-password isolation and credential repair, typed restore confirmation, retained original data, schedules, preflight, and complete platform/app recovery into fresh storage.',
    )
  }
} catch (error) {
  try {
    console.error(await compose('logs', '--tail', '50'))
    console.error(JSON.stringify(await (await api('/api/backups')).json()))
  } catch {}
  throw error
} finally {
  await browser?.close()
  for (const instance of [originalProject, recoveredProject]) {
    project = instance
    try {
      await compose('down', '--volumes', '--remove-orphans')
      await ownedCleanup(instance)
    } catch (error) {
      console.error(`Test cleanup failed for ${instance}: ${error}`)
    }
  }
  await docker('rm', '-f', storage).catch(() => {})
  await repository.close()
}
