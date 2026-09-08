import { createHash } from 'node:crypto'
import type Docker from 'dockerode'
import type { HostedApp } from '@servitas/contracts'
import { appOrigin } from '@servitas/core'
import { execute, resourceName, serviceContainer, writeContainerFile } from './runtime'

export interface RoutingConfig {
  instance: string
  appsOrigin: string
  address: string
  webUpstream: string
}
const quote = (value: string) => JSON.stringify(value)
export function renderCaddyfile(apps: HostedApp[], config: RoutingConfig) {
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(config.webUpstream))
    throw new Error('Invalid platform upstream.')
  if (!/^(?:https?:\/\/)?[a-zA-Z0-9.:[\]-]+$/.test(config.address))
    throw new Error('Invalid platform address.')
  const gateway = quote(config.webUpstream)
  const sites = apps
    .filter((app) => app.status !== 'removed')
    .map((app) => {
      const url = new URL(appOrigin(app, config.appsOrigin))
      const address = `${url.protocol}//${url.hostname}`
      const ready = app.status === 'running' && app.desiredState === 'running'
      return `${quote(address)} {
      header Referrer-Policy no-referrer
      handle /_servitas/callback {
        rewrite * /api/gateway/${app.id}/callback
        reverse_proxy ${gateway}
      }
      handle {
        ${
          app.manifest.access === 'private'
            ? `forward_auth ${gateway} {
          uri /api/gateway/${app.id}/authorize
        }`
            : ''
        }
        ${
          ready
            ? `reverse_proxy ${app.containerName || resourceName(config.instance, app.id)}:${app.manifest.port} {
          header_up Cookie "(^|;[ ]*)servitas_app_session=[^;]*(;[ ]*|$)" "$1"
          header_up Cookie "(^|;[ ]*)servitas_session=[^;]*(;[ ]*|$)" "$1"
        }`
            : 'respond "This app is not running. Open Servitas to manage it." 503'
        }
      }
    }`
    })
    .join('\n')
  return `{
    admin unix//run/servitas-admin.sock
  }
  ${quote(config.address)} {
    request_body {
      max_size 64KB
    }
    reverse_proxy ${gateway}
  }
  ${sites}\n`
}

// Cache only successful loads. Container replacement invalidates the cache by ID.
export function routingPublisher(docker: Docker, config: RoutingConfig) {
  let applied = ''
  return async (apps: HostedApp[]) => {
    const caddy = await serviceContainer(docker, config.instance, 'caddy')
    const content = renderCaddyfile(apps, config)
    const digest = caddy.id + createHash('sha256').update(content).digest('hex')
    if (digest === applied) return
    await writeContainerFile(caddy, 'Servitas.Caddyfile', content)
    await execute(docker, caddy, [
      'caddy',
      'reload',
      '--config',
      '/config/Servitas.Caddyfile',
      '--adapter',
      'caddyfile',
      '--address',
      'unix//run/servitas-admin.sock',
    ])
    applied = digest
  }
}
