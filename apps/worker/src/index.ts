import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { claimJob, heartbeat, openDatabase } from '@servitas/core'
import { runPlatformCheck } from './check'

const dataDir = process.env.SERVITAS_DATA_DIR
if (!dataDir) throw new Error('SERVITAS_DATA_DIR must be set for the worker.')
const db = openDatabase(resolve(dataDir))
const socketPath = process.env.SERVITAS_DOCKER_SOCKET || '/var/run/docker.sock'
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
    const claim = claimJob(db)
    if (claim) await runPlatformCheck(db, claim, dataDir, socketPath)
    else await setTimeout(1000)
  }
} finally {
  clearInterval(timer)
  db.close()
}
