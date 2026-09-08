import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, type Page } from '@playwright/test'
import { appTemplates } from '../packages/contracts/src/templates'
import type { Job } from '../packages/contracts/src/index'

// Uses the isolated platform and backup destination owned by test-backups.ts.
export async function testBetaApps(options: {
  page: Page
  origin: string
  destinationId: string
  api: (path: string) => Promise<Response>
  waitJob: (id: string, expected?: string) => Promise<Job>
  clickJob: (page: Page, name: string, path: string) => Promise<string>
}) {
  const { page, origin, destinationId, api, waitJob, clickJob } = options
  mkdirSync('.context/screenshots', { recursive: true })
  await page.goto(origin + '/apps/templates')
  await page.screenshot({ path: '.context/screenshots/templates-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '.context/screenshots/templates-mobile.png', fullPage: true })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.setViewportSize({ width: 1280, height: 900 })
  for (const template of appTemplates) {
    console.info(`Beta: installing ${template.title} from its catalog entry…`)
    await page.goto(origin + '/apps/templates')
    await page.getByRole('link', { name: `Configure ${template.title}`, exact: true }).click()
    await expect(page.getByLabel('App name', { exact: true })).toHaveValue(template.id)
    await expect(page.getByRole('radio', { name: /Private/ })).toBeChecked()
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/api/apps') && r.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Install app', exact: true }).click()
    const installed = await (await response).json()
    assert(installed.id, JSON.stringify(installed))
    const id = installed.id as string
    await page.waitForURL(origin + `/apps/${id}`)
    const details = await (await api(`/api/apps/${id}`)).json()
    await waitJob(details.jobs[0].id)
    await page.reload()
    const popup = page.waitForEvent('popup')
    await page.getByRole('link', { name: 'Open app', exact: true }).click()
    const appPage = await popup
    await appPage.waitForLoadState('domcontentloaded')
    try {
      const marker = `Saved record for ${template.id}`
      const later = `Record after backup for ${template.id}`
      if (template.id === 'memos' || template.id === 'uptime-kuma') {
        if (template.id === 'uptime-kuma') {
          await appPage.getByText('SQLite', { exact: true }).click()
          await appPage.getByRole('button', { name: 'Next', exact: true }).click()
        }
        await appPage.getByLabel('Username', { exact: true }).fill('betaowner')
        await appPage.getByLabel('Password', { exact: true }).fill('beta-app-test-passphrase')
        if (template.id === 'uptime-kuma')
          await appPage
            .getByLabel('Repeat Password', { exact: true })
            .fill('beta-app-test-passphrase')
        await appPage
          .getByRole('button', {
            name: template.id === 'memos' ? 'Create admin account' : 'Create',
            exact: true,
          })
          .click()
      }
      async function addRecord(text: string) {
        if (template.id === 'memos') {
          await appPage.locator('[contenteditable="true"]').first().fill(text)
          await appPage.getByRole('button', { name: 'Save', exact: true }).click()
          await expect(appPage.getByText(text, { exact: true })).toBeVisible()
        } else if (template.id === 'uptime-kuma') {
          await appPage.getByRole('link', { name: 'Add New Monitor', exact: true }).click()
          await appPage.locator('#name').fill(text)
          await appPage.locator('#url').fill('http://127.0.0.1:3001/')
          await appPage.getByRole('button', { name: 'Save', exact: true }).click()
          await expect(appPage.getByText(text, { exact: true }).first()).toBeVisible()
        } else {
          await appPage
            .getByRole('link', { name: 'Base64 string encoder/decoder', exact: true })
            .first()
            .click()
          await appPage.getByPlaceholder('Put your string here...').fill(text)
          await expect(
            appPage.getByPlaceholder('The base64 encoding of your string will be here'),
          ).toHaveValue(Buffer.from(text).toString('base64'))
        }
      }
      async function verifyRecord() {
        // Restoring revokes the Servitas app grant; reopen through the platform's browser handoff.
        await appPage.goto(origin + `/open/${id}`)
        await appPage.waitForLoadState('domcontentloaded')
        if (template.id !== 'it-tools')
          await appPage
            .getByLabel('Username', { exact: true })
            .or(appPage.getByText(marker, { exact: true }))
            .first()
            .waitFor()
        if (await appPage.getByLabel('Username', { exact: true }).isVisible()) {
          await appPage.getByLabel('Username', { exact: true }).fill('betaowner')
          await appPage.getByLabel('Password', { exact: true }).fill('beta-app-test-passphrase')
          await appPage.getByRole('button', { name: /^(Sign in|Login)$/i }).click()
        }
        if (template.id === 'it-tools') await addRecord(marker)
        else await expect(appPage.getByText(marker, { exact: true }).first()).toBeVisible()
      }
      await addRecord(marker)
      console.info(
        `Beta: ${template.title} ${template.manifest.volumes.length ? 'created a saved record' : 'converted text'}; checking stop/start, logs, and configuration redeployment…`,
      )
      await waitJob(await clickJob(page, 'Stop app', `/api/apps/${id}/actions`))
      await page.reload()
      await waitJob(await clickJob(page, 'Start app', `/api/apps/${id}/actions`))
      await page.reload()
      await verifyRecord()
      await page.getByRole('button', { name: 'Runtime logs', exact: true }).click()
      await expect(page.getByRole('region', { name: 'Runtime logs', exact: true })).toBeVisible()
      await page.getByRole('link', { name: 'Update app', exact: true }).click()
      await page.getByText('Environment, storage, and health checks', { exact: true }).click()
      await page
        .getByLabel('Memory (MB)', { exact: true })
        .fill(String(template.manifest.resources.memoryMb + 64))
      await page.getByRole('button', { name: 'Review update', exact: true }).click()
      if (template.manifest.volumes.length)
        await page
          .getByLabel(
            'I understand this update needs a maintenance window and may change app data.',
            { exact: true },
          )
          .check()
      await waitJob(await clickJob(page, 'Deploy update', `/api/apps/${id}/updates`))
      await page.reload()
      await verifyRecord()
      await page.goto(origin + `/backups?app=${id}`)
      await page.getByLabel('App', { exact: true }).selectOption(id)
      await page.getByLabel('Backup destination', { exact: true }).selectOption(destinationId)
      await page
        .getByLabel('Allow this app to pause for manual and scheduled backups.', { exact: true })
        .check()
      await waitJob(await clickJob(page, 'Back up app', `/api/apps/${id}/backups`))
      await verifyRecord()
      if (template.manifest.volumes.length) await addRecord(later)
      async function restore() {
        await page.goto(origin + `/backups?app=${id}`)
        await page.getByRole('button', { name: 'Restore backup', exact: true }).first().click()
        await page.getByLabel('Type the app name to confirm', { exact: true }).fill(template.id)
        await page
          .getByLabel('Replace current app data and settings with this backup.', { exact: true })
          .check()
        await waitJob(await clickJob(page, 'Restore selected backup', `/api/apps/${id}/restore`))
        await verifyRecord()
        if (template.manifest.volumes.length)
          await expect(appPage.getByText(later, { exact: true })).toHaveCount(0)
      }
      await restore()
      console.info(
        `Beta: ${template.title} restored ${template.manifest.volumes.length ? 'saved records' : 'deployment settings'}; checking removal and browser recovery…`,
      )
      await page.goto(origin + `/apps/${id}`)
      await page.getByRole('button', { name: 'Remove app', exact: true }).click()
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Remove app', exact: true })
        .click()
      await page.waitForURL(origin + '/')
      await restore()
      await appPage.screenshot({
        path: `.context/screenshots/beta-${template.id}.png`,
        fullPage: true,
      })
    } catch (error) {
      writeFileSync(
        `.context/beta-${template.id}-failure.txt`,
        await appPage.locator('body').innerText(),
      )
      await appPage.screenshot({
        path: `.context/screenshots/beta-${template.id}-failure.png`,
        fullPage: true,
      })
      throw error
    }
    await appPage.close()
  }
  console.info(
    'Beta apps passed: catalog installs, native browser setup/use, stop/start, logs, configuration redeployment, backups, verified data restore, and removed-app recovery.',
  )
}
