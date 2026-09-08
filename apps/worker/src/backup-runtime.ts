import { createHash } from 'node:crypto'
import { Readable, PassThrough } from 'node:stream'
import { setTimeout } from 'node:timers/promises'
import { pack } from 'tar-stream'
import { pack as packFiles } from 'tar-fs'
import type Docker from 'dockerode'
import { APP_LABEL, INSTANCE_LABEL, ROLE_LABEL, isNotFound } from './runtime'
import type { BackupDestination } from '@servitas/contracts/backups'

export const RESTIC_IMAGE = 'restic/restic:0.19.1'
export const BACKUP_JOB_LABEL = 'dev.servitas.backup-job'
export class ResticError extends Error {
  constructor(
    public exitCode: number,
    output: string,
  ) {
    let message = output.trim() || 'Backup command failed.'
    for (const line of output.trim().split('\n').reverse()) {
      try {
        const detail = JSON.parse(line)
        if (typeof detail.message === 'string') {
          message = detail.message.replace(/^Fatal: /, '')
          break
        }
      } catch {
        // Restic also reports plain-text errors, for example connection failures.
      }
    }
    if (exitCode === 12)
      message =
        'The recovery password could not unlock this repository. Update the destination credentials with its original password, then check the destination again.'
    if (exitCode === 3)
      message =
        'Some app files could not be read. This incomplete backup cannot be restored. Check the app storage and try another backup.'
    super(message)
  }
}
export async function ensureResticImage(docker: Docker) {
  try {
    await docker.getImage(RESTIC_IMAGE).inspect()
  } catch (error) {
    if (!isNotFound(error)) throw error
    const stream = await docker.pull(RESTIC_IMAGE)
    await new Promise<void>((resolve, reject) =>
      docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve())),
    )
  }
}
export function resticEnvironment(
  destination: BackupDestination & { accessKey: string; secretKey: string; password: string },
) {
  return {
    RESTIC_REPOSITORY: `s3:${destination.endpoint.replace(/\/$/, '')}/${destination.bucket}/${destination.prefix}`,
    RESTIC_PASSWORD: destination.password,
    AWS_ACCESS_KEY_ID: destination.accessKey,
    AWS_SECRET_ACCESS_KEY: destination.secretKey,
    AWS_DEFAULT_REGION: destination.region,
  }
}
export async function runRestic(
  docker: Docker,
  instance: string,
  jobId: string,
  step: string,
  destination: Parameters<typeof resticEnvironment>[0],
  command: string[],
  checkLease: () => void,
  options: { mounts?: Docker.MountSettings[]; metadata?: string; platformDir?: string } = {},
) {
  checkLease()
  const name = `servitas-backup-${createHash('sha256').update(`${instance}:${jobId}:${step}`).digest('hex').slice(0, 40)}`
  let container = docker.getContainer(name)
  let info: Docker.ContainerInspectInfo
  try {
    info = await container.inspect()
  } catch (error) {
    if (!isNotFound(error)) throw error
    await ensureResticImage(docker)
    checkLease()
    container = await docker.createContainer({
      name,
      Image: RESTIC_IMAGE,
      Cmd: ['--no-cache', '--json', '--retry-lock', '30s', ...command],
      Env: Object.entries(resticEnvironment(destination)).map(([key, value]) => `${key}=${value}`),
      Labels: { [INSTANCE_LABEL]: instance, [ROLE_LABEL]: 'backup', [BACKUP_JOB_LABEL]: jobId },
      HostConfig: {
        Mounts: options.mounts || [],
        NetworkMode: 'bridge',
        ExtraHosts: ['host.docker.internal:host-gateway'],
        Memory: 512 * 1024 * 1024,
        NanoCpus: 1e9,
        PidsLimit: 128,
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['ALL'],
        CapAdd: ['DAC_OVERRIDE', 'CHOWN', 'FOWNER'],
        RestartPolicy: { Name: 'no' },
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '1' } },
      },
    })
    info = await container.inspect()
  }
  if (
    info.Config.Labels?.[INSTANCE_LABEL] !== instance ||
    info.Config.Labels?.[BACKUP_JOB_LABEL] !== jobId
  )
    throw new Error('Backup helper ownership does not match.')
  if (info.State.Status === 'created') {
    if (options.metadata) {
      const archive = pack()
      archive.entry({ name: 'metadata/app.json', mode: 0o600 }, options.metadata)
      archive.finalize()
      await container.putArchive(Readable.from(archive), { path: '/' })
    }
    if (options.platformDir)
      await container.putArchive(packFiles(options.platformDir), { path: '/' })
    checkLease()
    await container.start()
  }
  // The helper survives a worker restart. A new lease adopts its result by deterministic name.
  for (;;) {
    checkLease()
    info = await container.inspect({ abortSignal: AbortSignal.timeout(10_000) })
    if (!info.State.Running) break
    if (Date.now() - Date.parse(info.State.StartedAt) > 60 * 60 * 1000) {
      await container.stop({ t: 5 })
      throw new Error(
        'The backup command exceeded one hour. Retry after checking storage and connectivity.',
      )
    }
    await setTimeout(1000)
  }
  const source = new PassThrough()
  const output = new PassThrough()
  let result = ''
  output.on('data', (chunk) => {
    result += chunk.toString()
    if (result.length > 4 * 1024 * 1024) result = result.slice(-4 * 1024 * 1024)
  })
  docker.modem.demuxStream(source, output, output)
  source.end(await container.logs({ stdout: true, stderr: true }))
  await new Promise<void>((resolve) => source.on('end', resolve))
  if (info.State.ExitCode !== 0)
    throw new ResticError(info.State.ExitCode, result.slice(-2000) || 'Backup command failed.')
  return result
}
export async function cleanupBackupHelpers(docker: Docker, instance: string, jobId: string) {
  for (const info of await docker.listContainers({
    all: true,
    filters: {
      label: [
        `${INSTANCE_LABEL}=${instance}`,
        `${ROLE_LABEL}=backup`,
        `${BACKUP_JOB_LABEL}=${jobId}`,
      ],
    },
  })) {
    const container = docker.getContainer(info.Id)
    if (info.State === 'running') await container.stop({ t: 5 })
    await container.remove({ v: false })
  }
}
export async function backupVolumeMounts(
  docker: Docker,
  instance: string,
  appId: string,
  volumes: { name: string; source: string }[],
  readOnly: boolean,
) {
  const mounts: Docker.MountSettings[] = []
  for (const volume of volumes) {
    const info = await docker.getVolume(volume.source).inspect()
    if (info.Labels?.[INSTANCE_LABEL] !== instance || info.Labels?.[APP_LABEL] !== appId)
      throw new Error('Backup volume ownership does not match this app.')
    mounts.push({
      Type: 'volume',
      Source: volume.source,
      Target: `/volumes/${volume.name}`,
      ReadOnly: readOnly,
    })
  }
  return mounts
}
