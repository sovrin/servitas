import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { claimJob, heartbeat, openDatabase, encryptionKey } from '@servitas/core'
import { runBackupJob, reapBackupHelpers } from './backups'
import { enqueueScheduledBackups } from '@servitas/core'
import { runRepositoryInspection } from './repositories'
import { runPlatformCheck } from './check'
import { runtime } from './runtime'
import { routingPublisher } from './routing'
import { runUpdateJob } from './updates'
import { observeApps, runAppJob } from './apps'

const dataDir = process.env.SERVITAS_DATA_DIR
if (!dataDir) throw new Error('SERVITAS_DATA_DIR must be set for the worker.')
const db = openDatabase(resolve(dataDir))
const socketPath = process.env.SERVITAS_DOCKER_SOCKET || '/var/run/docker.sock'
const instance = process.env.SERVITAS_INSTANCE_ID || 'servitas'
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(instance)) throw new Error('Invalid platform instance ID.')
const docker = runtime(socketPath)
const key = encryptionKey(dataDir)
const appsEnabled = !!process.env.SERVITAS_APPS_ORIGIN
const publish = routingPublisher(docker, {
  instance,
  appsOrigin: process.env.SERVITAS_APPS_ORIGIN || 'http://apps.localhost:8080',
  address: process.env.SERVITAS_ADDRESS || ':80',
  webUpstream: process.env.SERVITAS_WEB_UPSTREAM || 'web:3000',
})
let lastObservation = 0
let stopping = false
process.on('SIGTERM', () => {
  stopping = true
})
process.on('SIGINT', () => {
  stopping = true
})
heartbeat(db)
const timer = setInterval(() => heartbeat(db), 5000)
console.info('Servitas worker ready.')
try {
  while (!stopping) {
    if (appsEnabled) {
      try {
        await reapBackupHelpers(db, docker, instance)
      } catch {
        await setTimeout(1000)
        continue
      }
      enqueueScheduledBackups(db)
    }
    const claim = claimJob(db)
    if (claim?.job.kind === 'platform.check') await runPlatformCheck(db, claim, dataDir, socketPath)
    else if (
      claim &&
      ['backup.check', 'platform.backup', 'app.backup', 'app.restore'].includes(claim.job.kind)
    )
      await runBackupJob(db, claim, docker, instance, key, dataDir, publish)
    else if (claim?.job.kind === 'repository.inspect') await runRepositoryInspection(db, claim)
    else if (claim?.job.kind === 'app.update')
      await runUpdateJob(db, claim, docker, instance, key, publish)
    else if (claim) await runAppJob(db, claim, docker, instance, key, publish)
    else await setTimeout(1000)
    if (appsEnabled && Date.now() - lastObservation > 10_000) {
      lastObservation = Date.now()
      try {
        await observeApps(db, docker, instance, key, publish)
      } catch {
        console.warn('App observation is waiting for Docker and Caddy.')
      }
    }
  }
} finally {
  clearInterval(timer)
  db.close()
}
