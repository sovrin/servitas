import { realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { withGitRepository } from './git'
import { pack } from 'tar-fs'
import type Docker from 'dockerode'
import type { HostedApp } from '@servitas/contracts'
import { APP_LABEL, INSTANCE_LABEL, resourceName } from './runtime'

export async function resolveImage(
  docker: Docker,
  instance: string,
  app: HostedApp,
  progress: (message: string) => void,
  recordCommit: (commit: string) => void,
) {
  if (app.imageId) return { imageId: app.imageId, commit: app.commit }
  if (app.manifest.source.type === 'image') {
    progress(`Pulling ${app.manifest.source.image}.`)
    const stream = await docker.pull(app.manifest.source.image)
    await followBuild(docker, stream, progress)
    return {
      imageId: (await docker.getImage(app.manifest.source.image).inspect()).Id,
      commit: null,
    }
  }
  const source = app.manifest.source
  progress('Fetching the Git revision.')
  return withGitRepository(source, app.commit, recordCommit, async ({ dir, commit, git }) => {
    await git('checkout', '--detach', commit)
    const dockerfile = await realpath(resolve(dir, source.dockerfile))
    if (!dockerfile.startsWith((await realpath(dir)) + sep))
      throw new Error('Dockerfile must be inside the repository.')
    progress(`Building commit ${commit.slice(0, 12)}.`)
    const tag = `${resourceName(instance, app.id)}:initial`
    const archive = pack(dir, { ignore: (name) => name.split(sep).includes('.git') })
    const stream = await docker.buildImage(archive, {
      t: tag,
      labels: { [INSTANCE_LABEL]: instance, [APP_LABEL]: app.id },
      dockerfile: source.dockerfile,
      rm: true,
      memory: app.manifest.resources.memoryMb * 1024 * 1024,
      cpuperiod: 100000,
      cpuquota: Math.ceil(app.manifest.resources.cpu * 100000),
    })
    await followBuild(docker, stream, progress)
    return { imageId: (await docker.getImage(tag).inspect()).Id, commit }
  })
}

function followBuild(
  docker: Docker,
  stream: NodeJS.ReadableStream,
  progress: (message: string) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ;(stream as { destroy?: () => void }).destroy?.()
      reject(new Error('Build or image pull exceeded five minutes.'))
    }, 300_000)
    let count = 0
    docker.modem.followProgress(
      stream,
      (error) => {
        clearTimeout(timer)
        error ? reject(error) : resolve()
      },
      (output) => {
        // Bound database writes and ignore per-layer byte counters.
        const message =
          typeof output.stream === 'string'
            ? output.stream.trim()
            : !output.progressDetail?.current && output.status
        if (message && count++ < 250) {
          try {
            progress(String(message).slice(0, 2000))
          } catch (error) {
            clearTimeout(timer)
            ;(stream as { destroy?: () => void }).destroy?.()
            reject(error)
          }
        }
      },
    )
  })
}
