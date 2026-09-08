import type Docker from 'dockerode'
import type { HostedApp } from '@servitas/contracts'
import { setTimeout } from 'node:timers/promises'
import { APP_LABEL, INSTANCE_LABEL, ensureVolumes, resourceName } from './runtime'

export async function createAppContainer(
  docker: Docker,
  instance: string,
  app: HostedApp,
  environment: Record<string, string>,
) {
  const mounts = await ensureVolumes(docker, instance, app)
  return await docker.createContainer({
    name: app.containerName || resourceName(instance, app.id),
    Image: app.imageId!,
    Env: Object.entries(environment).map(([name, value]) => `${name}=${value}`),
    Labels: { [INSTANCE_LABEL]: instance, [APP_LABEL]: app.id },
    HostConfig: {
      Init: true,
      NetworkMode: resourceName(instance, app.id),
      Mounts: mounts,
      Memory: app.manifest.resources.memoryMb * 1024 * 1024,
      NanoCpus: Math.ceil(app.manifest.resources.cpu * 1e9),
      PidsLimit: 256,
      SecurityOpt: ['no-new-privileges:true'],
      CapDrop: ['NET_RAW', 'MKNOD'],
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } },
    },
  })
}

export async function waitForHealthy(
  container: Docker.Container,
  instance: string,
  app: HostedApp,
  checkLease: () => void,
  progress?: (message: string) => void,
) {
  // Elapsed-time deadlines must survive host clock corrections and VM sleep/resume.
  const timeout = AbortSignal.timeout(60_000)
  const started = performance.now()
  const deadline = started + 60_000
  let nextReport = started + 15_000
  let healthy = false
  while (!timeout.aborted && performance.now() < deadline) {
    if (performance.now() >= nextReport) {
      progress?.(
        `Waiting for the HTTP health check (${Math.floor((performance.now() - started) / 1000)} seconds).`,
      )
      nextReport += 15_000
    }
    checkLease()
    let info: Docker.ContainerInspectInfo
    try {
      info = await container.inspect({ abortSignal: timeout })
    } catch (error) {
      if (timeout.aborted) break
      throw error
    }
    if (!info.State.Running)
      throw new Error(
        'The app exited before becoming healthy. Review its runtime logs, then retry deployment.',
      )
    const address = info.NetworkSettings.Networks[resourceName(instance, app.id)]?.IPAddress
    if (address) {
      try {
        const response = await fetch(
          `http://${address}:${app.manifest.port}${app.manifest.healthCheck}`,
          { redirect: 'manual', signal: AbortSignal.any([timeout, AbortSignal.timeout(3000)]) },
        )
        await response.body?.cancel()
        if (response.status >= 200 && response.status < 400) {
          healthy = true
          break
        }
      } catch {
        /* App may still be starting. */
      }
    }
    await setTimeout(1000)
  }
  if (!healthy)
    throw new Error(
      'The HTTP health check did not pass within 60 seconds. Review the app logs, port, and health-check path.',
    )
}
