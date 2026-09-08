import type Docker from 'dockerode'
import type { DatabaseSync } from 'node:sqlite'
import type { HostedApp } from '@servitas/contracts'
import {
  appEnvironment,
  finishJob,
  getApp,
  listApps,
  ownsLease,
  recordAppObservation,
  redact,
  renewLease,
  reportProgress,
  updateApp,
  type ClaimedJob,
} from '@servitas/core'
import { appContainers, connectAppNetwork, containerLogs, ownedContainer } from './runtime'
import { resolveImage } from './source'
import { createAppContainer, waitForHealthy } from './container'

export async function runAppJob(
  db: DatabaseSync,
  claim: ClaimedJob,
  docker: Docker,
  instance: string,
  key: Buffer,
  publish: (apps: HostedApp[]) => Promise<void>,
) {
  let app = getApp(db, claim.job.appId!)!
  const environment = appEnvironment(db, app.id, key)
  const checkLease = () => {
    if (!ownsLease(db, claim)) throw new Error('The operation lease has expired.')
  }
  const progress = (message: string) => {
    if (!reportProgress(db, claim, redact(message, environment))) checkLease()
  }
  const saveLogs = async () => {
    try {
      const existing = await ownedContainer(docker, instance, app)
      if (existing) {
        const logs = redact(await containerLogs(docker, existing.container), environment)
        updateApp(db, claim, { logs, logsAt: Date.now() })
      }
    } catch {
      // A log-read failure must not overwrite the operation result.
    }
  }
  const timer = setInterval(() => renewLease(db, claim), 5000)
  try {
    checkLease()
    if (claim.job.kind === 'app.stop' || claim.job.kind === 'app.remove') {
      progress('Removing the route before stopping the app.')
      await publish(listApps(db)) // desiredState already hides the upstream.
      checkLease()
      const existing = await ownedContainer(docker, instance, app)
      if (existing) {
        if (existing.info.State.Running) await existing.container.stop({ t: 10 })
        checkLease()
        await saveLogs()
        if (claim.job.kind === 'app.remove') await existing.container.remove({ v: false })
      }
      if (claim.job.kind === 'app.remove') {
        for (const container of await appContainers(docker, instance, app.id)) {
          checkLease()
          if ((await container.inspect()).State.Running) await container.stop({ t: 10 })
          await container.remove({ v: false })
        }
      }
      const removed = claim.job.kind === 'app.remove'
      updateApp(db, claim, {
        status: removed ? 'removed' : 'stopped',
        ...(removed ? { containerId: null } : {}),
        message: removed ? 'App removed. Persistent data retained.' : 'App stopped.',
      })
      await publish(listApps(db))
      finishJob(
        db,
        claim,
        'succeeded',
        removed ? 'App removed. Persistent data retained.' : 'App stopped.',
      )
      return
    }
    if (claim.job.kind === 'app.restart') {
      updateApp(db, claim, { status: 'deploying', message: 'Restarting the app.' })
      await publish(listApps(db))
      const current = await ownedContainer(docker, instance, app)
      checkLease()
      if (current?.info.State.Running) await current.container.stop({ t: 10 })
    }
    updateApp(db, claim, { status: 'deploying', message: 'Preparing the app.' })
    await connectAppNetwork(docker, instance, app)
    checkLease()
    const image = await resolveImage(docker, instance, app, progress, (commit) =>
      updateApp(db, claim, { commit }),
    )
    updateApp(db, claim, image)
    app = getApp(db, app.id)!
    checkLease()
    let existing = await ownedContainer(docker, instance, app)
    if (!existing) {
      progress('Creating the app container and attaching storage.')
      const container = await createAppContainer(docker, instance, app, environment)
      updateApp(db, claim, { containerId: container.id })
      existing = { container, info: await container.inspect() }
    } else updateApp(db, claim, { containerId: existing.container.id })
    checkLease()
    if (!existing.info.State.Running) await existing.container.start()
    progress('Waiting for the HTTP health check.')
    await waitForHealthy(existing.container, instance, app, checkLease, progress)
    progress('Health check passed. Publishing the app route.')
    checkLease()
    const ready = { ...getApp(db, app.id)!, status: 'running' as const }
    await publish(listApps(db).map((item) => (item.id === app.id ? ready : item)))
    updateApp(db, claim, { status: 'running', message: 'App is running.' })
    await saveLogs()
    finishJob(db, claim, 'succeeded', 'App is running and its route is ready.')
  } catch (error) {
    if (!ownsLease(db, claim)) return
    const message = redact(
      error instanceof Error ? error.message : 'The app operation failed.',
      environment,
    ).slice(0, 2000)
    // A failed installation stays private and does not keep consuming resources.
    if (['app.deploy', 'app.start', 'app.restart'].includes(claim.job.kind)) {
      try {
        const existing = await ownedContainer(docker, instance, app)
        if (existing?.info.State.Running) await existing.container.stop({ t: 5 })
      } catch {
        /* Reconciliation will observe actual state after Docker reconnects. */
      }
    }
    updateApp(db, claim, { status: 'failed', message })
    await saveLogs()
    finishJob(db, claim, 'failed', message)
    try {
      await publish(listApps(db))
    } catch {
      /* Last valid routes remain loaded; retry will republish. */
    }
  } finally {
    clearInterval(timer)
  }
}

export async function observeApps(
  db: DatabaseSync,
  docker: Docker,
  instance: string,
  key: Buffer,
  publish: (apps: HostedApp[]) => Promise<void>,
) {
  for (const app of listApps(db)) {
    const active = db
      .prepare("SELECT 1 FROM jobs WHERE app_id = ? AND status IN ('queued','running')")
      .get(app.id)
    if (active) continue
    try {
      // Recover cleanup after a crash between route activation and stopping an old container.
      for (const container of await appContainers(docker, instance, app.id)) {
        if (
          container.id !== app.containerId ||
          app.desiredState !== 'running' ||
          app.status === 'failed'
        ) {
          if ((await container.inspect()).State.Running) await container.stop({ t: 5 })
        }
      }
      if (!app.containerId || ['pending', 'deploying', 'failed'].includes(app.status)) continue
      const existing = await ownedContainer(docker, instance, app)
      if (existing) {
        await connectAppNetwork(docker, instance, app)
        const status = existing.info.State.Running ? 'running' : 'stopped'
        recordAppObservation(
          db,
          app.id,
          status,
          redact(await containerLogs(docker, existing.container), appEnvironment(db, app.id, key)),
        )
      } else recordAppObservation(db, app.id, 'unknown', app.logs)
    } catch {
      recordAppObservation(db, app.id, 'unknown', app.logs)
    }
  }
  await publish(listApps(db))
}
