import Docker from 'dockerode'
import { createHash } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import { pack } from 'tar-stream'
import type { HostedApp } from '@servitas/contracts'

export const INSTANCE_LABEL = 'dev.servitas.instance'
export const APP_LABEL = 'dev.servitas.app'
export const ROLE_LABEL = 'dev.servitas.role'
export function runtime(socketPath: string) {
  return new Docker({ socketPath, timeout: 300_000 })
}
export function resourceName(instance: string, id: string) {
  // Docker DNS labels must stay under 64 characters, even for long Compose project names.
  const prefix = createHash('sha256').update(instance).digest('hex').slice(0, 12)
  return `servitas-${prefix}-${id}`
}
export function isNotFound(error: unknown) {
  return (error as { statusCode?: number }).statusCode === 404
}

export async function serviceContainer(docker: Docker, instance: string, role: 'worker' | 'caddy') {
  const containers = await docker.listContainers({
    filters: { label: [`${INSTANCE_LABEL}=${instance}`, `${ROLE_LABEL}=${role}`] },
  })
  if (containers.length !== 1)
    throw new Error(`The ${role} service is unavailable. Check the platform installation.`)
  return docker.getContainer(containers[0]!.Id)
}
export async function ownedContainer(docker: Docker, instance: string, app: HostedApp) {
  const container = docker.getContainer(
    app.containerId || app.containerName || resourceName(instance, app.id),
  )
  try {
    const info = await container.inspect({ abortSignal: AbortSignal.timeout(10_000) })
    if (
      info.Config.Labels?.[INSTANCE_LABEL] !== instance ||
      info.Config.Labels?.[APP_LABEL] !== app.id
    )
      throw new Error('Container ownership does not match this app.')
    return { container, info }
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}
export async function connectAppNetwork(docker: Docker, instance: string, app: HostedApp) {
  const name = resourceName(instance, app.id)
  const network = docker.getNetwork(name)
  try {
    const info = await network.inspect()
    if (info.Labels?.[INSTANCE_LABEL] !== instance || info.Labels?.[APP_LABEL] !== app.id)
      throw new Error('Network ownership does not match this app.')
  } catch (error) {
    if (!isNotFound(error)) throw error
    await docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      Labels: { [INSTANCE_LABEL]: instance, [APP_LABEL]: app.id },
    })
  }
  for (const role of ['worker', 'caddy'] as const) {
    const container = await serviceContainer(docker, instance, role)
    const info = await container.inspect({ abortSignal: AbortSignal.timeout(10_000) })
    if (!info.NetworkSettings.Networks[name]) await network.connect({ Container: container.id })
  }
  return name
}
export function appVolumeName(
  instance: string,
  app: Pick<HostedApp, 'id' | 'volumeSet'>,
  name: string,
) {
  return `${resourceName(instance, app.id)}${app.volumeSet ? `-${app.volumeSet}` : ''}-${name}`
}
export async function ensureVolumes(docker: Docker, instance: string, app: HostedApp) {
  const mounts: Docker.MountSettings[] = []
  for (const volume of app.manifest.volumes) {
    const name = appVolumeName(instance, app, volume.name)
    try {
      const info = await docker.getVolume(name).inspect()
      if (info.Labels?.[INSTANCE_LABEL] !== instance || info.Labels?.[APP_LABEL] !== app.id)
        throw new Error('Volume ownership does not match this app.')
    } catch (error) {
      if (!isNotFound(error)) throw error
      await docker.createVolume({
        Name: name,
        Labels: { [INSTANCE_LABEL]: instance, [APP_LABEL]: app.id },
      })
    }
    mounts.push({ Type: 'volume', Source: name, Target: volume.mountPath, ReadOnly: false })
  }
  return mounts
}
export async function execute(docker: Docker, container: Docker.Container, command: string[]) {
  const exec = await container.exec({ Cmd: command, AttachStdout: true, AttachStderr: true })
  const stream = await exec.start({ Detach: false, Tty: false })
  const output = new PassThrough()
  let text = ''
  output.on('data', (chunk) => {
    text = (text + chunk).slice(-65536)
  })
  docker.modem.demuxStream(stream, output, output)
  await new Promise<void>((resolve, reject) => {
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  const result = await exec.inspect()
  if (result.ExitCode !== 0) throw new Error(`Routing configuration failed: ${text.slice(-2000)}`)
}
export async function writeContainerFile(
  container: Docker.Container,
  path: string,
  contents: string,
) {
  const archive = pack()
  archive.entry({ name: path, mode: 0o600 }, contents)
  archive.finalize()
  await container.putArchive(Readable.from(archive), { path: '/config' })
}
export async function containerLogs(docker: Docker, container: Docker.Container) {
  const buffer = await container.logs({
    stdout: true,
    stderr: true,
    tail: 200,
    timestamps: true,
    abortSignal: AbortSignal.timeout(10_000),
  })
  const source = new PassThrough()
  const output = new PassThrough()
  let text = ''
  output.on('data', (chunk) => {
    text = (text + chunk.toString()).slice(-65536)
  })
  docker.modem.demuxStream(source, output, output)
  source.end(buffer)
  await new Promise<void>((resolve) => source.on('end', resolve))
  return text
}

export async function appContainers(docker: Docker, instance: string, appId: string) {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${INSTANCE_LABEL}=${instance}`, `${APP_LABEL}=${appId}`] },
  })
  return containers.map((info) => docker.getContainer(info.Id))
}
