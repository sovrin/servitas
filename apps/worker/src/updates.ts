import type Docker from 'dockerode'
import type { DatabaseSync } from 'node:sqlite'
import type { HostedApp } from '@servitas/contracts'
import {
  activateRevision,
  finishJob,
  getApp,
  getRevision,
  listApps,
  ownsLease,
  redact,
  renewLease,
  reportProgress,
  revisionEnvironment,
  updateApp,
  updateRevision,
  type ClaimedJob,
} from '@servitas/core'
import { createAppContainer, waitForHealthy } from './container'
import { connectAppNetwork, containerLogs, ownedContainer, resourceName } from './runtime'
import { resolveImage } from './source'

export async function runUpdateJob(
  db: DatabaseSync,
  claim: ClaimedJob,
  docker: Docker,
  instance: string,
  key: Buffer,
  publish: (apps: HostedApp[]) => Promise<void>,
) {
  let revision = getRevision(db, claim.job.id)!
  const environment = revisionEnvironment(db, revision.id, key)
  const secrets = {
    ...Object.fromEntries(
      Object.values(revisionEnvironment(db, revision.id, key, true)).map((value, i) => [
        `previous_${i}`,
        value,
      ]),
    ),
    ...environment,
  }
  const checkLease = () => {
    if (!ownsLease(db, claim)) throw new Error('The operation lease has expired.')
  }
  const progress = (message: string) => {
    if (!reportProgress(db, claim, redact(message, secrets))) checkLease()
  }
  const candidate = (): HostedApp => ({
    ...revision.previous,
    manifest: revision.manifest,
    environmentNames: revision.environmentNames,
    imageId: revision.imageId,
    commit: revision.commit,
    containerId: revision.containerId,
    containerName: revision.containerName || resourceName(instance, revision.id),
    status: 'running',
    desiredState: 'running',
  })
  const refresh = () => {
    revision = getRevision(db, revision.id)!
  }
  const timer = setInterval(() => renewLease(db, claim), 5000)
  try {
    checkLease()
    if (revision.phase !== 'applied') {
      await connectAppNetwork(docker, instance, revision.previous)
      if (!revision.imageId) {
        updateRevision(db, claim, { phase: 'building' })
        const image = await resolveImage(docker, instance, candidate(), progress, (commit) =>
          updateRevision(db, claim, { commit }),
        )
        updateRevision(db, claim, image)
        refresh()
      }
      const stateful = !!(
        revision.manifest.volumes.length || revision.previous.manifest.volumes.length
      )
      if (stateful) {
        // Persist maintenance before stopping; recovery must never expose the old upstream here.
        if (!['maintenance', 'started'].includes(revision.phase))
          updateRevision(db, claim, { phase: 'maintenance' })
        updateApp(db, claim, {
          status: 'deploying',
          message: 'Update maintenance window. Persistent data is retained.',
        })
        progress(
          'Withdrawing traffic and stopping the previous version before attaching shared storage.',
        )
        await publish(listApps(db))
        const previous = await ownedContainer(docker, instance, revision.previous)
        checkLease()
        if (previous?.info.State.Running) await previous.container.stop({ t: 10 })
      }
      checkLease()
      let existing = await ownedContainer(docker, instance, candidate())
      if (!existing) {
        progress('Creating the replacement container.')
        const container = await createAppContainer(docker, instance, candidate(), environment)
        existing = { container, info: await container.inspect() }
      }
      updateRevision(db, claim, {
        containerId: existing.container.id,
        containerName: candidate().containerName,
      })
      refresh()
      // A crash after start may mean migrations ran. Persist that possibility before starting.
      updateRevision(db, claim, { phase: 'started', requiresRecovery: stateful })
      checkLease()
      if (!existing.info.State.Running) await existing.container.start()
      progress('Checking the replacement before switching traffic.')
      await waitForHealthy(existing.container, instance, candidate(), checkLease, progress)
      const logs = redact(await containerLogs(docker, existing.container), secrets)
      updateRevision(db, claim, { logs })
      checkLease()
      await publish(listApps(db).map((app) => (app.id === revision.appId ? candidate() : app)))
      activateRevision(db, claim)
      refresh()
    }
    await publish(listApps(db))
    progress('Update is active. Stopping the previous container.')
    const previous = await ownedContainer(docker, instance, revision.previous)
    checkLease()
    if (previous?.info.State.Running && previous.container.id !== revision.containerId)
      await previous.container.stop({ t: 10 })
    finishJob(
      db,
      claim,
      'succeeded',
      'Update applied. The previous image and settings are available for recovery.',
    )
  } catch (error) {
    if (!ownsLease(db, claim)) return
    refresh()
    let message = redact(error instanceof Error ? error.message : 'Update failed.', secrets).slice(
      0,
      2000,
    )
    if (revision.phase === 'applied') {
      finishJob(
        db,
        claim,
        'failed',
        `The update is active, but previous-container cleanup failed: ${message}`,
      )
      return
    }
    progress(`Replacement failed: ${message} Stopping the candidate.`)
    try {
      const existing = await ownedContainer(docker, instance, candidate())
      if (existing?.info.State.Running)
        await existing.container.stop({ t: 5, abortSignal: AbortSignal.timeout(15_000) })
      progress('Candidate stopped. Collecting its logs.')
      if (existing)
        updateRevision(db, claim, {
          logs: redact(await containerLogs(docker, existing.container), secrets),
        })
    } catch {
      /* Keep the failure and recovery requirement durable if Docker is unavailable. */
    }
    checkLease()
    updateRevision(db, claim, { phase: 'failed' })
    if (revision.requiresRecovery) {
      message += ' App stopped. Review data compatibility before recovering the previous version.'
      updateApp(db, claim, { status: 'failed', message })
    } else if (getApp(db, revision.appId)!.status === 'deploying') {
      // No replacement has started: the previous code can safely use its untouched data.
      const previous = await ownedContainer(docker, instance, revision.previous)
      if (previous && revision.previous.status === 'running') {
        if (!previous.info.State.Running) await previous.container.start()
        await waitForHealthy(previous.container, instance, revision.previous, checkLease)
      }
      updateApp(db, claim, {
        status: revision.previous.status,
        message: `Update failed. Previous version retained. ${message}`,
      })
    } else updateApp(db, claim, { message: `Update failed. Previous version retained. ${message}` })
    try {
      await publish(listApps(db))
    } catch {
      /* The last valid gateway configuration remains loaded. */
    }
    finishJob(db, claim, 'failed', message)
  } finally {
    clearInterval(timer)
  }
}
