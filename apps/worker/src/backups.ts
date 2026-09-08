import { backup as copyDatabase, type DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, copyFile, rm, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Docker from 'dockerode'
import type { HostedApp } from '@servitas/contracts'
import { backupMetadataSchema, type BackupMetadata } from '@servitas/contracts/backups'
import {
  activateRestoredApp,
  appEnvironment,
  backupDestination,
  backupMetadata,
  finishJob,
  getApp,
  getBackupOperation,
  getJob,
  listAppBackups,
  listApps,
  markDestinationChecked,
  ownsLease,
  recordAppBackup,
  redact,
  renewLease,
  reportProgress,
  updateApp,
  updateBackupOperation,
  type ClaimedJob,
} from '@servitas/core'
import {
  appContainers,
  appVolumeName,
  ensureVolumes,
  isNotFound,
  ownedContainer,
  resourceName,
  connectAppNetwork,
} from './runtime'
import { createAppContainer, waitForHealthy } from './container'
import { resolveImage } from './source'
import {
  BACKUP_JOB_LABEL,
  ResticError,
  backupVolumeMounts,
  cleanupBackupHelpers,
  runRestic,
} from './backup-runtime'
import { INSTANCE_LABEL, ROLE_LABEL } from './runtime'

function snapshotFromOutput(output: string) {
  const summary = output
    .trim()
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .findLast((row) => row?.message_type === 'summary')
  if (!/^[a-f0-9]{64}$/.test(summary?.snapshot_id))
    throw new Error('Backup command did not report a complete snapshot.')
  return summary.snapshot_id as string
}
export async function reapBackupHelpers(db: DatabaseSync, docker: Docker, instance: string) {
  const helpers = await docker.listContainers({
    all: true,
    filters: { label: [`${INSTANCE_LABEL}=${instance}`, `${ROLE_LABEL}=backup`] },
  })
  for (const id of new Set(
    helpers.map((helper) => helper.Labels[BACKUP_JOB_LABEL]).filter(Boolean),
  )) {
    const job = getJob(db, id!)
    if (!job || ['failed', 'succeeded'].includes(job.status))
      await cleanupBackupHelpers(docker, instance, id!)
  }
}
export async function runBackupJob(
  db: DatabaseSync,
  claim: ClaimedJob,
  docker: Docker,
  instance: string,
  key: Buffer,
  dataDir: string,
  publish: (apps: HostedApp[]) => Promise<void>,
) {
  let operation = getBackupOperation(db, claim.job.id)!
  const destination = backupDestination(db, operation.destinationId, key)
  const previous = operation.previous
  const secrets = {
    accessKey: destination.accessKey,
    secretKey: destination.secretKey,
    password: destination.password,
    ...(previous ? appEnvironment(db, previous.id, key) : {}),
  }
  const checkLease = () => {
    if (!ownsLease(db, claim)) throw new Error('The operation lease has expired.')
  }
  const progress = (message: string) => {
    if (!reportProgress(db, claim, redact(message, secrets))) checkLease()
  }
  const save = (changes: Parameters<typeof updateBackupOperation>[2]) => {
    updateBackupOperation(db, claim, changes)
    operation = getBackupOperation(db, claim.job.id)!
  }
  const run = (step: string, command: string[], options: Parameters<typeof runRestic>[7] = {}) =>
    runRestic(docker, instance, claim.job.id, step, destination, command, checkLease, options)
  const commitSnapshot = async (kind: 'app' | 'platform', snapshotId: string) => {
    // Restic can save an incomplete snapshot before exiting nonzero. Only successful
    // transfers receive the discoverable tag. Retagging produces a new snapshot ID.
    const tag = `servitas-${kind}`
    await run(`${kind}-commit`, ['tag', '--add', tag, '--remove', 'servitas-pending', snapshotId])
    const snapshots = JSON.parse(
      await run(`${kind}-committed`, ['snapshots', '--tag', `${tag},job:${claim.job.id}`]),
    ) as { id: string }[]
    if (
      !Array.isArray(snapshots) ||
      snapshots.length !== 1 ||
      !/^[a-f0-9]{64}$/.test(snapshots[0]!.id)
    )
      throw new Error('Could not identify the completed backup snapshot.')
    return snapshots[0]!.id
  }
  const timer = setInterval(() => renewLease(db, claim), 5000)
  const resumePrevious = async () => {
    if (!previous) return
    const existing = await ownedContainer(docker, instance, previous)
    checkLease()
    if (previous.status === 'running' && previous.desiredState === 'running') {
      if (!existing)
        throw new Error('The original container is unavailable. Use restore or retry deployment.')
      if (!existing.info.State.Running) await existing.container.start()
      await waitForHealthy(existing.container, instance, previous, checkLease, progress)
    }
    updateApp(db, claim, {
      status: previous.status,
      message: 'Backup operation finished. Original app data retained.',
    })
    await publish(listApps(db))
  }
  const platformCheckpoint = async () => {
    progress('Encrypting and saving a platform recovery checkpoint.')
    const directory = await mkdtemp(join(tmpdir(), 'servitas-checkpoint-'))
    try {
      const target = join(directory, 'platform')
      await mkdir(target, { mode: 0o700 })
      const disk = await statfs(dataDir)
      if (disk.bavail * disk.bsize < 256 * 1024 * 1024)
        throw new Error('At least 256 MB of free platform storage is required.')
      await copyDatabase(db, join(target, 'servitas.sqlite'))
      await copyFile(join(dataDir, 'encryption-key'), join(target, 'encryption-key'))
      await writeFile(
        join(target, 'installation.json'),
        JSON.stringify(
          {
            version: 1,
            instance,
            platformOrigin: process.env.SERVITAS_ORIGIN,
            appsOrigin: process.env.SERVITAS_APPS_ORIGIN,
            address: process.env.SERVITAS_ADDRESS,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      )
      const output = await run(
        'platform-checkpoint',
        [
          'backup',
          '--host',
          'servitas',
          '--tag',
          'servitas-pending',
          '--tag',
          `job:${claim.job.id}`,
          '/platform',
        ],
        { platformDir: directory },
      )
      const id = await commitSnapshot('platform', snapshotFromOutput(output))
      progress(`Platform recovery snapshot: ${id}.`)
      return id
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  try {
    if (operation.phase === 'applied') {
      if (previous) await publish(listApps(db))
    } else if (claim.job.kind === 'backup.check') {
      progress('Opening the encrypted backup repository.')
      try {
        await run('repository-config', ['cat', 'config'])
      } catch (error) {
        if (!(error instanceof ResticError) || error.exitCode !== 10) throw error
        progress('Creating the encrypted repository in the selected bucket.')
        await run('repository-init', ['init'])
      }
      progress('Checking repository metadata and loading saved app backups.')
      await run('repository-unlock', ['unlock'])
      await run('repository-check', ['check'])
      const snapshots = JSON.parse(
        await run('repository-snapshots', ['snapshots', '--tag', 'servitas-app']),
      ) as { id: string; tags?: string[] }[]
      if (!Array.isArray(snapshots) || snapshots.length > 500)
        throw new Error('This preview supports up to 500 app snapshots per destination.')
      const saved = new Set(listAppBackups(db, key).map((item) => item.snapshotId))
      for (const snapshot of snapshots) {
        if (!/^[a-f0-9]{64}$/.test(snapshot.id)) throw new Error('Invalid snapshot identifier.')
        if (saved.has(snapshot.id)) continue
        const output = await run(`metadata-${snapshot.id}`, [
          'dump',
          snapshot.id,
          '/metadata/app.json',
        ])
        const metadata = backupMetadataSchema.parse(JSON.parse(output))
        recordAppBackup(db, claim, snapshot.id, metadata, key)
      }
      markDestinationChecked(
        db,
        claim,
        'Repository checked. Saved app backups are available.',
        true,
      )
    } else if (claim.job.kind === 'platform.backup') {
      const id = await platformCheckpoint()
      save({ snapshotId: id, phase: 'applied' })
    } else if (claim.job.kind === 'app.backup') {
      if (!previous) throw new Error('App backup context is missing.')
      const metadata: BackupMetadata = {
        version: 1,
        appId: previous.id,
        backupId: claim.job.id,
        createdAt: claim.job.createdAt,
        configuration: {
          manifest: previous.manifest,
          environment: appEnvironment(db, previous.id, key),
        },
        imageId: previous.imageId!,
        imageReference: null,
        commit: previous.commit,
      }
      const info = await docker.getImage(previous.imageId!).inspect()
      metadata.imageReference = info.RepoDigests?.[0] || null
      if (!operation.snapshotId) {
        progress('Withdrawing traffic and stopping the app for a consistent backup.')
        save({ phase: 'stopping' })
        updateApp(db, claim, { status: 'stopped', message: 'App paused for backup.' })
        await publish(listApps(db))
        for (const container of await appContainers(docker, instance, previous.id)) {
          checkLease()
          if ((await container.inspect()).State.Running) {
            await container.stop({ t: 30 })
          }
          // Also check an already-stopped container when a worker resumes after interruption.
          const stopped = await container.inspect()
          if (container.id === previous.containerId && stopped.State.ExitCode === 137)
            throw new Error(
              'The app did not stop cleanly. Configure graceful shutdown before backing it up.',
            )
        }
        const mounts = await backupVolumeMounts(
          docker,
          instance,
          previous.id,
          previous.manifest.volumes.map((volume) => ({
            name: volume.name,
            source: appVolumeName(instance, previous, volume.name),
          })),
          true,
        )
        progress('Encrypting and uploading app settings and persistent data.')
        save({ phase: 'uploading' })
        const output = await run(
          'app-backup',
          [
            'backup',
            '--host',
            'servitas',
            '--tag',
            'servitas-pending',
            '--tag',
            `app:${previous.id}`,
            '--tag',
            `job:${claim.job.id}`,
            '/metadata',
            ...(mounts.length ? ['/volumes'] : []),
          ],
          { mounts, metadata: JSON.stringify(metadata) },
        )
        save({ snapshotId: snapshotFromOutput(output), phase: 'saved' })
      }
      save({ snapshotId: await commitSnapshot('app', operation.snapshotId!) })
      recordAppBackup(db, claim, operation.snapshotId!, metadata, key)
      await resumePrevious()
      await platformCheckpoint()
      save({ phase: 'applied' })
    } else if (claim.job.kind === 'app.restore') {
      if (!previous || !operation.backupId) throw new Error('Restore context is missing.')
      const metadata = backupMetadata(db, operation.backupId, key)
      Object.assign(secrets, metadata.configuration.environment)
      const savedBackup = listAppBackups(db, key, previous.id).find(
        (item) => item.id === operation.backupId,
      )!
      let candidate: HostedApp = {
        ...previous,
        manifest: metadata.configuration.manifest,
        environmentNames: Object.keys(metadata.configuration.environment),
        volumeSet: claim.job.id,
        containerId: operation.containerId,
        containerName: operation.containerName || resourceName(instance, claim.job.id),
        imageId: operation.imageId || metadata.imageId,
        commit: metadata.commit,
        status: 'running',
        desiredState: 'running',
      }
      progress('Restoring and verifying the snapshot into separate storage.')
      await ensureVolumes(docker, instance, candidate)
      if (!['restored', 'starting'].includes(operation.phase)) {
        save({ phase: 'restoring' })
        const mounts = await backupVolumeMounts(
          docker,
          instance,
          previous.id,
          candidate.manifest.volumes.map((volume) => ({
            name: volume.name,
            source: appVolumeName(instance, candidate, volume.name),
          })),
          false,
        )
        if (mounts.length)
          await run(
            'restore-volumes',
            ['restore', `${savedBackup.snapshotId}:/volumes`, '--target', '/volumes', '--verify'],
            { mounts },
          )
        save({ phase: 'restored' })
      }
      try {
        await docker.getImage(candidate.imageId!).inspect()
      } catch (error) {
        if (!isNotFound(error)) throw error
        if (candidate.manifest.source.type === 'image' && !metadata.imageReference)
          throw new Error('The saved image has no registry digest and is unavailable on this host.')
        const sourceApp = {
          ...candidate,
          imageId: null,
          manifest: {
            ...candidate.manifest,
            source:
              candidate.manifest.source.type === 'image'
                ? { type: 'image' as const, image: metadata.imageReference! }
                : candidate.manifest.source,
          },
        }
        candidate = {
          ...candidate,
          ...(await resolveImage(docker, instance, sourceApp, progress, () => checkLease())),
        }
      }
      save({ imageId: candidate.imageId, containerName: candidate.containerName })
      await connectAppNetwork(docker, instance, candidate)
      updateApp(db, claim, { status: 'stopped', message: 'Checking the restored app.' })
      await publish(listApps(db))
      for (const container of await appContainers(docker, instance, previous.id)) {
        checkLease()
        if (container.id !== operation.containerId && (await container.inspect()).State.Running)
          await container.stop({ t: 30 })
      }
      let existing = await ownedContainer(docker, instance, candidate)
      if (!existing) {
        const container = await createAppContainer(
          docker,
          instance,
          candidate,
          metadata.configuration.environment,
        )
        existing = { container, info: await container.inspect() }
      }
      candidate.containerId = existing.container.id
      save({ containerId: candidate.containerId, phase: 'starting' })
      checkLease()
      if (!existing.info.State.Running) await existing.container.start()
      await waitForHealthy(existing.container, instance, candidate, checkLease, progress)
      checkLease()
      // Persist activation first: retry publishes this state if gateway reload is interrupted.
      activateRestoredApp(db, claim, candidate, metadata, key)
      operation = getBackupOperation(db, claim.job.id)!
      await publish(listApps(db))
    }
    checkLease()
    await cleanupBackupHelpers(docker, instance, claim.job.id)
    finishJob(
      db,
      claim,
      'succeeded',
      claim.job.kind === 'app.restore'
        ? 'Backup restored. Previous volumes are retained.'
        : claim.job.kind === 'app.backup'
          ? 'App backup and platform recovery checkpoint saved.'
          : claim.job.kind === 'platform.backup'
            ? 'Encrypted platform recovery checkpoint saved.'
            : 'Backup destination checked and saved backups loaded.',
    )
  } catch (error) {
    if (!ownsLease(db, claim)) return
    let message = redact(
      error instanceof Error ? error.message : 'Backup operation failed.',
      secrets,
    ).slice(0, 2000)
    try {
      await cleanupBackupHelpers(docker, instance, claim.job.id)
      if (
        claim.job.kind === 'app.restore' &&
        operation.phase !== 'applied' &&
        operation.containerId
      ) {
        const candidate = await ownedContainer(docker, instance, {
          ...previous!,
          containerId: operation.containerId,
        })
        if (candidate?.info.State.Running) await candidate.container.stop({ t: 5 })
      }
      if (previous && operation.phase !== 'applied') await resumePrevious()
    } catch {
      message += ' The app may remain stopped. Check its status before retrying.'
      if (previous) updateApp(db, claim, { status: 'failed', message })
    }
    if (claim.job.kind === 'backup.check') markDestinationChecked(db, claim, message, false)
    finishJob(db, claim, 'failed', message)
    try {
      await publish(listApps(db))
    } catch {
      /* Reconciliation republishes the saved state. */
    }
  } finally {
    clearInterval(timer)
  }
}
