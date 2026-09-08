import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { parseAppConfiguration } from '../../packages/contracts/src/configuration'

test('owner setup, protected jobs, persistent browser progress, and logout', async ({
  page,
  request,
}) => {
  const origin = 'http://127.0.0.1:3100'
  const browserErrors: string[] = []
  page.on('pageerror', (error) => browserErrors.push(error.message))
  expect((await request.get('/api/platform')).status()).toBe(401)
  expect(
    (
      await request.post('/api/jobs', { headers: { origin }, data: { kind: 'platform.check' } })
    ).status(),
  ).toBe(401)
  expect(
    (
      await request.post('/api/auth/setup', {
        headers: { origin: 'https://elsewhere.example' },
        data: {},
      })
    ).status(),
  ).toBe(403)
  expect((await request.get('/api/apps')).status()).toBe(401)
  expect((await request.get('/api/backups')).status()).toBe(401)
  expect((await request.get('/api/repositories/unknown')).status()).toBe(401)
  expect(
    (await request.post('/api/repositories', { headers: { origin }, data: {} })).status(),
  ).toBe(401)
  const credentials = { email: 'owner@example.com', password: 'a long testing passphrase' }
  expect(
    (
      await request.post('/api/auth/setup', {
        headers: { origin },
        data: { ...credentials, token: 'x'.repeat(32) },
      })
    ).status(),
  ).toBe(401)

  await page.goto('/')
  await expect(page).toHaveURL(/\/setup$/)
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Email', { exact: true })).toBeFocused()
  await page.getByLabel('Email', { exact: true }).fill(credentials.email)
  await page.getByLabel('Password', { exact: true }).fill(credentials.password)
  await page.getByLabel('Installation key').fill('test-installation-key-not-for-production')
  await page.getByRole('button', { name: 'Create owner account' }).click()
  await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible()
  expect(
    (
      await page.request.post('/api/auth/setup', {
        headers: { origin },
        data: { ...credentials, token: 'test-installation-key-not-for-production' },
      })
    ).status(),
  ).toBe(409)
  expect(
    (
      await page.request.post('/api/jobs', { headers: { origin }, data: { kind: 'unknown' } })
    ).status(),
  ).toBe(400)
  expect(
    (
      await page.request.post('/api/jobs', {
        headers: { origin: 'https://elsewhere.example' },
        data: { kind: 'platform.check' },
      })
    ).status(),
  ).toBe(403)
  expect(
    (
      await page.request.post('/api/jobs', { headers: { origin }, data: { kind: 'app.deploy' } })
    ).status(),
  ).toBe(400)
  expect(
    (
      await page.request.post('/api/repositories', {
        headers: { origin: 'https://elsewhere.example' },
        data: {},
      })
    ).status(),
  ).toBe(403)
  expect(
    (
      await page.request.post('/api/repositories', {
        headers: { origin },
        data: { source: { type: 'git', url: 'file:///etc', revision: 'main' } },
      })
    ).status(),
  ).toBe(400)
  for (const path of [
    '/api/backups/destinations',
    '/api/backups/destinations/unknown',
    '/api/backups/destinations/unknown/credentials',
    '/api/apps/unknown/backups',
    '/api/apps/unknown/restore',
    '/api/apps/unknown/backup-schedule',
  ])
    expect(
      (
        await page.request.post(path, {
          headers: { origin: 'https://elsewhere.example' },
          data: {},
        })
      ).status(),
    ).toBe(403)
  const cookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'servitas_session',
  )!
  expect(cookie.httpOnly).toBe(true)
  expect(cookie.sameSite).toBe('Lax')

  await page.goto('/apps/templates')
  await expect(page.getByRole('heading', { name: 'App templates', exact: true })).toBeVisible()
  const downloadPending = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download Memos configuration', exact: true }).click()
  const download = await downloadPending
  const downloadedPath = (await download.path())!
  const configuration = parseAppConfiguration(
    readFileSync(downloadedPath, 'utf8'),
    download.suggestedFilename(),
  )
  expect(configuration.access).toBe('private')
  expect(configuration.source?.type).toBe('image')
  await page.getByRole('link', { name: 'Configure Memos', exact: true }).click()
  await expect(page.getByLabel('App name', { exact: true })).toHaveValue('memos')
  await page.getByLabel('Import configuration', { exact: true }).setInputFiles({
    name: download.suggestedFilename(),
    mimeType: 'application/json',
    buffer: readFileSync(downloadedPath),
  })
  await expect(page.locator('main [role="status"]')).toContainText('Imported')
  await page.getByLabel('App name', { exact: true }).fill('my-notes')
  await expect(page.getByLabel('App name', { exact: true })).toHaveValue('my-notes')
  await page.goto('/apps/new?template=unknown')
  await expect(page.getByRole('alert')).toContainText('unavailable')
  await page.goto('/')
  await page.getByRole('link', { name: 'Check your platform' }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Run platform check' }).click()
  await expect(page).toHaveURL(/\/operations\//)
  const operationUrl = page.url()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible()
  await expect(page.getByText('Platform database is available.')).toBeVisible()
  if (process.env.SERVITAS_REQUIRE_DOCKER === '1')
    await expect(page.getByText(/Runtime capacity: .* CPUs, .* MB memory/)).toBeVisible()
  await expect(page.locator('main [role="status"]')).toContainText(
    /Platform checks passed|platform check could not finish/,
  )
  if (process.env.SERVITAS_REQUIRE_DOCKER === '1')
    await expect(page.locator('main [role="status"]')).toContainText('Platform checks passed')
  await page.getByRole('link', { name: 'Back to platform' }).click()
  await expect(page.getByRole('link', { name: /Platform check/ })).toBeVisible()
  mkdirSync('.context/screenshots', { recursive: true })
  await page.screenshot({ path: '.context/screenshots/platform-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '.context/screenshots/platform-mobile.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  expect((await page.request.get('/api/platform')).status()).toBe(401)
  await page.getByLabel('Email', { exact: true }).fill(credentials.email)
  await page.getByLabel('Password', { exact: true }).fill(credentials.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible()
  await page.goto(operationUrl)
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible()
  expect(browserErrors).toEqual([])
})
